import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workBuddyAccountsHandler, workBuddyAccountsSection } from '../src/accounts-route.ts'
import { WorkBuddyAccountStore } from '../src/accounts-store.ts'
import { WorkBuddyQuotaStore } from '../src/quota-state.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { CN_VARIANT } from '../src/variants.ts'

/**
 * The account write route: capture, switch, remove, rename.
 *
 * Mounted on a bare loopback server so the Host/Origin and key guards are
 * exercised for real rather than assumed.
 */

const CLEANUP: (() => Promise<void>)[] = []
const KEY = 'test-probe-key'

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'wb-acc-route-'))
  vi.stubEnv('DSH_HOME', home)
  CLEANUP.push(() => rm(home, { recursive: true, force: true }))
  return home
}

function credential(overrides: Partial<WorkBuddyCredential> & { uid: string }): WorkBuddyCredential {
  return {
    accessToken: `at-${overrides.uid}`,
    refreshToken: `rt-${overrides.uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    nickname: overrides.uid,
    source: 'dsh',
    ...overrides,
  }
}

/** Mount the handler and return its base URL plus a poster. */
async function mount(options: {
  store: WorkBuddyAccountStore
  /** Desktop sign-in getter; re-read on every call so a test can change it. */
  desktop?: () => WorkBuddyCredential | undefined
  onChange?: () => void
}): Promise<{
  base: string
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number, json: unknown }>
  postRaw: (path: string, body: string, headers?: Record<string, string>) => Promise<{ status: number, json: unknown }>
}> {
  const handler = workBuddyAccountsHandler({
    accounts: options.store,
    desktopCredential: async () => options.desktop?.(),
    ...options.onChange === undefined ? {} : { onChange: options.onChange },
  }, KEY)
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  CLEANUP.push(async () => {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })
  const base = `http://127.0.0.1:${port}`

  const postRaw = async (path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number, json: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WorkBuddy-Probe-Key': KEY,
        ...headers,
      },
      body,
    })
    const json: unknown = await response.json().catch(() => undefined)
    return { status: response.status, json }
  }

  return {
    base,
    post: (path, body, headers) => postRaw(path, JSON.stringify(body), headers),
    postRaw,
  }
}

const PATH = '/plugins/dsh-workbuddy-connect/accounts'

describe('accounts route guards', () => {
  it('rejects a GET', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    // A write route answers no read method; the guard order decides whether the
    // method or the key is reported first, so either refusal is correct.
    const response = await fetch(`${server.base}${PATH}`)
    expect([403, 405]).toContain(response.status)
    await response.body?.cancel()
  })

  it('rejects a request without the control key', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status, json } = await server.post(PATH, { action: 'capture' }, { 'X-WorkBuddy-Probe-Key': 'wrong' })
    expect(status).toBe(403)
    expect(json).toEqual({ error: 'invalid-probe-key' })
  })

  it('rejects a non-loopback Origin', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status, json } = await server.post(PATH, { action: 'capture' }, { Origin: 'https://evil.example' })
    expect(status).toBe(403)
    expect(json).toEqual({ error: 'request-not-trusted' })
  })

  it('rejects a malformed body', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status } = await server.postRaw(PATH, '{not json')
    expect(status).toBe(400)
  })

  it('rejects an unknown action', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status } = await server.post(PATH, { action: 'frobnicate' })
    expect(status).toBe(400)
  })

  it('rejects use without an id', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status } = await server.post(PATH, { action: 'use' })
    expect(status).toBe(400)
  })
})

describe('accounts route actions', () => {
  it('captures the desktop sign-in and activates it', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    let changes = 0
    const server = await mount({
      store,
      desktop: () => credential({ uid: 'uid-1' }),
      onChange: () => { changes += 1 },
    })

    const { status, json } = await server.post(PATH, { action: 'capture', label: '一号' })
    expect(status).toBe(200)
    expect(json).toMatchObject({ state: 'captured', label: '一号' })
    expect(changes).toBe(1)
    expect(await store.isEnabled()).toBe(true)
    expect((await store.activeCredential())?.uid).toBe('uid-1')
  })

  it('reports a missing desktop sign-in as its own outcome', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store, desktop: () => undefined })

    const { status, json } = await server.post(PATH, { action: 'capture' })
    expect(status).toBe(409)
    expect(json).toEqual({ error: 'no-desktop-sign-in' })
  })

  it('captures a second account even while the first is served', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    // The getter models the desktop app changing which account it holds.
    let uid = 'uid-1'
    const server = await mount({ store, desktop: () => credential({ uid }) })

    await server.post(PATH, { action: 'capture' })
    uid = 'uid-2'
    const second = await server.post(PATH, { action: 'capture' })

    expect(second.status).toBe(200)
    const slots = await store.list()
    expect(slots).toHaveLength(2)
    expect(slots.map(slot => slot.credential.uid).sort()).toEqual(['uid-1', 'uid-2'])
  })

  it('switches the active account', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await store.save(credential({ uid: 'uid-1' }))
    const two = await store.save(credential({ uid: 'uid-2' }))
    let changes = 0
    const server = await mount({ store, onChange: () => { changes += 1 } })

    const { status, json } = await server.post(PATH, { action: 'use', id: one.id })
    expect(status).toBe(200)
    expect(json).toEqual({ state: 'switched', id: one.id })
    expect(await store.activeId()).toBe(one.id)
    expect(changes).toBe(1)
    void two
  })

  it('reports an unknown id as a typed client error', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status, json } = await server.post(PATH, { action: 'use', id: 'acct-deadbeef' })
    expect(status).toBe(400)
    expect(json).toMatchObject({ error: 'slot-not-found' })
  })

  it('removes a stored account', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const slot = await store.save(credential({ uid: 'uid-1' }))
    const server = await mount({ store })

    const { status, json } = await server.post(PATH, { action: 'remove', id: slot.id })
    expect(status).toBe(200)
    expect(json).toEqual({ state: 'removed', id: slot.id })
    expect(await store.list()).toEqual([])
    // Removing the active slot clears the pointer, handing resolution back.
    expect(await store.isEnabled()).toBe(false)
  })

  it('renames a stored account', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const slot = await store.save(credential({ uid: 'uid-1' }))
    const server = await mount({ store })

    const { status, json } = await server.post(PATH, { action: 'rename', id: slot.id, label: '新名字' })
    expect(status).toBe(200)
    expect(json).toMatchObject({ state: 'renamed', label: '新名字' })
    expect((await store.readSlot(slot.id))?.label).toBe('新名字')
  })

  it('rejects an over-long label as a typed error', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store, desktop: () => credential({ uid: 'uid-1' }) })
    const { status, json } = await server.post(PATH, { action: 'capture', label: 'x'.repeat(41) })
    expect(status).toBe(400)
    expect(json).toMatchObject({ error: 'invalid-label' })
  })

  it('never echoes token material', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store, desktop: () => credential({ uid: 'uid-1' }) })
    const { json } = await server.post(PATH, { action: 'capture' })
    const text = JSON.stringify(json)
    expect(text).not.toContain('at-uid-1')
    expect(text).not.toContain('rt-uid-1')
  })

  it('rejects a body over the size cap', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const server = await mount({ store })
    const { status } = await server.postRaw(PATH, JSON.stringify({ action: 'capture', label: 'x'.repeat(70_000) }))
    expect(status).toBe(413)
  })
})

