import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyQuotaCheckService } from '../src/quota-check-service.ts'
import { WorkBuddyQuotaCheckStore } from '../src/quota-check-store.ts'
import { WorkBuddyQuotaStore, quotaAccountOf } from '../src/quota-state.ts'
import type { WorkBuddyAccountSlot } from '../src/accounts-store.ts'
import type { WorkBuddyAccountStore } from '../src/accounts-store.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { ProbeAttempt } from '../src/probe.ts'

/**
 * The sweep that the card's button and the CLI's reader share.
 *
 * These pin the three things the service owns: which accounts get tested and
 * against what, that the verdicts land in the same store the chat path writes,
 * and that the rows survive the process that paid for them.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function tempPaths(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-quota-sweep-'))
  CLEANUP.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return { dir }
}

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'dsh',
    ...overrides,
  }
}

function slot(id: string, uid: string, label?: string): WorkBuddyAccountSlot {
  return {
    id,
    ...(label === undefined ? {} : { label }),
    addedAtMs: 0,
    updatedAtMs: 0,
    credential: credential({ uid }),
  }
}

/** A slot store over exactly these slots. */
function accountsOf(slots: readonly WorkBuddyAccountSlot[]): WorkBuddyAccountStore {
  return { list: async () => [...slots] } as unknown as WorkBuddyAccountStore
}

describe('WorkBuddyQuotaCheckService', () => {
  it('sends one request per parked account, against the model it was asked about', async () => {
    const { dir } = await tempPaths()
    const sent: { uid: string, model: string }[] = []
    const service = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1'), slot('acct-2', 'uid-2')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      send: async (credential, model) => {
        sent.push({ uid: credential.uid, model })
        return { status: 200, streamed: true }
      },
    })
    const outcome = await service.checkAll('deepseek-v4.1-flash')
    // The point of the sweep: it tests the parked accounts, not only whichever
    // one is being served right now.
    expect(sent).toEqual([
      { uid: 'uid-1', model: 'deepseek-v4.1-flash' },
      { uid: 'uid-2', model: 'deepseek-v4.1-flash' },
    ])
    expect(outcome.results.map(result => result.state)).toEqual(['available', 'available'])
  })

  it('records a refusal and clears one, in the store the chat path writes', async () => {
    const { dir } = await tempPaths()
    const quota = new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') })
    const attempts: Record<string, ProbeAttempt> = {
      'uid-1': { status: 402, streamed: false },
      'uid-2': { status: 200, streamed: true },
    }
    // `uid-2` was refused earlier in the session; a check that gets it back is
    // the earliest honest evidence the refusal no longer holds.
    quota.recordExhausted(quotaAccountOf({ uid: 'uid-2' }))
    const service = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1'), slot('acct-2', 'uid-2')]),
      quota,
      send: async credential => attempts[credential.uid] ?? { status: 0, streamed: false },
    })
    await service.checkAll('deepseek-v4.1-flash')
    expect(quota.isExhausted(quotaAccountOf({ uid: 'uid-1' }))).toBe(true)
    expect(quota.isExhausted(quotaAccountOf({ uid: 'uid-2' }))).toBe(false)
  })

  it('persists the rows so another reader gets the same answer', async () => {
    const { dir } = await tempPaths()
    const checks = new WorkBuddyQuotaCheckStore({ path: join(dir, 'check.json') })
    const service = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1', '工作号')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      checks,
      send: async () => ({ status: 402, streamed: false }),
    })
    await service.checkAll('deepseek-v4.1-flash')
    // The CLI is that other reader: a different process, no service instance.
    const recorded = new WorkBuddyQuotaCheckStore({ path: join(dir, 'check.json') }).last()
    expect(recorded?.results).toEqual([
      { id: 'acct-1', label: '工作号', state: 'exhausted', status: 402 },
    ])
  })

  it('reports the persisted sweep when this process never ran one', async () => {
    const { dir } = await tempPaths()
    const path = join(dir, 'check.json')
    const first = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      checks: new WorkBuddyQuotaCheckStore({ path }),
      send: async () => ({ status: 200, streamed: true }),
    })
    await first.checkAll('deepseek-v4.1-flash')
    // A host restart: same file, new service, nothing run yet.
    const restarted = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      checks: new WorkBuddyQuotaCheckStore({ path }),
      send: async () => ({ status: 200, streamed: true }),
    })
    expect(restarted.lastOutcome()?.results[0]).toMatchObject({ id: 'acct-1', state: 'available' })
    // `running` still describes this process only — nothing was started here.
    expect(restarted.isRunning()).toBe(false)
  })

  it('joins a second press into the sweep already running', async () => {
    const { dir } = await tempPaths()
    let requests = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      send: async () => {
        requests += 1
        await gate
        return { status: 200, streamed: true }
      },
    })
    const first = service.checkAll('deepseek-v4.1-flash')
    const second = service.checkAll('deepseek-v4.1-flash')
    expect(service.isRunning()).toBe(true)
    release?.()
    // Two clicks, one set of upstream requests: a competing sweep would be the
    // most likely way to earn a 429 and lose the answer entirely.
    expect(await first).toBe(await second)
    expect(requests).toBe(1)
  })

  it('keeps credential-shaped text out of the reported reason', async () => {
    const { dir } = await tempPaths()
    const path = join(dir, 'check.json')
    const service = new WorkBuddyQuotaCheckService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      checks: new WorkBuddyQuotaCheckStore({ path }),
      send: async () => ({
        status: 500,
        streamed: false,
        detail: 'upstream echoed access_token=abc123def456 back',
      }),
    })
    const outcome = await service.checkAll('deepseek-v4.1-flash')
    expect(outcome.results[0]?.reason).toContain('[redacted]')
    expect(outcome.results[0]?.reason).not.toContain('abc123def456')
    const persisted = await readFile(path, 'utf8')
    expect(persisted).not.toContain('abc123def456')
  })

  it('answers an empty sweep when the host has no slot store', async () => {
    const { dir } = await tempPaths()
    const service = new WorkBuddyQuotaCheckService({
      accounts: undefined,
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      send: async () => ({ status: 200, streamed: true }),
    })
    const outcome = await service.checkAll('deepseek-v4.1-flash')
    expect(outcome.results).toEqual([])
  })

  it('answers an empty sweep rather than throwing when the slots are unreadable', async () => {
    const { dir } = await tempPaths()
    const service = new WorkBuddyQuotaCheckService({
      accounts: {
        list: async () => { throw new Error('slot directory unreadable') },
      } as unknown as WorkBuddyAccountStore,
      quota: new WorkBuddyQuotaStore({ path: join(dir, 'quota.json') }),
      send: async () => ({ status: 200, streamed: true }),
    })
    expect((await service.checkAll('deepseek-v4.1-flash')).results).toEqual([])
  })
})
