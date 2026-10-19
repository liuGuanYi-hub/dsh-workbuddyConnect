/**
 * Deciding *whether* and *where* to move off a nearly-spent WorkBuddy account.
 *
 * The plugin already had two answers to "this account has nothing left", and
 * neither one is the answer this module gives:
 *
 * - `quota-state` records a refusal **after** the upstream has already thrown a
 *   request away, so by the time it knows, the user has lost a turn.
 * - `quota-check` asks each account to *spend* a request (`max_tokens: 1`) to
 *   prove it can still serve, which is far too expensive to run on a schedule.
 *
 * The billing endpoint answers the third question — how much credit is left —
 * for **free** and for **every** parked account, not only the served one. That
 * is what makes automatic switching affordable: a sweep costs five HTTP reads
 * and no chat quota at all.
 *
 * So this module is deliberately pure: it is handed one observation per
 * account and returns a decision, with no I/O, no timers, and no knowledge of
 * how a switch is performed. Everything that could be wrong about *acting* on
 * that decision lives in `auto-switch-service.ts`; everything that could be
 * wrong about *choosing* lives here, where it can be tested exhaustively.
 *
 * Four rules this decision obeys, each of which had to be a rule because the
 * tempting alternative is actively harmful:
 *
 * 1. **Never switch on an unreadable balance.** A failed billing read says
 *    nothing about whether the account is spent. Treating it as "spent" would
 *    rotate accounts every time the network hiccups, burning through accounts
 *    that were fine.
 * 2. **Never treat "low" as "empty".** The threshold is a *precaution*, not an
 *    exhaustion verdict, and the two are reported differently so the card can
 *    say "nearly out" rather than lying about the current request having
 *    failed.
 * 3. **Never switch to an account that is not strictly better off.** A move
 *    that leaves the user on an account just as close to empty only loses the
 *    session's continuity.
 * 4. **Never cross products.** Slots are already per-variant, but the decider
 *    still refuses a candidate whose region differs: a CN token sent to the
 *    international endpoint is refused, and the plugin's own credential store
 *    treats exactly that mismatch as an error.
 *
 * @module dsh-workbuddy-connect/auto-switch
 */

import type { WorkBuddyRegion } from './upstream.ts'
import { regionOf } from './upstream.ts'

/**
 * Remaining credit at or below which an account counts as "nearly spent".
 *
 * The user's own number. It is a *precautionary* floor, not a claim about what
 * the upstream will refuse: a request can still be served at 49, and the point
 * of switching early is to avoid the turn that gets refused instead. It is
 * exported so the card can show the number it is acting on rather than an
 * unexplained jump.
 */
export const AUTO_SWITCH_DEFAULT_THRESHOLD = 49

/**
 * Shortest interval between two automatic switches, in milliseconds.
 *
 * Without one, two accounts sitting either side of the threshold ping-pong: the
 * decider is correct on every individual call and the aggregate behaviour is
 * still nonsense. Ten minutes is long enough that a real working session
 * produces at most a handful of moves, and short enough that an account that
 * really has emptied is still abandoned promptly.
 */
export const AUTO_SWITCH_DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

/** How many slots one balance sweep will read before giving up. */
export const AUTO_SWITCH_MAX_ACCOUNTS = 10

/** One account, as the balance sweep observed it. */
export interface AutoSwitchObservation {
  /** Slot id, as `accounts use <id>` addresses it. */
  id: string
  /** The label the user gave it, when they gave one. */
  label?: string
  /** Whether this is the account currently being served. */
  active: boolean
  /**
   * Remaining credit in the upstream's own unit, or `undefined` when the read
   * failed. Undefined is *not* zero — see rule 1 in the module docs.
   */
  remaining?: number
  /**
   * The account's cycle quota is uncapped.
   *
   * A separate flag rather than a huge `remaining`: the upstream reports
   * "no limit" as `limitNum === -1`, and any arithmetic on that sentinel
   * produces a plausible-looking number that means the opposite thing.
   */
  unlimited?: boolean
  /** The upstream has refused this account for insufficient credit. */
  exhausted?: boolean
  /** The account's stored access token is already expired. */
  expired?: boolean
  /** The credential's domain, used only to refuse a cross-product candidate. */
  domain?: string
}

/** Why the decider chose to stay. */
export type AutoSwitchStayReason =
  /** The feature is off (the default). */
  | 'disabled'
  /** No parked accounts at all: nothing to switch to, and nothing to switch from. */
  | 'no-accounts'
  /** The served account could not be identified among the slots. */
  | 'no-active-account'
  /** The current account's balance could not be read, so "nearly spent" is unproven. */
  | 'active-balance-unknown'
  /** The current account is above the threshold. */
  | 'active-above-threshold'
  /** The current account is uncapped, so a threshold cannot apply to it. */
  | 'active-unlimited'
  /** A switch happened too recently (see {@link AUTO_SWITCH_DEFAULT_COOLDOWN_MS}). */
  | 'cooldown'
  /** Every other account is also at or below the threshold, or unreadable. */
  | 'no-better-account'
  /** The current account is at or below threshold but no move would help. */
  | 'nothing-to-gain'

