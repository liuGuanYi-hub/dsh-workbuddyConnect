import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createProbeKey, workBuddyProbeHandler, type WorkBuddyProbeRouteOptions } from '../src/probe-route.ts'

/**
 * Offline tests for the probe control route, the plugin's only state-changing
 * endpoint. Two guards must both hold before anything happens: the loopback
 * Host/Origin check (drops DNS-rebinding pages) and the in-process key (proves
 * the caller was the same-origin card, since any local process can write
 * `Host: 127.0.0.1`).
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin + key. */
async function mount(deps?: Partial<WorkBuddyProbeRouteOptions>): Promise<{ origin: string; key: string; calls: string[] }> {
  const key = createProbeKey()
  const calls: string[] = []
  const handler = workBuddyProbeHandler({
    probe: async modelId => {
      calls.push(modelId)
      return { state: 'ok' }
    },
    clear: () => { calls.push('clear') },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one control action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/**
 * POST with full control over the request headers, including `Host`, which
 * `fetch` refuses to set. Needed to exercise the rebinding guard.
 */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* leave empty */ }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('probe control route', () => {
  it('accepts a probe carrying the correct key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(result.body['state']).toBe('ok')
    expect(calls).toEqual(['auto'])
  })

  it('rejects a probe with no key', async () => {
    const { origin, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('invalid-probe-key')
    // Nothing was spent.
    expect(calls).toEqual([])
  })

  it('rejects a wrong key of the same length', async () => {
    const { origin, key, calls } = await mount()
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': wrong })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Host even with the right key', async () => {
    const { origin, key, calls } = await mount()
    // `fetch` refuses to set a `Host` header (it is a forbidden header name),
    // so a spoofed Host has to go through the raw HTTP client — which is
    // exactly what a DNS-rebinding page's request looks like on the wire.
    const result = await postRaw(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Host': 'attacker.example',
    })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Origin even with the right key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Origin': 'https://attacker.example',
    })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses GET', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'X-WorkBuddy-Probe-Key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a malformed action, and a probe with no model', async () => {
    const { origin, key, calls } = await mount()
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'nope' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe', model: '   ' }, headers)).status).toBe(400)
    expect((await post(origin, 'not json', headers)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects an oversized body', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'probe', model: 'x'.repeat(5000) }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(413)
  })

  it('accepts a clear action', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'clear' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(calls).toEqual(['clear'])
  })

  it('accepts the maximum-context preference only when the host supports it', async () => {
    let enabled: boolean | undefined
    const { origin, key } = await mount({
      setMaximumContextWindow: async value => {
        enabled = value
        return { state: 'updated' }
      },
    })
    const result = await post(origin, { action: 'set-maximum-context-window', enabled: true }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(enabled).toBe(true)
  })

  it('mints a distinct key per call', () => {
    expect(createProbeKey()).not.toBe(createProbeKey())
  })
})

/**
 * `check-quota` — the action behind the card's quota button. It spends one real
 * request per parked account, so it shares this route's key and loopback guards
 * rather than the read-only status GET, and a model it cannot trust is refused
 * before any request goes out.
 */
describe('probe control route: check-quota', () => {
  it('runs the sweep and answers with the model it checked', async () => {
    const asked: (string | undefined)[] = []
    const { origin, key } = await mount({
      checkQuota: async model => {
        asked.push(model)
        return { state: 'checked', model: model ?? 'deepseek-v4.1-flash' }
      },
    })
    const result = await post(origin, { action: 'check-quota' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'checked' } })
    expect(asked).toEqual([undefined])
  })

  it('refuses the sweep with no key, and with a wrong one', async () => {
    const { origin } = await mount({ checkQuota: async () => ({ state: 'checked' }) })
    expect((await post(origin, { action: 'check-quota' })).status).toBe(403)
    expect((await post(origin, { action: 'check-quota' }, { 'X-WorkBuddy-Probe-Key': 'nope' })).status).toBe(403)
  })

  it('says so when the host cannot sweep at all', async () => {
    // The default mount has no `checkQuota`: a host without a slot store must
    // answer distinctly rather than pretending an empty sweep ran.
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'check-quota' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 404, body: { error: 'quota-check-not-supported' } })
  })

  it('passes a model the browser named straight through', async () => {
    const asked: (string | undefined)[] = []
    const { origin, key } = await mount({
      checkQuota: async model => {
        asked.push(model)
        return { state: 'checked', model: model ?? '' }
      },
    })
    await post(origin, { action: 'check-quota', model: 'glm-5.2' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(asked).toEqual(['glm-5.2'])
  })

  it('rejects a model that is present but unusable', async () => {
    // Not a silent fallback to the default: the caller asked about one model
    // and would get a sweep of another, spending credit it never chose.
    const { origin, key } = await mount({ checkQuota: async () => ({ state: 'checked' }) })
    for (const model of ['', '   ', 42]) {
      const result = await post(origin, { action: 'check-quota', model }, { 'X-WorkBuddy-Probe-Key': key })
      expect(result.status).toBe(400)
    }
  })
})

/**
 * `checkin` — the action behind the card's daily check-in button. It reads every
 * parked account's reward state and claims the unclaimed ones, so it shares the
 * same key and loopback guards and takes no caller-supplied payload at all.
 */
describe('probe control route: checkin', () => {
  it('runs the sweep and answers with its outcome', async () => {
    let calls = 0
    const { origin, key } = await mount({
      checkin: async () => {
        calls += 1
        return { state: 'checked', reason: '2 claimed, 0 failed of 2' }
      },
    })
    const result = await post(origin, { action: 'checkin' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'checked' } })
    expect(calls).toBe(1)
  })

  it('refuses the sweep with no key, and with a wrong one', async () => {
    const { origin } = await mount({ checkin: async () => ({ state: 'checked' }) })
    expect((await post(origin, { action: 'checkin' })).status).toBe(403)
    expect((await post(origin, { action: 'checkin' }, { 'X-WorkBuddy-Probe-Key': 'nope' })).status).toBe(403)
  })

  it('says so when the host has no slot store to check in', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'checkin' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 404, body: { error: 'checkin-not-supported' } })
  })

  it('ignores a caller-supplied account list', async () => {
    // The sweep is defined over the parked slots; which accounts get a claim
    // must not be something a page can choose.
    let received: unknown
    const { origin, key } = await mount({
      checkin: async (...args: unknown[]) => {
        received = args
        return { state: 'checked' }
      },
    })
    await post(origin, { action: 'checkin', accounts: ['acct-1'] }, { 'X-WorkBuddy-Probe-Key': key })
    expect(received).toEqual([])
  })
})