describe('workBuddyAccountsSection', () => {
  it('is undefined without a store', async () => {
    expect(await workBuddyAccountsSection(undefined, async () => ({ ok: true }))).toBeUndefined()
  })

  it('summarises slots and reports capture availability', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await store.save(credential({ uid: 'uid-1', nickname: '一号' }), { label: '工作号' })

    const section = await workBuddyAccountsSection(store, async () => ({ ok: true }))
    expect(section?.accounts).toHaveLength(1)
    expect(section?.accounts[0]).toMatchObject({ label: '工作号', nickname: '一号', active: true })
    expect(section?.canCapture).toBe(true)
    expect(section?.directory).toContain('workbuddy-accounts')
  })

  it('carries the hint when capture is unavailable', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const section = await workBuddyAccountsSection(store, async () => ({ ok: false, hint: 'sign in first' }))
    expect(section?.canCapture).toBe(false)
    expect(section?.captureHint).toBe('sign in first')
    expect(section?.accounts).toEqual([])
  })

  it('exposes no token material', async () => {
    await tempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await store.save(credential({ uid: 'uid-1' }))
    const section = await workBuddyAccountsSection(store, async () => ({ ok: true }))
    expect(JSON.stringify(section)).not.toContain('at-uid-1')
    expect(JSON.stringify(section)).not.toContain('rt-uid-1')
  })

  describe('quota verdicts', () => {
    /** A quota store in the temp home `tempHome()` just installed. */
    function quotaIn(home: string): WorkBuddyQuotaStore {
      return new WorkBuddyQuotaStore({ path: join(home, 'quota.json') })
    }

    it('omits the verdict fields entirely without a quota store', async () => {
      await tempHome()
      const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
      await store.save(credential({ uid: 'uid-1' }))
      const section = await workBuddyAccountsSection(store, async () => ({ ok: true }))
      // Absent, not false: a host with no quota store must not have the card
      // claim every account is fine.
      expect(section?.accounts[0]).not.toHaveProperty('exhausted')
      expect(section?.accounts[0]).not.toHaveProperty('exhaustedAt')
    })

    it('marks only the refused account', async () => {
      const home = await tempHome()
      const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
      await store.save(credential({ uid: 'uid-1', nickname: '一号' }), { label: '工作号' })
      await store.save(credential({ uid: 'uid-2', nickname: '二号' }), { label: '个人号', activate: false })

      const quota = quotaIn(home)
      const at = Date.now()
      quota.recordExhausted('uid-1:')

      const section = await workBuddyAccountsSection(store, async () => ({ ok: true }), quota)
      const byLabel = new Map(section?.accounts.map(row => [row.label, row]))
      expect(byLabel.get('工作号')).toMatchObject({ exhausted: true })
      expect(byLabel.get('工作号')?.exhaustedAt).toBeGreaterThanOrEqual(at)
      expect(byLabel.get('个人号')?.exhausted).toBeUndefined()
    })

    it('reports a recovered account as unmarked', async () => {
      const home = await tempHome()
      const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
      await store.save(credential({ uid: 'uid-1' }), { label: '工作号' })

      const quota = quotaIn(home)
      quota.recordExhausted('uid-1:')
      quota.clear('uid-1:')

      const section = await workBuddyAccountsSection(store, async () => ({ ok: true }), quota)
      expect(section?.accounts[0]?.exhausted).toBeUndefined()
    })

    it('leaves an account with no uid unmarked rather than sharing a bucket', async () => {
      const home = await tempHome()
      const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
      await store.save(credential({ uid: '' }), { label: '匿名号' })

      const quota = quotaIn(home)
      // Recording against the empty identity is refused by the store, so no
      // verdict can ever be attributed to a uid-less account.
      expect(quota.recordExhausted(undefined)).toBe(false)

      const section = await workBuddyAccountsSection(store, async () => ({ ok: true }), quota)
      expect(section?.accounts[0]?.exhausted).toBeUndefined()
    })
  })
})
