import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyAutoSwitchService } from '../src/auto-switch-service.ts'
import type { WorkBuddyAccountSlot, WorkBuddyAccountStore } from '../src/accounts-store.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyQuotaStore } from '../src/quota-state.ts'
import type { WorkBuddyCredits } from '../src/upstream.ts'

/**
 * The automatic-switch service.
 *
 * The decision rules are covered in `auto-switch.spec.ts`; what is pinned here
 * is everything the decision cannot see — that a failed read never switches,
 * that a switch goes through the same pointer the manual control uses, that the
 * cooldown is measured from a *successful* switch, and that none of this ever
 * throws into the caller's chat path.
 */

function credential(uid: string, overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid,
    source: 'dsh',
    ...overrides,
  }
}

function slot(id: string, uid: string, label?: string, overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyAccountSlot {
  return {
    id,
    ...label === undefined ? {} : { label },
    addedAtMs: 0,
    updatedAtMs: 0,
    credential: credential(uid, overrides),
  }
}

/** A slot store that records the active pointer and every write to it. */
function storeOf(slots: readonly WorkBuddyAccountSlot[], activeId: string): {
  store: WorkBuddyAccountStore
  switches: string[]
  setActive: (id: string) => Promise<void>
} {
  const switches: string[] = []
  let current = activeId
  const setActive = vi.fn(async (id: string) => {
    switches.push(id)
    current = id
  })
  const store = {
    list: async () => [...slots],
    activeId: async () => current,
    setActive,
  } as unknown as WorkBuddyAccountStore
  return { store, switches, setActive: setActive as unknown as (id: string) => Promise<void> }
}

/** A billing reader answering from a table keyed by uid. */
function reader(table: Record<string, number | 'error' | 'unlimited'>) {
  return async (credential: WorkBuddyCredential): Promise<WorkBuddyCredits> => {
    const value = table[credential.uid]
    if (value === undefined || value === 'error') throw new Error(`billing unavailable for ${credential.uid}`)
    if (value === 'unlimited') return { total: 0, accounts: [], unlimited: true }
    return { total: value, accounts: [] }
  }
}

describe('WorkBuddyAutoSwitchService', () => {
  it('switches to the richest account when the served one is at the threshold', async () => {
    const { store, switches } = storeOf([
      slot('acct-a', 'uid-a', '甲'),
      slot('acct-b', 'uid-b', '乙'),
      slot('acct-c', 'uid-c', '丙'),
    ], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 49, 'uid-b': 120, 'uid-c': 5592 }),
      enabled: () => true,
    })
    const sweep = await service.sweep()
    expect(sweep.decision.action).toBe('switch')
    expect(switches).toEqual(['acct-c'])
    expect(sweep.switched).toBe(true)
    expect(service.totalSwitches()).toBe(1)
    expect(service.lastSwitchRecord()).toMatchObject({
      fromId: 'acct-a',
      toId: 'acct-c',
      reason: 'active-below-threshold',
      fromRemaining: 49,
      toRemaining: 5592,
    })
  })

  it('does nothing when the feature is off', async () => {
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      // Both balances are read — a sweep still reports them — but nothing moves.
      readCredits: reader({ 'uid-a': 1, 'uid-b': 9000 }),
      enabled: () => false,
    })
    const sweep = await service.sweep()
    expect(sweep.decision).toEqual({ action: 'stay', reason: 'disabled' })
    expect(switches).toEqual([])
    expect(sweep.rows.map(row => row.remaining)).toEqual([1, 9000])
  })

  it('never switches when the served balance could not be read', async () => {
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 'error', 'uid-b': 9000 }),
      enabled: () => true,
    })
    const sweep = await service.sweep()
    expect(sweep.decision).toEqual({ action: 'stay', reason: 'active-balance-unknown' })
    expect(switches).toEqual([])
    // The failure stays visible in the row rather than hiding the account.
    expect(sweep.rows[0]?.error).toContain('billing unavailable')
    expect(sweep.rows[0]?.remaining).toBeUndefined()
  })

  it('reports a row for every account even when every read fails', async () => {
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({}),
      enabled: () => true,
    })
    const sweep = await service.sweep()
    expect(sweep.rows).toHaveLength(2)
    expect(sweep.rows.every(row => row.error !== undefined)).toBe(true)
    expect(switches).toEqual([])
  })

  it('suppresses a second balance-driven switch during the cooldown', async () => {
    // The served account stays below the threshold, and a healthy account is
    // always available — so the *only* thing that can stop a repeat move is the
    // cooldown itself.
    let active = 'acct-b'
    const switches: string[] = []
    const store = {
      list: async () => [slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')],
      activeId: async () => active,
      setActive: async (id: string) => {
        switches.push(id)
        active = id
      },
    } as unknown as WorkBuddyAccountStore
    // Whoever is served keeps a low balance, so the decider always wants to move.
    const readCredits = async (credential: WorkBuddyCredential): Promise<WorkBuddyCredits> =>
      ({ total: credential.uid === active.replace('acct-', 'uid-') ? 1 : 9000, accounts: [] })
    let now = 1_000_000
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits,
      enabled: () => true,
      cooldownMs: 60_000,
      now: () => now,
    })

    const first = await service.sweep()
    expect(first.switched).toBe(true)
    expect(switches).toEqual(['acct-a'])

    // One second later the served (now acct-a) account is still drained and
    // acct-b is healthy: without the cooldown this would move straight back.
    now += 1_000
    const blocked = await service.sweep()
    expect(blocked.decision).toEqual({ action: 'stay', reason: 'cooldown', activeRemaining: 1 })
    expect(blocked.switched).toBe(false)
    expect(switches).toEqual(['acct-a'])

    // Past the cooldown the very same conditions do move it.
    now += 120_000
    const allowed = await service.sweep()
    expect(allowed.switched).toBe(true)
    expect(switches).toEqual(['acct-a', 'acct-b'])
  })

  it('does not advance the cooldown when the switch write fails', async () => {
    const switches: string[] = []
    let failNext = true
    const store = {
      list: async () => [slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')],
      activeId: async () => 'acct-a',
      setActive: async (id: string) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        switches.push(id)
      },
    } as unknown as WorkBuddyAccountStore
    let now = 5_000
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 1, 'uid-b': 9000 }),
      enabled: () => true,
      cooldownMs: 600_000,
      now: () => now,
    })
    const failed = await service.sweep()
    expect(failed.switched).toBe(false)
    expect(failed.switchError).toContain('disk full')
    expect(service.totalSwitches()).toBe(0)

    // A refused write must not block the next attempt: the account never moved.
    now += 1_000
    const retried = await service.sweep()
    expect(retried.switched).toBe(true)
    expect(switches).toEqual(['acct-b'])
  })

  it('serialises concurrent sweeps into one', async () => {
    let reads = 0
    const { store } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: async (credential) => {
        reads += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return { total: credential.uid === 'uid-a' ? 1 : 9000, accounts: [] }
      },
      enabled: () => true,
    })
    const [first, second] = await Promise.all([service.sweep(), service.sweep()])
    expect(first).toBe(second)
    // Two accounts, read once each — not twice each.
    expect(reads).toBe(2)
  })

  it('skips an account whose stored token already expired', async () => {
    const { store, switches } = storeOf([
      slot('acct-a', 'uid-a'),
      slot('acct-dead', 'uid-dead', '过期', { expiresAtMs: Date.now() - 60_000 }),
      slot('acct-b', 'uid-b'),
    ], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      // The expired slot holds the most credit, so only the expiry rule can
      // keep it from being chosen.
      readCredits: reader({ 'uid-a': 5, 'uid-dead': 99_999, 'uid-b': 300 }),
      enabled: () => true,
    })
    await service.sweep()
    expect(switches).toEqual(['acct-b'])
  })

  it('skips an account carrying a live refusal verdict', async () => {
    const quota = {
      isExhausted: (account: string | undefined) => account === 'uid-b:',
    } as unknown as WorkBuddyQuotaStore
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 5, 'uid-b': 9000 }),
      quota,
      enabled: () => true,
    })
    const sweep = await service.sweep()
    expect(sweep.decision.action).toBe('stay')
    expect(switches).toEqual([])
  })

  it('refuses a candidate from the other product', async () => {
    const { store, switches } = storeOf([
      slot('acct-a', 'uid-a'),
      slot('acct-ai', 'uid-ai', '国际', { domain: 'www.workbuddy.ai' }),
      slot('acct-b', 'uid-b'),
    ], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 5, 'uid-ai': 500_000, 'uid-b': 300 }),
      region: 'cn',
      enabled: () => true,
    })
    await service.sweep()
    expect(switches).toEqual(['acct-b'])
  })

  it('reports an uncapped account as unlimited rather than as a number', async () => {
    const { store } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 5, 'uid-b': 'unlimited' }),
      enabled: () => true,
    })
    const sweep = await service.sweep()
    const row = sweep.rows.find(candidate => candidate.id === 'acct-b')
    expect(row?.unlimited).toBe(true)
    expect(row?.remaining).toBeUndefined()
  })

  it('switches off a refused account and reports the record', async () => {
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 0, 'uid-b': 800 }),
      enabled: () => true,
    })
    const record = await service.onRefusal('uid-a:')
    expect(record).toMatchObject({ fromId: 'acct-a', toId: 'acct-b', reason: 'active-exhausted' })
    expect(switches).toEqual(['acct-b'])
  })

  it('does nothing on a refusal when the feature is off', async () => {
    const { store, switches } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-b': 800 }),
      enabled: () => false,
    })
    expect(await service.onRefusal('uid-a:')).toBeUndefined()
    expect(switches).toEqual([])
  })

  it('never throws out of onRefusal, whatever the store does', async () => {
    const store = {
      list: async () => { throw new Error('store exploded') },
      activeId: async () => 'acct-a',
      setActive: async () => {},
    } as unknown as WorkBuddyAccountStore
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({}),
      enabled: () => true,
    })
    await expect(service.onRefusal('uid-a:')).resolves.toBeUndefined()
  })

  it('calls onChange after a landed switch so the host re-resolves', async () => {
    const { store } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    let changes = 0
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 1, 'uid-b': 900 }),
      enabled: () => true,
      onChange: () => { changes += 1 },
    })
    await service.sweep()
    expect(changes).toBe(1)
  })

  it('still reports the switch when onChange throws', async () => {
    const { store } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader({ 'uid-a': 1, 'uid-b': 900 }),
      enabled: () => true,
      onChange: () => { throw new Error('invalidate blew up') },
    })
    const sweep = await service.sweep()
    // The pointer already moved on disk; the hook is best-effort.
    expect(sweep.switched).toBe(true)
  })

  it('caps how many slots one sweep will read', async () => {
    const slots = Array.from({ length: 15 }, (_, index) => slot(`acct-${index}`, `uid-${index}`))
    const { store } = storeOf(slots, 'acct-0')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: reader(Object.fromEntries(slots.map((entry, index) => [`uid-${index}`, 100 + index]))),
      enabled: () => true,
      maxAccounts: 3,
    })
    const sweep = await service.sweep()
    expect(sweep.rows).toHaveLength(3)
  })

  it('sanitises token-shaped content out of a read failure', async () => {
    const { store } = storeOf([slot('acct-a', 'uid-a'), slot('acct-b', 'uid-b')], 'acct-a')
    const service = new WorkBuddyAutoSwitchService({
      accounts: store,
      readCredits: async () => {
        throw new Error('rejected token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
      },
      enabled: () => true,
    })
    const sweep = await service.sweep()
    expect(sweep.rows[0]?.error).toContain('[redacted token]')
    expect(sweep.rows[0]?.error).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })
})
