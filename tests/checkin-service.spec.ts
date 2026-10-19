import { describe, expect, it } from 'vitest'
import { WorkBuddyCheckinService, CHECKIN_MAX_ACCOUNTS } from '../src/checkin-service.ts'
import type { WorkBuddyCheckinTransports } from '../src/checkin-service.ts'
import type { WorkBuddyAccountSlot, WorkBuddyAccountStore } from '../src/accounts-store.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyCheckinClaim, WorkBuddyCheckinStatus } from '../src/checkin.ts'

/**
 * The daily check-in sweep.
 *
 * The behaviours worth pinning are the ones that decide whether a press costs
 * money it should not: the status read always comes first, only `claimable`
 * accounts are claimed, and a sweep never claims on an answer it could not read.
 */

function credential(uid: string): WorkBuddyCredential {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid,
    source: 'dsh',
  }
}

function slot(id: string, uid: string, label?: string): WorkBuddyAccountSlot {
  return {
    id,
    ...label === undefined ? {} : { label },
    addedAtMs: 0,
    updatedAtMs: 0,
    credential: credential(uid),
  }
}

function accountsOf(slots: readonly WorkBuddyAccountSlot[]): WorkBuddyAccountStore {
  return { list: async () => [...slots] } as unknown as WorkBuddyAccountStore
}

/** Transports that answer per account from a table, and record the order. */
function transports(
  statuses: Record<string, WorkBuddyCheckinStatus>,
  claims: Record<string, WorkBuddyCheckinClaim> = {},
  calls: string[] = [],
): WorkBuddyCheckinTransports {
  return {
    status: async (cred) => {
      calls.push(`status:${cred.uid}`)
      return statuses[cred.uid] ?? { state: 'unknown', reason: 'no fixture' }
    },
    claim: async (cred) => {
      calls.push(`claim:${cred.uid}`)
      return claims[cred.uid] ?? { state: 'claimed', credit: 100 }
    },
  }
}

describe('WorkBuddyCheckinService', () => {
  it('reads every parked account and claims only the claimable ones', async () => {
    const calls: string[] = []
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1', '一号'), slot('acct-2', 'uid-2'), slot('acct-3', 'uid-3')]),
      region: 'cn',
      transports: transports({
        'uid-1': { state: 'claimable', dailyCredit: 100 },
        'uid-2': { state: 'checked-in', dailyCredit: 100 },
        'uid-3': { state: 'unavailable' },
      }, {
        'uid-1': { state: 'claimed', credit: 100, streakDays: 2 },
      }, calls),
    })
    const sweep = await service.sweepAll()

    // Status first for everyone; exactly one claim, for the one account that
    // said it still had something to take.
    expect(calls).toEqual(['status:uid-1', 'claim:uid-1', 'status:uid-2', 'status:uid-3'])
    expect(sweep.rows.map(row => ({ id: row.id, status: row.status, outcome: row.outcome }))).toEqual([
      { id: 'acct-1', status: 'claimable', outcome: 'claimed' },
      { id: 'acct-2', status: 'checked-in', outcome: 'skipped' },
      { id: 'acct-3', status: 'unavailable', outcome: 'skipped' },
    ])
    expect(sweep.rows[0]).toMatchObject({ label: '一号', credit: 100, streakDays: 2 })
  })

  it('never claims an account whose state could not be read', async () => {
    const calls: string[] = []
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      region: 'global',
      transports: transports({
        'uid-1': { state: 'unknown', reason: 'status 500' },
      }, {}, calls),
    })
    const sweep = await service.sweepAll()
    // A blind claim would be a write made on a guess.
    expect(calls).toEqual(['status:uid-1'])
    expect(sweep.rows[0]).toEqual({
      id: 'acct-1',
      status: 'unknown',
      outcome: 'failed',
      reason: 'status 500',
    })
  })

  it('treats a "already taken" refusal as a skip, not a failure', async () => {
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      region: 'cn',
      transports: transports(
        { 'uid-1': { state: 'claimable' } },
        { 'uid-1': { state: 'already', reason: 'today already checked in' } },
      ),
    })
    const sweep = await service.sweepAll()
    expect(sweep.rows[0]).toMatchObject({ status: 'checked-in', outcome: 'skipped', reason: 'today already checked in' })
  })

  it('reports a refused claim with the upstream reason', async () => {
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      region: 'cn',
      transports: transports(
        { 'uid-1': { state: 'claimable' } },
        { 'uid-1': { state: 'failed', reason: 'activity ended' } },
      ),
    })
    const sweep = await service.sweepAll()
    expect(sweep.rows[0]).toMatchObject({ outcome: 'failed', reason: 'activity ended' })
  })

  it('degrades an unreadable slot store to an empty sweep instead of throwing', async () => {
    const service = new WorkBuddyCheckinService({
      accounts: { list: async () => { throw new Error('ENOENT') } } as unknown as WorkBuddyAccountStore,
      region: 'cn',
      transports: transports({}),
    })
    await expect(service.sweepAll()).resolves.toMatchObject({ rows: [] })
  })

  it('caps a sweep so a pathological store cannot fan out unbounded', async () => {
    const calls: string[] = []
    const slots = Array.from({ length: CHECKIN_MAX_ACCOUNTS + 3 }, (_, index) => slot(`acct-${index}`, `uid-${index}`))
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf(slots),
      region: 'cn',
      transports: transports({}, {}, calls),
    })
    const sweep = await service.sweepAll()
    expect(sweep.rows).toHaveLength(CHECKIN_MAX_ACCOUNTS)
    expect(calls).toHaveLength(CHECKIN_MAX_ACCOUNTS)
  })

  it('shares one in-flight sweep between two presses', async () => {
    let statusCalls = 0
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      region: 'cn',
      transports: {
        status: async () => { statusCalls += 1; return { state: 'unavailable' } },
        claim: async () => ({ state: 'claimed' }),
      },
    })
    const [first, second] = await Promise.all([service.sweepAll(), service.sweepAll()])
    expect(statusCalls).toBe(1)
    expect(first).toBe(second)
  })

  it('keeps the last sweep readable after it finishes', async () => {
    const service = new WorkBuddyCheckinService({
      accounts: accountsOf([slot('acct-1', 'uid-1')]),
      region: 'cn',
      transports: transports({ 'uid-1': { state: 'unavailable' } }),
    })
    expect(service.lastOutcome()).toBeUndefined()
    expect(service.isRunning()).toBe(false)
    const sweep = await service.sweepAll()
    expect(service.lastOutcome()).toBe(sweep)
    expect(service.isRunning()).toBe(false)
  })
})
