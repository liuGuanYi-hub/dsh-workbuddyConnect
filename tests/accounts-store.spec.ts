import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_FILENAME,
  WorkBuddyAccountError,
  WorkBuddyAccountStore,
  isValidSlotId,
  sameAccountIdentity,
  slotIdForUid,
} from '../src/accounts-store.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

type Credential = WorkBuddyCredential

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/**
 * Point the harness home at a fresh temp directory.
 *
 * `DSH_HOME` is stubbed rather than `os.homedir()` because `resolveDshHome`
 * gives the environment variable top precedence — and this suite runs inside a
 * live DSH session, where `DSH_HOME` really is set to the user's own `.dsh`.
 * Mocking homedir alone left the tests writing into the real harness home.
 */
async function useTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'wb-accounts-'))
  vi.stubEnv('DSH_HOME', home)
  CLEANUP.push(async () => {
    await rm(home, { recursive: true, force: true })
  })
  return home
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    nickname: '账号一',
    source: 'dsh',
    ...overrides,
  }
}

describe('slotIdForUid', () => {
  it('is stable for the same uid', () => {
    expect(slotIdForUid('uid-abc')).toBe(slotIdForUid('uid-abc'))
  })

  it('separates different uids', () => {
    expect(slotIdForUid('uid-a')).not.toBe(slotIdForUid('uid-b'))
  })

  it('ignores case and surrounding space, so re-imports land in one slot', () => {
    expect(slotIdForUid('  UID-Abc  ')).toBe(slotIdForUid('uid-abc'))
  })

  it('produces a valid, filename-safe id', () => {
    for (const uid of ['uid-1', '', '  ', '中文账号', 'a'.repeat(200)]) {
      expect(isValidSlotId(slotIdForUid(uid))).toBe(true)
    }
  })

  it('does not embed the uid in the filename', () => {
    expect(slotIdForUid('secret-uid-123')).not.toContain('secret-uid-123')
  })
})

