/**
 * Automatic account switching, and the memory of what it has done.
 *
 * The decision itself lives in {@link module:dsh-workbuddy-connect/auto-switch}
 * and is pure. This module owns the three things a decision cannot: talking to
 * the upstream, knowing what time it is, and *committing* a switch.
 *
 * ## Why balances, and not the existing quota check
 *
 * The plugin already ships `quota-check`, which asks each account to spend a
 * real request (`max_tokens: 1`) in order to prove it can still serve. That is
 * the right cost for a button the user presses deliberately, and the wrong cost
 * for something that runs on a timer — a sweep every few minutes would quietly
 * burn the very quota it is trying to conserve.
 *
 * The billing endpoint that the status card already calls
 * (`fetchCredits`) answers "how much is left" for **any** credential, for free,
 * and for every parked account rather than only the served one. That is the
 * only reason a scheduled sweep is affordable at all, and it is why this
 * service is built on balances rather than on probe requests.
 *
 * ## Three rules that keep it from making things worse
 *
 * - **Unknown never switches.** A failed billing read yields no observation, so
 *   the decider sees `undefined` and stays. Rotating on a network blip would
 *   spend accounts to fix a problem that was never theirs.
 * - **One switch per cooldown.** Enforced here, because only this layer knows
 *   when the last switch actually happened.
 * - **A switch is the *same* operation the card's button performs.** It goes
 *   through {@link WorkBuddyAccountStore.setActive}, so `active.json` remains
 *   the single source of truth, the desktop app's file is still never written,
 *   and a manual switch and an automatic one cannot disagree.
 *
 * @module dsh-workbuddy-connect/auto-switch-service
 */

import type { WorkBuddyAccountSlot, WorkBuddyAccountStore } from './accounts-store.ts'
import type { WorkBuddyCredential } from './auth.ts'
import {
  decideAutoSwitch,
  decideRefusalSwitch,
  AUTO_SWITCH_DEFAULT_COOLDOWN_MS,
  AUTO_SWITCH_DEFAULT_THRESHOLD,
  AUTO_SWITCH_MAX_ACCOUNTS,
  type AutoSwitchDecision,
  type AutoSwitchObservation,
} from './auto-switch.ts'
import { quotaAccountOf, type WorkBuddyQuotaStore } from './quota-state.ts'
import type { WorkBuddyRegion, WorkBuddyCredits } from './upstream.ts'
import { regionOf } from './upstream.ts'

/** Why one account's balance could not be read, as the card explains it. */
export interface AutoSwitchReadFailure {
  /** Slot id. */
  id: string
  /** Short, sanitised explanation. Never contains token material. */
  reason: string
}

/** One account's row in the last sweep, as the card renders it. */
export interface AutoSwitchRow {
  id: string
  label?: string
  active: boolean
  /** Remaining credit, when the read succeeded. */
  remaining?: number
  /** The account's cycle quota is uncapped. */
  unlimited?: boolean
  /** Why the read failed; present only when it did. */
  error?: string
}

/** What one sweep concluded. */
export interface AutoSwitchSweep {
  /** When the sweep finished, epoch milliseconds. */
  checkedAtMs: number
  /** The threshold the decision used. */
  threshold: number
  /** One row per parked account, in slot order. */
  rows: readonly AutoSwitchRow[]
  /** What the decider decided, and why. */
  decision: AutoSwitchDecision
  /** Whether the decision was carried out (a switch can be decided but refused). */
  switched: boolean
  /** Why a decided switch could not be performed. */
  switchError?: string
}

/** The single most recent automatic switch this process performed. */
export interface AutoSwitchRecord {
  /** When it happened, epoch milliseconds. */
  atMs: number
  /** The slot left behind. */
  fromId: string
  /** The slot now being served. */
  toId: string
  /** Why it happened. */
  reason: 'active-below-threshold' | 'active-exhausted'
  /** Credit observed on the account that was left. */
  fromRemaining?: number
  /** Credit observed on the account that was adopted. */
  toRemaining?: number
}

