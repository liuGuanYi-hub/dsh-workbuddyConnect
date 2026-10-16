import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyQuotaCheckStore,
  workbuddyQuotaCheckPath,
  WORKBUDDY_QUOTA_CHECK_FILENAME,
} from '../src/quota-check-store.ts'

/**
 * Persistence for the on-demand quota sweep.
 *
 * What these protect is the promise the feature exists for: a check spent real
 * requests, so its answer must be readable after the process that paid for it
 * is gone — by the card on next open, and by the CLI in another process.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

async function tempStore(): Promise<{ store: WorkBuddyQuotaCheckStore, path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'wb-quota-check-'))
  CLEANUP.push(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'quota-check.json')
  return { store: new WorkBuddyQuotaCheckStore({ path }), path }
}

const sweep = {
  model: 'deepseek-v4.1-flash',
  checkedAtMs: 1_800_000_000_000,
  results: [
    { id: 'acct-1', label: '工作号', state: 'available' as const, status: 200 },
    { id: 'acct-2', state: 'exhausted' as const, status: 402 },
    { id: 'acct-3', state: 'unknown' as const, status: 401, reason: 'status 401: session dead' },
  ],
}

describe('WorkBuddyQuotaCheckStore', () => {
  it('answers undefined before any sweep has been recorded', async () => {
    const { store } = await tempStore()
    expect(store.last()).toBeUndefined()
  })

  it('reads back the rows a sweep wrote, through a second store', async () => {
    const { store, path } = await tempStore()
    expect(store.record(sweep)).toBe(true)
    // A fresh instance is what the CLI is: another process, another object,
    // the same file.
    const reopened = new WorkBuddyQuotaCheckStore({ path })
    expect(reopened.last()).toEqual({
      model: 'deepseek-v4.1-flash',
      checkedAtMs: 1_800_000_000_000,
      results: [
        { id: 'acct-1', label: '工作号', state: 'available', status: 200 },
        { id: 'acct-2', state: 'exhausted', status: 402 },
        { id: 'acct-3', state: 'unknown', status: 401, reason: 'status 401: session dead' },
      ],
    })
  })

  it('replaces the previous sweep instead of merging into it', async () => {
    const { store } = await tempStore()
    store.record(sweep)
    store.record({
      model: 'deepseek-v4.1-flash',
      checkedAtMs: 1_800_000_600_000,
      // One account left the parking lot between sweeps.
      results: [{ id: 'acct-1', state: 'exhausted' as const, status: 402 }],
    })
    const last = store.last()
    expect(last?.checkedAtMs).toBe(1_800_000_600_000)
    expect(last?.results).toHaveLength(1)
    expect(last?.results[0]).toMatchObject({ id: 'acct-1', state: 'exhausted' })
  })

  it('writes a document a reader can inspect, under the harness home by default', async () => {
    const { store, path } = await tempStore()
    store.record(sweep)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('"version": 1')
    expect(text).toContain('"model": "deepseek-v4.1-flash"')
    expect(workbuddyQuotaCheckPath()).toContain(WORKBUDDY_QUOTA_CHECK_FILENAME)
  })

  it('stores no credential material', async () => {
    const { store, path } = await tempStore()
    store.record({
      ...sweep,
      results: [{ id: 'acct-1', state: 'unknown' as const, status: 0, reason: 'transport error: aborted' }],
    })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('accessToken')
    expect(text).not.toContain('refreshToken')
  })

  it.each([
    ['another format version', '{"version":2,"model":"m","checkedAtMs":1,"results":{}}'],
    ['a document that is not an object', '[]'],
    ['a results field of the wrong shape', '{"version":1,"model":"m","checkedAtMs":1,"results":[]}'],
    ['half-written JSON', '{"version":1,"model":'],
  ])('reads %s as no sweep at all rather than throwing', async (_label, text) => {
    const { store, path } = await tempStore()
    await writeFile(path, text)
    expect(store.last()).toBeUndefined()
  })

  it('drops a row whose key disagrees with its own id', async () => {
    // A row stored under one account and describing another would render the
    // wrong account's verdict beside the wrong name. The rest of the sweep is
    // still trustworthy, so only the disagreeing row is dropped.
    const { store, path } = await tempStore()
    await writeFile(path, JSON.stringify({
      version: 1,
      model: 'deepseek-v4.1-flash',
      checkedAtMs: 1_800_000_000_000,
      results: {
        'acct-1': { id: 'acct-OTHER', state: 'available', status: 200 },
        'acct-2': { id: 'acct-2', state: 'exhausted', status: 402 },
      },
    }))
    expect(store.last()?.results).toEqual([{ id: 'acct-2', state: 'exhausted', status: 402 }])
  })

  it('keeps a sweep with no rows distinguishable from no sweep', async () => {
    // `accounts quota` must be able to say "checked, and nothing was parked"
    // instead of "never checked".
    const { store } = await tempStore()
    store.record({ model: 'deepseek-v4.1-flash', checkedAtMs: 1_800_000_000_000, results: [] })
    expect(store.last()?.results).toEqual([])
  })
})
