import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyAccountStore } from '../src/accounts-store.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WorkBuddyQuotaStore, quotaAccountOf } from '../src/quota-state.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import { CN_VARIANT } from '../src/variants.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  upstreamBodies: string[]
  upstreamResponse: () => WorkBuddyChatResult
  quota: WorkBuddyQuotaStore
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startShim(
  upstreamResponse: () => WorkBuddyChatResult,
  options: { withQuota?: boolean, accounts?: WorkBuddyAccountStore } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  // Only the quota tests opt in: the rest assert the shipped wiring's behaviour
  // and must not acquire a store the production host passes only when present.
  const quota = new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') })
  const harness: Harness = {
    shim: undefined as unknown as WorkBuddyShim,
    store,
    upstreamBodies: [],
    upstreamResponse,
    quota,
  }
  harness.shim = createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: {
      async chatStream(_credential, bodyJson): Promise<WorkBuddyChatResult> {
        harness.upstreamBodies.push(bodyJson)
        return harness.upstreamResponse()
      },
    },
    ...options.withQuota !== true ? {} : { quota },
    ...options.accounts === undefined ? {} : { accounts: options.accounts },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

/** POST one chat completion and return the raw error body, if any. */
async function postChat(harness: Harness): Promise<{ status: number, body: string }> {
  const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: response.status, body: await response.text() }
}

/**
 * A slot store pointed at a throwaway harness home.
 *
 * `DSH_HOME` is stubbed rather than left ambient: these tests run inside a live
 * DSH session where the variable names the user's own `.dsh`, so an unstubbed
 * store would archive fake accounts straight into the real harness home.
 */
