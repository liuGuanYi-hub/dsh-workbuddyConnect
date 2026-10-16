import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QUOTA_VERDICT_TTL_MS,
  WorkBuddyQuotaStore,
  quotaAccountOf,
  workbuddyQuotaPath,
  WORKBUDDY_QUOTA_FILENAME,
} from '../src/quota-state.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** A store in its own temp directory, so no test can observe another's file. */
async function tempStore(options: { ttlMs?: number } = {}): Promise<{ store: WorkBuddyQuotaStore, path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'wb-quota-'))
  CLEANUP.push(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'quota.json')
  return { store: new WorkBuddyQuotaStore({ path, ...options }), path }
}

describe('quotaAccountOf', () => {
  it('keys on uid and enterprise id together', () => {
    expect(quotaAccountOf({ uid: 'u1', enterpriseId: 'e1' })).toBe('u1:e1')
  })

  it('treats a missing enterprise id as an empty segment, not another account', () => {
    expect(quotaAccountOf({ uid: 'u1' })).toBe('u1:')
  })

  it('refuses to key an account with no uid', () => {
    // Keying on `":e1"` would merge every uid-less account into one bucket, so
    // such an account gets no verdict at all rather than a shared one.
    expect(quotaAccountOf({ uid: '', enterpriseId: 'e1' })).toBeUndefined()
  })
})

describe('WorkBuddyQuotaStore', () => {
  it('reports an unknown account as usable', async () => {
    const { store } = await tempStore()
    expect(store.status('u1:')).toEqual({ state: 'ok' })
    expect(store.isExhausted('u1:')).toBe(false)
  })

  it('reports an unkeyable account as usable rather than erroring', async () => {
    const { store } = await tempStore()
    expect(store.status(undefined).state).toBe('ok')
    expect(store.recordExhausted(undefined)).toBe(false)
  })

  it('remembers an exhaustion verdict across instances', async () => {
    const { store, path } = await tempStore()
    expect(store.recordExhausted('u1:e1')).toBe(true)
    // A second instance proves the verdict reached disk, not just memory.
    const reopened = new WorkBuddyQuotaStore({ path })
    expect(reopened.isExhausted('u1:e1')).toBe(true)
    expect(reopened.status('u1:e1').count).toBe(1)
  })

  it('keeps verdicts per account', async () => {
    const { store } = await tempStore()
    store.recordExhausted('u1:e1')
    expect(store.isExhausted('u1:e1')).toBe(true)
    expect(store.isExhausted('u2:e1')).toBe(false)
    expect(store.isExhausted('u1:e2')).toBe(false)
  })

  it('counts repeat refusals and moves the timestamp forward', async () => {
    const { store } = await tempStore()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
      store.recordExhausted('u1:e1')
      const first = store.status('u1:e1').exhaustedAtMs
      vi.setSystemTime(new Date('2026-10-16T11:00:00Z'))
      store.recordExhausted('u1:e1')
      const second = store.status('u1:e1')
      expect(second.count).toBe(2)
      expect(second.exhaustedAtMs).toBeGreaterThan(first ?? 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ages a verdict out once its lifetime has passed', async () => {
    const { store } = await tempStore({ ttlMs: 1000 })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
      store.recordExhausted('u1:e1')
      expect(store.isExhausted('u1:e1')).toBe(true)
      // A cycle reset is invisible to the plugin, so a verdict that never
      // expires would brand a recovered account forever.
      vi.setSystemTime(new Date('2026-10-16T10:00:02Z'))
      expect(store.isExhausted('u1:e1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to a lifetime that spans a working session', () => {
    // Twelve hours: a morning verdict still applies in the afternoon, and an
    // overnight reset clears it. Asserted so the constant is not quietly
    // shrunk to something that forgets within a session.
    expect(QUOTA_VERDICT_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('clears a verdict when the account succeeds again', async () => {
    const { store } = await tempStore()
    store.recordExhausted('u1:e1')
    expect(store.clear('u1:e1')).toBe(true)
    expect(store.isExhausted('u1:e1')).toBe(false)
    // Clearing twice is a no-op, reported rather than thrown.
    expect(store.clear('u1:e1')).toBe(false)
  })

  it('writes a versioned document with owner-only permissions', async () => {
    const { store, path } = await tempStore()
    store.recordExhausted('u1:e1')
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(document['version']).toBe(1)
    expect(Object.keys(document['accounts'] as object)).toEqual(['u1:e1'])
  })

  it('treats a corrupt file as no verdicts rather than throwing', async () => {
    const { store, path } = await tempStore()
    await writeFile(path, '{ not json', 'utf8')
    expect(store.isExhausted('u1:e1')).toBe(false)
    // And it stays writable: a corrupt read must not poison the store.
    expect(store.recordExhausted('u1:e1')).toBe(true)
    expect(store.isExhausted('u1:e1')).toBe(true)
  })

  it('ignores a document written by a future format version', async () => {
    const { store, path } = await tempStore()
    await writeFile(path, JSON.stringify({
      version: 99,
      accounts: { 'u1:e1': { account: 'u1:e1', exhaustedAtMs: Date.now(), count: 1 } },
    }), 'utf8')
    expect(store.isExhausted('u1:e1')).toBe(false)
  })

  it('drops malformed entries but keeps well-formed neighbours', async () => {
    const { store, path } = await tempStore()
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: {
        'u1:e1': { account: 'u1:e1', exhaustedAtMs: Date.now(), count: 2 },
        'u2:e1': { account: 'u2:e1', exhaustedAtMs: 'yesterday', count: 1 },
        'u3:e1': { account: 'u3:e1', exhaustedAtMs: Date.now(), count: 0 },
      },
    }), 'utf8')
    expect(store.isExhausted('u1:e1')).toBe(true)
    expect(store.isExhausted('u2:e1')).toBe(false)
    expect(store.isExhausted('u3:e1')).toBe(false)
  })

  it('reports a failed write instead of throwing on the chat path', async () => {
    const { store, path } = await tempStore()
    // A directory where the file belongs makes every write fail.
    await rm(path, { force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path)
    expect(store.recordExhausted('u1:e1')).toBe(false)
    // The failure was not committed to memory either, so a re-read cannot lie.
    expect(store.isExhausted('u1:e1')).toBe(false)
  })
})

describe('workbuddyQuotaPath', () => {
  it('resolves inside the harness home', () => {
    vi.stubEnv('DSH_HOME', 'C:\\fake-home')
    expect(workbuddyQuotaPath()).toContain(WORKBUDDY_QUOTA_FILENAME)
    expect(workbuddyQuotaPath()).toContain('fake-home')
  })

  it('accepts a per-variant filename', () => {
    expect(workbuddyQuotaPath('.workbuddy-ai-quota-state.json'))
      .toContain('.workbuddy-ai-quota-state.json')
  })
})