/** Reads one credential's remaining credit; injected so tests never go online. */
export type AutoSwitchCreditReader = (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>

/** Constructor dependencies. */
export interface WorkBuddyAutoSwitchServiceOptions {
  /** The variant's parked accounts. */
  accounts: WorkBuddyAccountStore
  /** The billing reader, normally `WorkBuddyUpstreamClient.fetchCredits`. */
  readCredits: AutoSwitchCreditReader
  /** Recorded refusals, consulted so a known-spent account is never chosen. */
  quota?: WorkBuddyQuotaStore
  /** This variant's region, enforced on every candidate. */
  region?: WorkBuddyRegion
  /** Whether the feature is on. Read per sweep so a settings change applies. */
  enabled?: () => boolean
  /** The threshold in force. Read per sweep for the same reason. */
  threshold?: () => number
  /** Shortest interval between two *balance-driven* switches. */
  cooldownMs?: number
  /** Slot cap for one sweep. */
  maxAccounts?: number
  /** Called after a switch lands, so the host can re-resolve the served account. */
  onChange?: () => void | Promise<void>
  /** Diagnostic sink; never given credential material. */
  logger?: { warn(...args: unknown[]): void }
  /** Clock, injected so the cooldown is testable without waiting. */
  now?: () => number
}

/** Redact token-shaped content from an upstream message. */
function sanitise(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 200)
}

/** Whether a slot's stored access token is already past its expiry. */
function slotExpired(slot: WorkBuddyAccountSlot, nowMs: number): boolean {
  return slot.credential.expiresAtMs > 0 && slot.credential.expiresAtMs <= nowMs
}

/**
 * Reads every parked account's balance, decides, and switches.
 *
 * Sweeps are serialised through one in-flight promise: two concurrent sweeps
 * would double the billing reads and — worse — could each pick a different
 * target from the same stale view, so the second would overwrite the first.
 */
export class WorkBuddyAutoSwitchService {
  private readonly options: WorkBuddyAutoSwitchServiceOptions
  /**
   * The post-switch hook, installable after construction.
   *
   * Held apart from {@link options} (which is readonly) because the hook needs
   * the applied plugin's state and is therefore only available later.
   */
  private onChange: (() => void | Promise<void>) | undefined
  private inflight: Promise<AutoSwitchSweep> | undefined
  private lastSweep: AutoSwitchSweep | undefined
  private lastSwitch: AutoSwitchRecord | undefined
  private lastSwitchAtMs = 0
  /**
   * Switches are counted so an oscillation is visible rather than silent. The
   * cooldown is the actual defence; this is what lets a user see that it keeps
   * happening instead of wondering why their account changed again.
   */
  private switchCount = 0

  constructor(options: WorkBuddyAutoSwitchServiceOptions) {
    this.options = options
    // Seeded from the constructor when given; `setOnChange` replaces it once the
    // applied plugin can supply a better one.
    this.onChange = options.onChange
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.inflight !== undefined
  }

  /** The most recent sweep this process performed. */
  lastOutcome(): AutoSwitchSweep | undefined {
    return this.lastSweep
  }

  /** The most recent switch this process performed, if any. */
  lastSwitchRecord(): AutoSwitchRecord | undefined {
    return this.lastSwitch
  }

  /**
   * Install the post-switch hook.
   *
   * Set separately rather than passed to the constructor because the hook needs
   * the running plugin's state (`adoptIdentity` lives inside the applied plugin
   * closure), while the service is built earlier, when the variant's stores are
   * assembled. A switch lands on disk either way; without this hook the host
   * would simply notice the new account at its next reconcile instead of
   * immediately.
   */
  setOnChange(hook: () => void | Promise<void>): void {
    this.onChange = hook
  }