async function tempAccountStore(): Promise<WorkBuddyAccountStore> {
  const home = await mkdtemp(join(tmpdir(), 'wb-shim-home-'))
  vi.stubEnv('DSH_HOME', home)
  CLEANUP.push(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  return new WorkBuddyAccountStore({ variant: CN_VARIANT })
}

describe('WorkBuddy shim', () => {
  it('lists the catalog on /v1/models', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    const ids = body.data.map(model => model.id)
    expect(ids).toContain('hy3')
    expect(ids).toContain('deepseek-v4-pro')
    // The fallback roster tracks the live `cli` agent's 16 models.
    expect(ids.length).toBe(19)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('glm-5.3')
  })

  it('streams a successful chat completion and normalizes the body', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'hy3',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'auto' },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('你好')
    expect(text).toContain('[DONE]')
    expect(harness.upstreamBodies.length).toBe(1)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['stream']).toBe(true)
    expect(forwarded['tool_choice']).toBe('auto')
  })

  it('forwards the reasoning_effort a model picker selection sends', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['reasoning_effort']).toBe('xhigh')
    expect(forwarded['stream']).toBe(true)
  })

  it('maps an upstream credit failure onto HTTP 402', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: '积分不足',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string, message: string } }
    expect(body.error.type).toBe('hard_credit')
    expect(body.error.message).toContain('积分不足')
  })

  it('answers unknown routes with 404', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/nothing`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(404)
  })

  it('binds loopback only', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    expect(harness.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // A rebinding page resolves evil.com to 127.0.0.1; the browser then sends
    // Host: evil.com:<port>. fetch() forbids overriding Host, so use raw http.
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('accepts Host with a loopback name plus port', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a browser Origin from a non-loopback site', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('origin_not_allowed')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('accepts a loopback browser Origin', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a chat POST with a non-JSON Content-Type (simple-request CSRF)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(415)
    expect(res.body).toContain('unsupported_media_type')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request without a bearer (local process without the secret)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // Everything else about this request is legitimate: loopback Host, no
    // Origin (a local process, not a browser), JSON body. Only the bearer is
    // missing — this is the shape a hostile local process would send.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.body).toContain('unauthorized')
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request with a wrong bearer', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(harness.upstreamBodies).toHaveLength(0)
  })
})

describe('error text policy against the host AUTH heuristic (PR #58)', () => {
  /**
   * The host adapter (dsh-llm-pi-ai's classifyPiAiError) treats any error
   * text matching /\b(?:401|403)\b/ as an auth failure and the UI replaces
   * the message with an invalid-API-key banner. This pin mirrors that regex
   * so the texts this shim emits stay compatible with it: business errors
   * must not match, session failures must. If the host ever changes its
   * heuristic, update this mirror with it.
   */
  const HOST_AUTH_HEURISTIC = /\b(?:401|403)\b/u

  async function shimErrorBody(upstream: () => WorkBuddyChatResult): Promise<string> {
    const harness = await startShim(upstream)
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.ok).toBe(false)
    return await response.text()
  }

  it('shows the display message of a review rejection without a bare 403', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: JSON.stringify({
        code: 11140,
        msg: 'request illegal',
        displayMsg: { zh: '内容未通过安全审核，请调整后重试。', en: 'The content did not pass the safety review.' },
      }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: 内容未通过安全审核，请调整后重试。 [msg: request illegal]')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(false)
  })

  it('falls back to msg and keeps the status note for non-401/403 statuses', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 400,
      kind: 'client',
      message: JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client (http 400): Illegal API invocation from an unapproved channel')
  })

  /**
   * Issue #139 class: the gateway shows one localized line for several
   * unrelated 400 causes, so the text has to carry `msg` to be actionable.
   */
  it('separates the causes that share the interception display line', async () => {
    const rejectedWith = async (msg: string): Promise<string> => {
      const text = await shimErrorBody(() => ({
        ok: false,
        status: 400,
        kind: 'client',
        message: JSON.stringify({ code: 11128, msg, displayMsg: { zh: '请求被拦截，请重新发送' } }),
      }))
      return (JSON.parse(text) as { error: { message: string } }).error.message
    }
    const causes = [
      'conversation id missing',
      'Illegal API invocation from an unapproved channel',
      'first message is not system prompt',
    ]
    const shown = await Promise.all(causes.map(rejectedWith))
    for (const [index, message] of shown.entries()) {
      expect(message).toContain('请求被拦截，请重新发送')
      expect(message).toContain(causes[index]!)
      // The digits `11128` are themselves an upstream WAF fingerprint, and the
      // host re-sends this text next turn: printing the code would poison every
      // retry. `msg` distinguishes the causes on its own.
      expect(message).not.toContain('11128')
      expect(HOST_AUTH_HEURISTIC.test(message)).toBe(false)
    }
    expect(new Set(shown).size).toBe(3)
  })

  it('keeps the 401 note for a marked dead session', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: 'Offline user session not found',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toContain('(http 401)')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('keeps the 401 note for a markerless 401, which classifies as session_dead', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: 'unauthorized in some novel wording',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream session_dead (http 401): unauthorized in some novel wording')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('keeps an extracted display text that itself names 403, accepting the residue', async () => {
    // Known residue, pinned on purpose: when the upstream display text
    // itself contains the number ("HTTP 403: 受限"), the real text wins over
    // hiding the digits, and the host heuristic will still read it as AUTH.
    // Rewriting the digits would destroy genuine information; the fix for
    // this class belongs in the host's classifier, not here.
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: JSON.stringify({ code: 11140, msg: 'request illegal', displayMsg: { zh: 'HTTP 403：访问受限，请稍后重试' } }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: HTTP 403：访问受限，请稍后重试 [msg: request illegal]')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('hides the bare 403 from a markerless 403 business error even in raw fallback', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: 'plain text refusal without json',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: plain text refusal without json')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(false)
  })
})

describe('WorkBuddy shim exhaustion guidance', () => {
  /** A refusal the upstream answers when an account is out of credit. */
  const CREDIT_REFUSAL = (): WorkBuddyChatResult => ({
    ok: false,
    status: 402,
    kind: 'hard_credit',
    message: JSON.stringify({ code: 1024, msg: 'insufficient credit' }),
  })

  it('appends a switch-account hint to a hard_credit refusal', async () => {
    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true })
    const { status, body } = await postChat(harness)
    expect(status).toBe(402)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    // The original refusal is preserved, and the remedy is added to it.
    expect(message).toContain('hard_credit')
    expect(message).toContain('额度已用尽')
    expect(message).toContain('捕获')
  })

  it('records the verdict against the account that was refused', async () => {
    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true })
    await postChat(harness)
    // The credential in this harness is uid `uid-1` with no enterprise id.
    expect(harness.quota.isExhausted('uid-1:')).toBe(true)
  })

  it('names a parked alternative when one exists', async () => {
    const accounts = await tempAccountStore()
    await accounts.save({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-2',
      nickname: '备用号',
      source: 'dsh',
    }, { label: '子丹' })

    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true, accounts })
    const { body } = await postChat(harness)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    expect(message).toContain('子丹')
  })

  it('does not recommend an account that already ran dry', async () => {
    const accounts = await tempAccountStore()
    await accounts.save({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-2',
      source: 'dsh',
    }, { label: '子丹' })

    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true, accounts })
    harness.quota.recordExhausted('uid-2:')
    const { body } = await postChat(harness)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    expect(message).not.toContain('子丹')
    expect(message).toContain('也都标记为额度用尽')
  })

  it('clears a verdict after a request succeeds again', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }), { withQuota: true })
    harness.quota.recordExhausted('uid-1:')
    expect(harness.quota.isExhausted('uid-1:')).toBe(true)
    await postChat(harness)
    // A successful call is the earliest honest evidence the refusal no longer
    // holds, since the upstream's cycle reset is not observable directly.
    expect(harness.quota.isExhausted('uid-1:')).toBe(false)
  })

  it('leaves other failure classes without a switch hint', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 429,
      kind: 'soft_rate',
      message: 'too many requests',
    }), { withQuota: true })
    const { status, body } = await postChat(harness)
    expect(status).toBe(429)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    expect(message).toContain('soft_rate')
    // Rate limiting is not a quota wall; telling the user to switch accounts
    // would send them to burn a second account's quota on the same burst.
    expect(message).not.toContain('额度已用尽')
    expect(harness.quota.isExhausted('uid-1:')).toBe(false)
  })

  it('keeps the plain refusal when no quota store is wired', async () => {
    const harness = await startShim(CREDIT_REFUSAL)
    const { status, body } = await postChat(harness)
    expect(status).toBe(402)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    expect(message).toContain('hard_credit')
    expect(message).not.toContain('额度已用尽')
  })

  it('still answers the refusal when the account store cannot be read', async () => {
    // A store whose directory cannot be listed must not turn a useful 402 into
    // an opaque 500; the remedy is optional, the refusal is not.
    const broken = {
      list: async () => { throw new Error('unreadable') },
    } as unknown as WorkBuddyAccountStore
    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true, accounts: broken })
    const { status, body } = await postChat(harness)
    expect(status).toBe(402)
    expect((JSON.parse(body) as { error: { message: string } }).error.message).toContain('hard_credit')
    // The verdict was still recorded before the lookup failed.
    expect(harness.quota.isExhausted('uid-1:')).toBe(true)
  })

  it('records the verdict even when no accounts are parked', async () => {
    const harness = await startShim(CREDIT_REFUSAL, { withQuota: true })
    const { body } = await postChat(harness)
    const message = (JSON.parse(body) as { error: { message: string } }).error.message
    expect(message).toContain('还没有停放其他账号')
    expect(harness.quota.isExhausted(quotaAccountOf({ uid: 'uid-1' }))).toBe(true)
  })
})