/** Why the decider chose to switch. */
export type AutoSwitchMoveReason =
  /** The current account is at or below the threshold. */
  | 'active-below-threshold'
  /** The upstream has already refused the current account. */
  | 'active-exhausted'

/** The decision, as a closed union so callers cannot read fields that do not apply. */
export type AutoSwitchDecision =
  | {
    action: 'stay'
    reason: AutoSwitchStayReason
    /** The served account's remaining credit, when it was readable. */
    activeRemaining?: number
  }
  | {
    action: 'switch'
    reason: AutoSwitchMoveReason
    /** The slot to serve from now on. */
    targetId: string
    /** The target's display name, for the card and the log line. */
    targetLabel?: string
    /** The served account's remaining credit, when it was readable. */
    activeRemaining?: number
    /** The target's remaining credit, when the caller could read one. */
    targetRemaining?: number
  }

/** What a decision needs to know. */
export interface AutoSwitchInput {
  /** Whether the feature is enabled. Off unless the user turned it on. */
  enabled: boolean
  /** Remaining credit at or below which the served account is abandoned. */
  threshold: number
  /** Whether the cooldown is still running. The service owns the clock. */
  coolingDown: boolean
  /** One entry per parked account, in slot order. */
  observations: readonly AutoSwitchObservation[]
  /**
   * This variant's region.
   *
   * Optional only for callers that assembled their own descriptors; when given,
   * it is enforced on the candidate's `domain` so a CN slot can never be
   * selected to serve the international endpoint.
   */
  region?: WorkBuddyRegion
}

/** Whether one observation could serve as the new account. */
function eligible(
  observation: AutoSwitchObservation,
  active: AutoSwitchObservation,
  threshold: number,
  region: WorkBuddyRegion | undefined,
): boolean {
  // The account it is asked to replace.
  if (observation.id === active.id) return false
  // An expired token cannot serve anything until it is refreshed, and a
  // switch to one would trade "nearly out of credit" for "signed out".
  if (observation.expired === true) return false
  // A live refusal is stronger evidence than a balance: the upstream has
  // already said no, whatever the billing document claims.
  if (observation.exhausted === true) return false
  // An uncapped account can serve any request, so none of the numeric tests
  // below apply to it — and it carries no `remaining` by construction (the
  // upstream reports "no cap" as a sentinel, which must never be arithmetic).
  // Checked before the balance rules, or the "absent balance" rule would reject
  // the single best candidate there is.
  if (observation.unlimited === true) {
    if (region !== undefined && observation.domain !== undefined) {
      return regionOf(observation.domain) === region
    }
    return true
  }
  // Unreadable balance: rule 1 — unknown is never treated as usable.
  if (observation.remaining === undefined) return false
  // Rule 3: the replacement must be strictly better off than the account it
  // replaces, and safely clear of the threshold on its own merits. The first
  // half is what makes a move worth its interruption; the second is what stops
  // a candidate from being "the best of several nearly-empty accounts".
  //
  // `>` rather than `>=` on the current balance: a candidate merely equal to a
  // half-spent account buys nothing but continuity loss. Note this also
  // subsumes the threshold test whenever the current balance is at or below it,
  // which is the only case that reaches here.
  if (observation.remaining <= threshold) return false
  if (observation.remaining <= (active.remaining ?? 0)) return false
  // Rule 4: never hand this product's endpoint a credential from the other one.
  if (region !== undefined && observation.domain !== undefined) {
    if (regionOf(observation.domain) !== region) return false
  }
  return true
}

/**
 * Decide whether the served account should be abandoned, and for which one.
 *
 * Pure: same input, same output, no clock and no I/O. The caller supplies
 * `coolingDown` rather than a timestamp pair precisely so the cooldown rule can
 * be tested without waiting ten minutes.
 */