describe('WorkBuddyAccountStore', () => {
  it('starts disabled with no slots and no pointer', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    expect(await store.list()).toEqual([])
    expect(await store.activeId()).toBeUndefined()
    expect(await store.isEnabled()).toBe(false)
    expect(await store.activeCredential()).toBeUndefined()
  })

  it('saves a slot and activates it by default', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential(), { label: '国内一号' })

    expect(saved.label).toBe('国内一号')
    expect(await store.isEnabled()).toBe(true)
    expect((await store.activeCredential())?.accessToken).toBe('at-1')
    expect(await store.activeId()).toBe(saved.id)
  })

  it('round-trips every credential field through disk', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const original = credential({
      accessToken: 'at-x',
      refreshToken: 'rt-x',
      expiresAtMs: 1_792_128_236_868,
      refreshExpiresAtMs: 1_800_000_000_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-x',
      enterpriseId: 'ent-x',
      nickname: '昵称X',
    })
    await store.save(original, { activate: false })

    const [slot] = await store.list()
    expect(slot?.credential).toEqual({ ...original, source: 'dsh' })
  })

  it('updates the same uid in place instead of duplicating it', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const first = await store.save(credential(), { label: '原标题' })
    const second = await store.save(credential({ accessToken: 'at-2' }), { activate: false })

    expect(second.id).toBe(first.id)
    expect(await store.list()).toHaveLength(1)
    // The label survives a re-import that does not supply a new one.
    expect((await store.readSlot(first.id))?.label).toBe('原标题')
    expect((await store.readSlot(first.id))?.credential.accessToken).toBe('at-2')
    // And the original creation time is preserved.
    expect(second.addedAtMs).toBe(first.addedAtMs)
  })

  it('keeps two accounts in separate slots and switches between them', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await store.save(credential({ uid: 'uid-1', accessToken: 'at-1' }), { label: '一号' })
    const two = await store.save(credential({ uid: 'uid-2', accessToken: 'at-2' }), { label: '二号' })

    expect(one.id).not.toBe(two.id)
    expect(await store.list()).toHaveLength(2)

    // save() activates, so the second account is current.
    expect((await store.activeCredential())?.accessToken).toBe('at-2')

    await store.setActive(one.id)
    expect((await store.activeCredential())?.accessToken).toBe('at-1')

    await store.setActive(two.id)
    expect((await store.activeCredential())?.accessToken).toBe('at-2')
  })

  it('never writes token material into the pointer document', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())

    const pointer = await readFile(join(store.directory(), ACTIVE_FILENAME), 'utf8')
    expect(pointer).not.toContain('at-1')
    expect(pointer).not.toContain('rt-1')
    expect(JSON.parse(pointer)).toEqual({ version: 1, activeId: saved.id })
  })

  it('stores slot files with owner-only permissions', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())
    const document = JSON.parse(await readFile(store.slotPath(saved.id), 'utf8'))
    expect(document.credential.accessToken).toBe('at-1')
    expect(document.version).toBe(1)
  })

  it('rejects a pointer that names a missing slot, falling back to disabled', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())
    await rm(store.slotPath(saved.id), { force: true })

    // A pointer without its slot must not enable slot mode.
    expect(await store.isEnabled()).toBe(false)
    expect(await store.activeCredential()).toBeUndefined()
  })

  it('drops the pointer when the active slot is removed', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())
    await store.remove(saved.id)

    expect(await store.activeId()).toBeUndefined()
    expect(await store.isEnabled()).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('promotes nobody when a non-active slot is removed', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await store.save(credential({ uid: 'uid-1', accessToken: 'at-1' }))
    const two = await store.save(credential({ uid: 'uid-2', accessToken: 'at-2' }))
    await store.setActive(two.id)

    await store.remove(one.id)
    expect(await store.activeId()).toBe(two.id)
    expect((await store.activeCredential())?.accessToken).toBe('at-2')
  })

  it('reports a typed error for unknown slots', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await expect(store.setActive('acct-deadbeef')).rejects.toBeInstanceOf(WorkBuddyAccountError)
    await expect(store.remove('acct-deadbeef')).rejects.toMatchObject({ code: 'slot-not-found' })
  })

  it('rejects ids that are not filename-safe', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    for (const bad of ['../escape', 'has space', 'UPPER', '', 'a/b']) {
      await expect(store.setActive(bad)).rejects.toMatchObject({ code: 'invalid-id' })
    }
  })

  it('relabels a slot and clears the label again', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())

    const renamed = await store.relabel(saved.id, '  新名字  ')
    expect(renamed.label).toBe('新名字')
    expect((await store.readSlot(saved.id))?.label).toBe('新名字')

    await store.relabel(saved.id, '   ')
    expect((await store.readSlot(saved.id))?.label).toBeUndefined()
  })

  it('rejects an over-long label', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await expect(store.save(credential(), { label: 'x'.repeat(41) }))
      .rejects.toMatchObject({ code: 'invalid-label' })
  })

  it('updates a stored credential without moving the selection', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await store.save(credential({ uid: 'uid-1', accessToken: 'at-1' }))
    await store.save(credential({ uid: 'uid-2', accessToken: 'at-2' }))
    await store.setActive(one.id)

    await store.updateCredential(one.id, credential({ uid: 'uid-1', accessToken: 'at-refreshed' }))

    expect(await store.activeId()).toBe(one.id)
    expect((await store.activeCredential())?.accessToken).toBe('at-refreshed')
  })

  it('skips malformed slot files without losing the readable ones', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const good = await store.save(credential())

    await writeFile(join(store.directory(), 'acct-broken.json'), '{ not json', 'utf8')
    await writeFile(join(store.directory(), 'acct-empty.json'), JSON.stringify({ version: 1, credential: {} }), 'utf8')

    const slots = await store.list()
    expect(slots).toHaveLength(1)
    expect(slots[0]?.id).toBe(good.id)
  })

  it('ignores a slot document written by a future format version', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential())
    await writeFile(store.slotPath(saved.id), JSON.stringify({ version: 99, id: saved.id, credential: credential() }), 'utf8')

    expect(await store.list()).toEqual([])
    expect(await store.isEnabled()).toBe(false)
  })

  it('keeps the two variants in separate directories', async () => {
    await useTempHome()
    const cn = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const ai = new WorkBuddyAccountStore({ variant: AI_VARIANT })

    expect(cn.directory()).not.toBe(ai.directory())
    await cn.save(credential({ uid: 'uid-cn' }))

    expect(await cn.list()).toHaveLength(1)
    expect(await ai.list()).toHaveLength(0)
  })

  it('summarizes slots without exposing token material', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const saved = await store.save(credential({ nickname: '昵称一' }), { label: '一号' })

    const [summary] = await store.summaries()
    expect(summary).toMatchObject({
      id: saved.id,
      label: '一号',
      nickname: '昵称一',
      uid: 'uid-1',
      active: true,
      expired: false,
    })
    expect(JSON.stringify(summary)).not.toContain('at-1')
    expect(JSON.stringify(summary)).not.toContain('rt-1')
  })

  it('marks an expired credential in its summary', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    await store.save(credential({ expiresAtMs: Date.now() - 1000 }))

    const [summary] = await store.summaries()
    expect(summary?.expired).toBe(true)
  })

  it('marks only the active slot active', async () => {
    await useTempHome()
    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    const one = await store.save(credential({ uid: 'uid-1' }))
    const two = await store.save(credential({ uid: 'uid-2' }))
    await store.setActive(two.id)

    const summaries = await store.summaries()
    expect(summaries.find(s => s.id === one.id)?.active).toBe(false)
    expect(summaries.find(s => s.id === two.id)?.active).toBe(true)
  })
})

describe('sameAccountIdentity', () => {
  it('compares uid and enterprise together', () => {
    expect(sameAccountIdentity({ uid: 'a' }, { uid: 'a' })).toBe(true)
    expect(sameAccountIdentity({ uid: 'a' }, { uid: 'b' })).toBe(false)
    expect(sameAccountIdentity({ uid: 'a', enterpriseId: 'e' }, { uid: 'a' })).toBe(false)
    expect(sameAccountIdentity({ uid: 'a', enterpriseId: 'e' }, { uid: 'a', enterpriseId: 'e' })).toBe(true)
  })
})
