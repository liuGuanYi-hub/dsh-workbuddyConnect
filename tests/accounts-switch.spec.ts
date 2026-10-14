import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyAccountStore } from '../src/accounts-store.ts'
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from '../src/auth.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

/**
 * End-to-end slot switching through the credential store: the layer that
 * decides which account a request is actually sent as.
 *
 * `DSH_HOME` is stubbed for the harness-home-derived slot directory, while the
 * desktop file stays an explicit temp path so each case can decide what the
 * app is "signed into" independently of the parked accounts.
 */
const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A fresh harness home, so slot directories start empty. */
async function tempHome(): Promise<string> {
  const home = await tempDir('wb-home-')
  vi.stubEnv('DSH_HOME', home)
  return home
}

function desktopDoc(options: {
  uid: string
  accessToken: string
  expiresAt?: number
  nickname?: string
  domain?: string
}): string {
  return JSON.stringify({
    auth: {
      accessToken: options.accessToken,
      refreshToken: `rt-${options.uid}`,
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      domain: options.domain ?? 'www.codebuddy.cn',
    },
    account: {
      uid: options.uid,
      ...options.nickname === undefined ? {} : { nickname: options.nickname },
    },
  })
}

function credential(options: Partial<WorkBuddyCredential> & { uid: string }): WorkBuddyCredential {
  return {
    accessToken: `at-${options.uid}`,
    refreshToken: `rt-${options.uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    nickname: options.uid,
    source: 'dsh',
    ...options,
  }
}

function storeFor(options: {
  desktopPath: string
  ownPath: string
  variant?: typeof CN_VARIANT
  accounts?: WorkBuddyAccountStore
  refresh?: (credential: WorkBuddyCredential) => Promise<{ accessToken: string, refreshToken?: string, expiresInSec?: number }>
}): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    variant: options.variant ?? CN_VARIANT,
    desktopPath: options.desktopPath,
    ownPath: options.ownPath,
    ...options.accounts === undefined ? {} : { accounts: options.accounts },
    refresh: options.refresh ?? (async () => ({ accessToken: 'refreshed' })),
  })
}

describe('slot mode is off until an account is stored', () => {
  it('follows the desktop file exactly as before when no slot is active', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, desktopDoc({ uid: 'uid-desktop', accessToken: 'at-desktop' }))

    const store = storeFor({ desktopPath: desktop, ownPath: join(dir, 'own.json') })
    await expect(store.resolve()).resolves.toMatchObject({
      accessToken: 'at-desktop',
      uid: 'uid-desktop',
      source: 'desktop',
    })
  })

  it('reports the account store so the card can describe the mode', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const store = storeFor({ desktopPath: join(dir, 'desktop.info'), ownPath: join(dir, 'own.json') })
    expect(store.accountStore()).toBeInstanceOf(WorkBuddyAccountStore)
    expect(await store.accountStore()?.isEnabled()).toBe(false)
  })

  it('keeps single-account semantics for a variant-less legacy store', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({ uid: 'uid-parked', accessToken: 'at-parked' }))

    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, desktopDoc({ uid: 'uid-desktop', accessToken: 'at-desktop' }))

    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'refreshed' }),
    })
    // A store with no variant cannot be slotted, so the parked account is
    // invisible even though one exists on disk.
    expect(store.accountStore()).toBeUndefined()
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-desktop' })
  })
})

describe('slot mode serves the selected account', () => {
  it('prefers the active slot over the live desktop session', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({ uid: 'uid-parked', accessToken: 'at-parked' }))

    // The desktop app is signed into a *different* account; the slot must win,
    // otherwise switching would be silently undone by whatever the app holds.
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, desktopDoc({ uid: 'uid-desktop', accessToken: 'at-desktop' }))

    const store = storeFor({ desktopPath: desktop, ownPath: join(dir, 'own.json'), accounts })
    await expect(store.resolve()).resolves.toMatchObject({
      accessToken: 'at-parked',
      uid: 'uid-parked',
      source: 'dsh',
    })
  })

  it('switches accounts by moving the pointer', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await accounts.save(credential({ uid: 'uid-1', accessToken: 'at-1' }))
    const two = await accounts.save(credential({ uid: 'uid-2', accessToken: 'at-2' }))

    const store = storeFor({ desktopPath: join(dir, 'none.info'), ownPath: join(dir, 'own.json'), accounts })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-2', uid: 'uid-2' })

    await accounts.setActive(one.id)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-1', uid: 'uid-1' })

    await accounts.setActive(two.id)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-2', uid: 'uid-2' })
  })

  it('serves the parked account even when the app is signed out', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({ uid: 'uid-parked', accessToken: 'at-parked' }))

    // No desktop file at all: slot mode must not depend on the app being signed in.
    const store = storeFor({ desktopPath: join(dir, 'missing.info'), ownPath: join(dir, 'own.json'), accounts })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-parked' })
  })

  it('falls back to the desktop file after the active slot is removed', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const parked = await accounts.save(credential({ uid: 'uid-parked', accessToken: 'at-parked' }))

    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, desktopDoc({ uid: 'uid-desktop', accessToken: 'at-desktop' }))
    const store = storeFor({ desktopPath: desktop, ownPath: join(dir, 'own.json'), accounts })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-parked' })

    await accounts.remove(parked.id)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-desktop' })
  })

  it('refuses a slot holding the other product region', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    // A global (workbuddy.ai) credential parked in the CN variant's directory.
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({
      uid: 'uid-global',
      domain: 'www.workbuddy.ai',
      accessToken: 'at-global',
    }))

    const store = storeFor({ desktopPath: join(dir, 'none.info'), ownPath: join(dir, 'own.json'), accounts })
    await expect(store.resolve()).rejects.toThrow(/credential-region-mismatch|WorkBuddy AI/u)
  })

  it('keeps each product on its own slots', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const cn = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const ai = new WorkBuddyAccountStore({ variant: AI_VARIANT })
    await cn.save(credential({ uid: 'uid-cn', accessToken: 'at-cn' }))
    await ai.save(credential({ uid: 'uid-ai', accessToken: 'at-ai', domain: 'www.workbuddy.ai' }))

    const cnStore = storeFor({ desktopPath: join(dir, 'none.info'), ownPath: join(dir, 'cn-own.json'), accounts: cn })
    const aiStore = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      desktopPath: join(dir, 'none.info'),
      ownPath: join(dir, 'ai-own.json'),
      accounts: ai,
      refresh: async () => ({ accessToken: 'refreshed' }),
    })

    await expect(cnStore.resolve()).resolves.toMatchObject({ accessToken: 'at-cn' })
    await expect(aiStore.resolve()).resolves.toMatchObject({ accessToken: 'at-ai' })
  })
})

describe('refreshes are written back to the slot', () => {
  it('persists a refreshed token into the slot and reuses it', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const slot = await accounts.save(credential({
      uid: 'uid-1',
      accessToken: 'at-old',
      expiresAtMs: Date.now() - 1000,
    }))

    let refreshes = 0
    const store = storeFor({
      desktopPath: join(dir, 'none.info'),
      ownPath: join(dir, 'own.json'),
      accounts,
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'at-new', refreshToken: 'rt-new', expiresInSec: 3600 }
      },
    })

    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-new', source: 'dsh' })
    expect(refreshes).toBe(1)

    // The refreshed token landed in the slot, not in the single-account copy.
    expect((await accounts.readSlot(slot.id))?.credential.accessToken).toBe('at-new')
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-new' })
    expect(refreshes).toBe(1)
  })

  it('does not write a stale refresh over an account switched away from', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await accounts.save(credential({
      uid: 'uid-1',
      accessToken: 'at-1-old',
      expiresAtMs: Date.now() - 1000,
    }))
    const two = await accounts.save(credential({ uid: 'uid-2', accessToken: 'at-2' }))

    // The refresh resolves only after the user has switched to account two,
    // which is what the uid check in saveSlotted has to survive.
    const store = storeFor({
      desktopPath: join(dir, 'none.info'),
      ownPath: join(dir, 'own.json'),
      accounts,
      refresh: async () => {
        await accounts.setActive(two.id)
        return { accessToken: 'at-1-refreshed', expiresInSec: 3600 }
      },
    })

    await store.resolve()
    // Account two is untouched, and account one kept its token because it was
    // no longer the selected slot when the refresh came back.
    expect((await accounts.readSlot(two.id))?.credential.accessToken).toBe('at-2')
    expect((await accounts.readSlot(one.id))?.credential.accessToken).toBe('at-1-old')
  })

  it('does not create the single-account copy while slotted', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({
      uid: 'uid-1',
      accessToken: 'at-old',
      expiresAtMs: Date.now() - 1000,
    }))

    const own = join(dir, 'own.json')
    const store = storeFor({
      desktopPath: join(dir, 'none.info'),
      ownPath: own,
      accounts,
      refresh: async () => ({ accessToken: 'at-new', expiresInSec: 3600 }),
    })
    await store.resolve()

    await expect(readFile(own, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('status reflects the selected slot', () => {
  it('reports the parked account while the desktop app is signed out', async () => {
    const dir = await tempDir('wb-slot-')
    await tempHome()
    const accounts = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await accounts.save(credential({ uid: 'uid-parked', nickname: '停靠账号' }))

    const store = storeFor({ desktopPath: join(dir, 'missing.info'), ownPath: join(dir, 'own.json'), accounts })
    await expect(store.status()).resolves.toMatchObject({
      state: 'signed-in',
      nickname: '停靠账号',
      source: 'dsh',
    })
  })
})