export function decideAutoSwitch(input: AutoSwitchInput): AutoSwitchDecision {
  if (!input.enabled) return { action: 'stay', reason: 'disabled' }
  if (input.observations.length === 0) return { action: 'stay', reason: 'no-accounts' }

  const active = input.observations.find(observation => observation.active)
  if (active === undefined) {
    return { action: 'stay', reason: 'no-active-account' }
  }
  const activeRemaining = active.remaining

  // An uncapped account has no threshold to fall below. Reported before the
  // balance checks so a `unlimited` account with a coincidentally small
  // `remaining` is never abandoned.
  if (active.unlimited === true) {
    return { action: 'stay', reason: 'active-unlimited' }
  }

  // A recorded refusal is the strongest signal available and does not need a
  // balance to be believable: the upstream already answered "no". It is checked
  // before the cooldown because staying on a refused account is never useful.
  const refused = active.exhausted === true

  if (!refused) {
    if (activeRemaining === undefined) {
      return { action: 'stay', reason: 'active-balance-unknown' }
    }
    if (activeRemaining > input.threshold) {
      return { action: 'stay', reason: 'active-above-threshold', activeRemaining }
    }
  }

  // From here the served account is either refused or at/below the threshold.
  // The cooldown deliberately does not apply to a *refused* account: that
  // account cannot serve the next request at all, so waiting out the timer
  // would only spread the failure across more turns.
  if (input.coolingDown && !refused) {
    return {
      action: 'stay',
      reason: 'cooldown',
      ...activeRemaining === undefined ? {} : { activeRemaining },
    }
  }

  const candidates = input.observations.filter(observation =>
    eligible(observation, active, input.threshold, input.region))

  if (candidates.length === 0) {
    return {
      action: 'stay',
      // With no observation readable at all, "no better account" would be a
      // claim the sweep cannot support; the honest difference matters to the
      // card, which says "all parked accounts are also nearly spent" for the
      // first and "could not read the others" for the second.
      reason: input.observations.some(observation =>
        observation.id !== active.id && observation.remaining !== undefined)
        ? 'no-better-account'
        : 'nothing-to-gain',
      ...activeRemaining === undefined ? {} : { activeRemaining },
    }
  }

  // Richest first: the point of switching is to buy the longest possible run
  // before the next switch, and `remaining` is the only measure of that the
  // billing endpoint actually provides. Ties break on slot id so the choice is
  // deterministic and a given store always switches the same way.
  //
  // An `unlimited` candidate can never tie with a numeric one; it is ranked
  // ahead explicitly rather than by substituting a sentinel number.
  const best = [...candidates].sort((left, right) => {
    const leftUnlimited = left.unlimited === true ? 1 : 0
    const rightUnlimited = right.unlimited === true ? 1 : 0
    if (leftUnlimited !== rightUnlimited) return rightUnlimited - leftUnlimited
    const delta = (right.remaining ?? 0) - (left.remaining ?? 0)
    if (delta !== 0) return delta
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })[0] as AutoSwitchObservation

  return {
    action: 'switch',
    reason: refused ? 'active-exhausted' : 'active-below-threshold',
    targetId: best.id,
    ...best.label === undefined ? {} : { targetLabel: best.label },
    ...activeRemaining === undefined ? {} : { activeRemaining },
    ...best.remaining === undefined ? {} : { targetRemaining: best.remaining },
  }
}

/**
 * Decide whether a *failed* chat request should immediately abandon its account.
 *
 * This is the second trigger, and it answers a different question from
 * {@link decideAutoSwitch}: not "is this account running low" but "the upstream
 * has just refused this account *right now*". It exists because the billing
 * sweep runs on a timer, and a capped free tier can empty between two sweeps —
 * the refusal is the earliest honest evidence, exactly as `quota-state` argues.
 *
 * Deliberately narrower than the balance path: it never consults a threshold,
 * because there is nothing to weigh. The request already failed.
 */
export function decideRefusalSwitch(input: {
  enabled: boolean
  observations: readonly AutoSwitchObservation[]
  region?: WorkBuddyRegion
}): AutoSwitchDecision {
  if (!input.enabled) return { action: 'stay', reason: 'disabled' }
  const active = input.observations.find(observation => observation.active)
  if (active === undefined) return { action: 'stay', reason: 'no-active-account' }
  const activeRemaining = active.remaining

  const candidates = input.observations.filter(observation =>
    eligible(observation, active, AUTO_SWITCH_DEFAULT_THRESHOLD, input.region))
  if (candidates.length === 0) {
    return {
      action: 'stay',
      reason: 'no-better-account',
      ...activeRemaining === undefined ? {} : { activeRemaining },
    }
  }
  const best = [...candidates].sort((left, right) => {
    const leftUnlimited = left.unlimited === true ? 1 : 0
    const rightUnlimited = right.unlimited === true ? 1 : 0
    if (leftUnlimited !== rightUnlimited) return rightUnlimited - leftUnlimited
    const delta = (right.remaining ?? 0) - (left.remaining ?? 0)
    if (delta !== 0) return delta
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })[0] as AutoSwitchObservation

  return {
    action: 'switch',
    reason: 'active-exhausted',
    targetId: best.id,
    ...best.label === undefined ? {} : { targetLabel: best.label },
    ...activeRemaining === undefined ? {} : { activeRemaining },
    ...best.remaining === undefined ? {} : { targetRemaining: best.remaining },
  }
}