  /** How many automatic switches this process has performed. */
  totalSwitches(): number {
    return this.switchCount
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private enabled(): boolean {
    return this.options.enabled?.() ?? false
  }

  private threshold(): number {
    const value = this.options.threshold?.() ?? AUTO_SWITCH_DEFAULT_THRESHOLD
    return Number.isFinite(value) && value >= 0 ? value : AUTO_SWITCH_DEFAULT_THRESHOLD
  }

  private cooldownMs(): number {
    const value = this.options.cooldownMs ?? AUTO_SWITCH_DEFAULT_COOLDOWN_MS
    return Number.isFinite(value) && value >= 0 ? value : AUTO_SWITCH_DEFAULT_COOLDOWN_MS
  }

  /** Whether the cooldown is still running. */
  private coolingDown(): boolean {
    if (this.lastSwitchAtMs === 0) return false
    return this.now() - this.lastSwitchAtMs < this.cooldownMs()
  }

  /**
   * One full sweep: read every balance, decide, and act.
   *
   * Never rejects. A sweep that cannot read anything reports rows with errors
   * and a `stay` decision, because the value of the sweep is what the user can
   * see about their accounts — losing that to an exception would hide the very
   * diagnosis they need.
   */
  async sweep(): Promise<AutoSwitchSweep> {
    const inflight = this.inflight
    if (inflight !== undefined) return inflight
    const run = this.run().finally(() => {
      this.inflight = undefined
    })
    this.inflight = run
    return run
  }

  private async readSlots(): Promise<WorkBuddyAccountSlot[]> {
    try {
      return await this.options.accounts.list()
    } catch (error: unknown) {
      this.options.logger?.warn('dsh-workbuddy-connect: auto-switch could not read the slot store', error)
      return []
    }
  }

  /**
   * Observe one account.
   *
   * The returned row always describes the account; only `remaining` is absent
   * when the read failed. Keeping the failure in the row (rather than dropping
   * the account) is what lets the card show "could not read" instead of
   * silently listing four accounts when there are five.
   */
  private async observe(
    slot: WorkBuddyAccountSlot,
    activeId: string | undefined,
    nowMs: number,
  ): Promise<{ row: AutoSwitchRow, observation: AutoSwitchObservation }> {
    const quotaAccount = quotaAccountOf(slot.credential)
    const exhausted = this.options.quota?.isExhausted(quotaAccount) === true
    const base = {
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
      active: slot.id === activeId,
    }
    const observationBase: AutoSwitchObservation = {
      ...base,
      ...slot.credential.domain === '' ? {} : { domain: slot.credential.domain },
      ...exhausted ? { exhausted: true } : {},
      ...slotExpired(slot, nowMs) ? { expired: true } : {},
    }
    try {
      const credits = await this.options.readCredits(slot.credential)
      // `unlimited` is carried as a flag rather than folded into a number: the
      // upstream's `-1` limit is a sentinel, and any arithmetic on it produces a
      // plausible-looking figure that means the opposite thing.
      const unlimited = credits.unlimited === true
      const remaining = unlimited ? undefined : credits.total
      return {
        row: {
          ...base,
          ...unlimited ? { unlimited: true } : {},
          ...remaining === undefined ? {} : { remaining },
        },
        observation: {
          ...observationBase,
          ...unlimited ? { unlimited: true } : {},
          ...remaining === undefined ? {} : { remaining },
        },
      }
    } catch (error: unknown) {
      const reason = sanitise(error)
      return {
        row: { ...base, error: reason },
        // No `remaining`: rule 1 in the module docs — an unreadable balance is
        // not evidence of exhaustion, and the decider must see the difference.
        observation: observationBase,
      }
    }
  }

  private async run(): Promise<AutoSwitchSweep> {
    const nowMs = this.now()
    const threshold = this.threshold()
    const slots = (await this.readSlots()).slice(0, this.options.maxAccounts ?? AUTO_SWITCH_MAX_ACCOUNTS)
    const activeId = await this.options.accounts.activeId().catch(() => undefined)

    const rows: AutoSwitchRow[] = []
    const observations: AutoSwitchObservation[] = []
    // Sequential, for the same reason the check-in and quota sweeps are: these
    // are real reads against a rate-limited upstream, and a burst is the most
    // likely way to earn a 429 that would then read as "unknown" for every
    // account — turning a working check into a false negative.
    for (const slot of slots) {
      const observed = await this.observe(slot, activeId, nowMs)
      rows.push(observed.row)
      observations.push(observed.observation)
    }

    const decision = decideAutoSwitch({
      enabled: this.enabled(),
      threshold,
      coolingDown: this.coolingDown(),
      observations,
      ...this.options.region === undefined ? {} : { region: this.options.region },
    })

    const sweep: AutoSwitchSweep = {
      checkedAtMs: nowMs,
      threshold,
      rows,
      decision,
      switched: false,
    }
    if (decision.action !== 'switch') {
      this.lastSweep = sweep
      return sweep
    }

    const performed = await this.commit(decision, activeId)
    const result: AutoSwitchSweep = {
      ...sweep,
      switched: performed.ok,
      ...performed.error === undefined ? {} : { switchError: performed.error },
    }
    this.lastSweep = result
    return result
  }

  /**
   * Perform one switch and record it.
   *
   * The cooldown clock is advanced only on success: a refused write means the
   * account did not actually change, and treating it as a switch would both
   * misreport the state and block the next, possibly successful, attempt.
   */
  private async commit(
    decision: Extract<AutoSwitchDecision, { action: 'switch' }>,
    fromId: string | undefined,
  ): Promise<{ ok: boolean, error?: string }> {
    try {
      await this.options.accounts.setActive(decision.targetId)
    } catch (error: unknown) {
      const reason = sanitise(error)
      this.options.logger?.warn('dsh-workbuddy-connect: automatic account switch failed', reason)
      return { ok: false, error: reason }
    }
    const atMs = this.now()
    this.lastSwitchAtMs = atMs
    this.switchCount += 1
    this.lastSwitch = {
      atMs,
      fromId: fromId ?? '(unknown)',
      toId: decision.targetId,
      reason: decision.reason,
      ...decision.activeRemaining === undefined ? {} : { fromRemaining: decision.activeRemaining },
      ...decision.targetRemaining === undefined ? {} : { toRemaining: decision.targetRemaining },
    }
    try {
      await this.onChange?.()
    } catch (error: unknown) {
      // The switch itself already landed on disk. A failure here only means the
      // host will re-resolve the account on its next poll, so it must not turn a
      // completed switch into a reported failure.
      this.options.logger?.warn('dsh-workbuddy-connect: account change could not be applied after an automatic switch', error)
    }
    return { ok: true }
  }

  /**
   * React to a chat request the upstream refused for insufficient credit.
   *
   * Deliberately separate from {@link sweep}: the sweep runs on a timer and can
   * be minutes stale, while this fires at the exact moment the account is known
   * to be unusable. It reuses the same decider for candidate selection so the
   * two triggers cannot disagree about which account is a good target, but it
   * skips the balance reads for the accounts it must not choose anyway.
   *
   * Also deliberately ignores the cooldown: an account the upstream has just
   * refused cannot serve the next request at all, so waiting out the timer would
   * only spread the failure over more turns.
   *
   * Never throws, and never lets a failure here replace the chat error the
   * caller is already reporting.
   */
  async onRefusal(account: string | undefined): Promise<AutoSwitchRecord | undefined> {
    if (!this.enabled()) return undefined
    try {
      const slots = (await this.readSlots()).slice(0, this.options.maxAccounts ?? AUTO_SWITCH_MAX_ACCOUNTS)
      if (slots.length < 2) return undefined
      const nowMs = this.now()
      const observations: AutoSwitchObservation[] = []
      for (const slot of slots) {
        const slotAccount = quotaAccountOf(slot.credential)
        const isRefused = slotAccount !== undefined && slotAccount === account
        const observation: AutoSwitchObservation = {
          id: slot.id,
          ...slot.label === undefined ? {} : { label: slot.label },
          // The refused account is "active" for this decision even if the
          // pointer has not caught up: the refusal names the account that
          // actually failed, which is stronger evidence than the pointer.
          active: isRefused,
          ...slot.credential.domain === '' ? {} : { domain: slot.credential.domain },
          ...slotExpired(slot, nowMs) ? { expired: true } : {},
          ...this.options.quota?.isExhausted(slotAccount) === true ? { exhausted: true } : {},
        }
        // Only likely targets are measured. Reading every balance here would
        // add one HTTP round trip per account to the chat path, which is the one
        // place latency is felt; a candidate with no balance is skipped by the
        // decider, so the refusal path degrades to "pick the only other account"
        // rather than failing.
        if (!isRefused) {
          try {
            const credits = await this.options.readCredits(slot.credential)
            const unlimited = credits.unlimited === true
            observations.push({
              ...observation,
              ...unlimited ? { unlimited: true } : {},
              ...unlimited ? {} : { remaining: credits.total },
            })
            continue
          } catch {
            // Unreadable candidate: it stays ineligible (no `remaining`), which
            // is the honest outcome — we cannot promise it has credit.
          }
        }
        observations.push(observation)
      }
      const decision = decideRefusalSwitch({
        enabled: true,
        observations,
        ...this.options.region === undefined ? {} : { region: this.options.region },
      })
      if (decision.action !== 'switch') return undefined
      const performed = await this.commit(decision, observations.find(o => o.active)?.id)
      return performed.ok ? this.lastSwitch : undefined
    } catch (error: unknown) {
      this.options.logger?.warn('dsh-workbuddy-connect: automatic switch after a refusal failed', sanitise(error))
      return undefined
    }
  }
}

/** Re-exported so the wiring layer and the card agree on the defaults. */
export {
  AUTO_SWITCH_DEFAULT_THRESHOLD,
  AUTO_SWITCH_DEFAULT_COOLDOWN_MS,
  AUTO_SWITCH_MAX_ACCOUNTS,
}

/** Derive an observation's display name, for log lines and the card. */
export function autoSwitchName(row: { id: string, label?: string }): string {
  const label = row.label?.trim() ?? ''
  return label === '' ? row.id : label
}

/** Whether a stored domain belongs to this region; exported for tests. */
export function domainMatchesRegion(domain: string, region: WorkBuddyRegion): boolean {
  return regionOf(domain) === region
}
