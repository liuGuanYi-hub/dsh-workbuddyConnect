import { describe, expect, it } from 'vitest'
import {
  decideAutoSwitch,
  decideRefusalSwitch,
  AUTO_SWITCH_DEFAULT_THRESHOLD,
  type AutoSwitchObservation,
} from '../src/auto-switch.ts'

/**
 * The automatic-switch decision.
 *
 * These are the rules that decide whether the plugin moves a user off an
 * account, so each case here corresponds to a way that decision could be wrong
 * in a way the user would feel: rotating on an unreadable balance, rotating into
 * an account that is no better off, or refusing to move off an account the
 * upstream has already rejected.
 */

/**
 * Build one observation.
 *
 * `remaining` accepts an explicit `undefined`, and the key is then omitted from
 * the result. That distinction matters here more than anywhere else in the
 * suite: the project compiles with `exactOptionalPropertyTypes`, and "absent"
 * is precisely the state the decider reads as *unreadable* — which must never
 * be confused with a zero balance.
 */
function observation(
  overrides: Omit<Partial<AutoSwitchObservation>, 'remaining'> & { id: string, remaining?: number | undefined },
): AutoSwitchObservation {
  const { remaining, ...rest } = overrides
  return {
    active: false,
    ...rest,
    ...remaining === undefined ? {} : { remaining },
  } as AutoSwitchObservation
}

describe('decideAutoSwitch', () => {
  it('stays when the feature is off, whatever the balances say', () => {
    const decision = decideAutoSwitch({
      enabled: false,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 1 }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'disabled' })
  })

  it('stays above the threshold', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 50 }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'active-above-threshold', activeRemaining: 50 })
  })

  it('switches exactly at the threshold, to the richest account', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 49 }),
        observation({ id: 'b', remaining: 120 }),
        observation({ id: 'c', remaining: 5592 }),
      ],
    })
    expect(decision).toEqual({
      action: 'switch',
      reason: 'active-below-threshold',
      targetId: 'c',
      activeRemaining: 49,
      targetRemaining: 5592,
    })
  })

  it('never switches on an unreadable active balance', () => {
    // A failed billing read must not be read as exhaustion: rotating here would
    // burn an account to fix a network blip.
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: undefined }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'active-balance-unknown' })
  })

  it('never switches to an account whose balance is unknown', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 10 }),
        observation({ id: 'b', remaining: undefined }),
      ],
    })
    expect(decision.action).toBe('stay')
    expect(decision.reason).toBe('nothing-to-gain')
  })

  it('refuses candidates that do not clear the threshold, even when better than the active one', () => {
    // Every other account is also at or below the threshold, so the move would
    // leave the user on a nearly-empty account with a fresh session.
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 10 }),
        observation({ id: 'b', remaining: 49 }),
        observation({ id: 'c', remaining: 20 }),
      ],
    })
    expect(decision.action).toBe('stay')
    expect(decision.reason).toBe('no-better-account')
  })

  it('prefers the richest of several usable candidates', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 49 }),
        observation({ id: 'b', remaining: 51 }),
        observation({ id: 'c', remaining: 900 }),
      ],
    })
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('c')
  })

  it('skips an expired candidate even when it holds the most credit', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 5 }),
        observation({ id: 'expired', remaining: 99_999, expired: true }),
        observation({ id: 'ok', remaining: 300 }),
      ],
    })
    expect(decision.action).toBe('switch')
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('ok')
  })

  it('skips a candidate the upstream already refused', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 5 }),
        observation({ id: 'refused', remaining: 80_000, exhausted: true }),
        observation({ id: 'ok', remaining: 200 }),
      ],
    })
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('ok')
  })

  it('treats an uncapped active account as never below threshold', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, unlimited: true, remaining: 3 }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'active-unlimited' })
  })

  it('ranks an uncapped candidate ahead of a large numeric one', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 1 }),
        observation({ id: 'big', remaining: 1_000_000 }),
        observation({ id: 'unlimited', unlimited: true }),
      ],
    })
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('unlimited')
  })

  it('honours the cooldown for a low-but-unrefused account', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: true,
      observations: [
        observation({ id: 'a', active: true, remaining: 10 }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'cooldown', activeRemaining: 10 })
  })

  it('switches off a refused account even during the cooldown', () => {
    // A refused account cannot serve the next request at all, so waiting out
    // the timer would only spread the failure over more turns.
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: true,
      observations: [
        observation({ id: 'a', active: true, remaining: 0, exhausted: true }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision.action).toBe('switch')
    expect(decision.action === 'switch' ? decision.reason : undefined).toBe('active-exhausted')
  })

  it('switches off a refused account whose balance could not be read', () => {
    // The refusal is stronger evidence than a missing balance.
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, exhausted: true, remaining: undefined }),
        observation({ id: 'b', remaining: 9000 }),
      ],
    })
    expect(decision.action).toBe('switch')
  })

  it('stays when there are no parked accounts', () => {
    expect(decideAutoSwitch({ enabled: true, threshold: 49, coolingDown: false, observations: [] }))
      .toEqual({ action: 'stay', reason: 'no-accounts' })
  })

  it('stays when no account is marked active', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [observation({ id: 'a', remaining: 1 }), observation({ id: 'b', remaining: 9 })],
    })
    expect(decision).toEqual({ action: 'stay', reason: 'no-active-account' })
  })

  it('refuses a candidate from the other product', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      region: 'cn',
      observations: [
        observation({ id: 'a', active: true, remaining: 5, domain: 'www.codebuddy.cn' }),
        observation({ id: 'global', remaining: 9000, domain: 'www.workbuddy.ai' }),
        observation({ id: 'cn', remaining: 300, domain: 'www.codebuddy.cn' }),
      ],
    })
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('cn')
  })

  it('breaks ties on slot id so the same store always switches the same way', () => {
    const decision = decideAutoSwitch({
      enabled: true,
      threshold: 49,
      coolingDown: false,
      observations: [
        observation({ id: 'a', active: true, remaining: 1 }),
        observation({ id: 'zeta', remaining: 500 }),
        observation({ id: 'alpha', remaining: 500 }),
      ],
    })
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('alpha')
  })

  it('uses the exported default threshold rather than a literal', () => {
    expect(AUTO_SWITCH_DEFAULT_THRESHOLD).toBe(49)
  })
})

describe('decideRefusalSwitch', () => {
  it('moves off the refused account to the richest other one', () => {
    const decision = decideRefusalSwitch({
      enabled: true,
      observations: [
        observation({ id: 'a', active: true, exhausted: true, remaining: 0 }),
        observation({ id: 'b', remaining: 400 }),
        observation({ id: 'c', remaining: 2500 }),
      ],
    })
    expect(decision.action).toBe('switch')
    expect(decision.action === 'switch' ? decision.targetId : undefined).toBe('c')
    expect(decision.action === 'switch' ? decision.reason : undefined).toBe('active-exhausted')
  })

  it('stays when it is off', () => {
    expect(decideRefusalSwitch({
      enabled: false,
      observations: [observation({ id: 'a', active: true, exhausted: true }), observation({ id: 'b' })],
    })).toEqual({ action: 'stay', reason: 'disabled' })
  })

  it('stays when every other account is unusable', () => {
    const decision = decideRefusalSwitch({
      enabled: true,
      observations: [
        observation({ id: 'a', active: true, exhausted: true }),
        observation({ id: 'b', remaining: undefined }),
        observation({ id: 'c', remaining: 20 }),
        observation({ id: 'd', expired: true, remaining: 9000 }),
      ],
    })
    expect(decision.action).toBe('stay')
    expect(decision.reason).toBe('no-better-account')
  })
})
