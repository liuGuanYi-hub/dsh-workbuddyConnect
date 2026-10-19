/**
 * Daily check-in across every parked account, and the memory of what it found.
 *
 * WorkBuddy's desktop app pays a small daily credit for a 签到 press. Parked
 * accounts are credentials the app is *not* currently signed into, so without
 * this module their daily reward quietly lapses every day — which is precisely
 * the state multi-account parking creates. So the same two upstream calls the
 * desktop app makes (`checkin-status` then `daily-checkin`, see
 * {@link module:dsh-workbuddy-connect/checkin}) are made here, once per parked
 * account.
 *
 * Three rules the rest of the plugin depends on:
 *
 * - **The status read is free; the claim is not.** A sweep always reads first
 *   and only claims accounts the upstream says are `claimable`. An account with
 *   no activity (`unavailable`) or one already taken today (`checked-in`) sends
 *   no claim request at all, so pressing the button twice cannot cost anything
 *   twice.
 * - **`unknown` is never claimed.** A transport failure or an unreadable body
 *   says nothing about whether today's reward is available; claiming on it
 *   would be a blind write, so it is reported and skipped.
 * - **Nothing here touches the desktop app's file.** Sessions live in
 *   {@link WorkBuddyUpstreamClient}, which only ever sends with a copy of the
 *   token, exactly like a chat completion.
 *
 * @module dsh-workbuddy-connect/checkin-service
 */

import type { WorkBuddyAccountStore } from './accounts-store.ts'
import type { WorkBuddyCredential } from './auth.ts'
import {
  claimCheckin,
  readCheckinStatus,
  type WorkBuddyCheckinClaim,
  type WorkBuddyCheckinStatus,
} from './checkin.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** One account's outcome from one sweep. */
export interface WorkBuddyCheckinRow {
  /** Slot id this row belongs to. */
  id: string
  /** Display name at check time, so a renamed slot's history stays readable. */
  label?: string
  /** What the status read said before the sweep acted. */
  status: WorkBuddyCheckinStatus['state']
  /** What the sweep did: claimed, skipped, or failed. */
  outcome: 'claimed' | 'skipped' | 'failed'
  /** Credits granted, when the claim named a number. */
  credit?: number
  /** Credit today's reward is worth, when the status named a number. */
  dailyCredit?: number
  /** Consecutive check-in days after the sweep, when the upstream counted. */
  streakDays?: number
  /** Why nothing was claimed, or why the claim failed. */
  reason?: string
}

/** The whole sweep, as the card renders it. */
export interface WorkBuddyCheckinSweep {
  /** When the sweep finished, epoch milliseconds. */
  checkedAtMs: number
  /** One row per parked account, in slot order. */
  rows: readonly WorkBuddyCheckinRow[]
}

/** How the sweep reaches the upstream; injectable so tests never go online. */
export interface WorkBuddyCheckinTransports {
  status: (credential: WorkBuddyCredential, region: WorkBuddyRegion, signal: AbortSignal) => Promise<WorkBuddyCheckinStatus>
  claim: (credential: WorkBuddyCredential, region: WorkBuddyRegion, signal: AbortSignal) => Promise<WorkBuddyCheckinClaim>
}

/** Constructor dependencies. */
export interface WorkBuddyCheckinServiceOptions {
  /** The variant's parked accounts. */
  accounts: WorkBuddyAccountStore
  /** Region of this variant's endpoint. */
  region: WorkBuddyRegion
  /** Transport override; production leaves it unset. */
  transports?: WorkBuddyCheckinTransports
  /**
   * How many slots to sweep. Parked accounts are few by nature; the cap keeps a
   * pathological store from turning one button press into an unbounded burst of
   * requests against a rate-limited upstream.
   */
  maxAccounts?: number
  /** Per-request ceiling; passed through to the check-in calls. */
  timeoutMs?: number
}

/** Default cap on a sweep; every slot in practice is far below it. */
export const CHECKIN_MAX_ACCOUNTS = 10

/**
 * Runs check-in sweeps one at a time.
 *
 * A single in-flight promise is shared: a second press while the first sweep is
 * talking to the upstream joins it rather than starting a competing set of
 * claims, which is also what makes "is a sweep running?" answerable without a
 * separate flag.
 */
export class WorkBuddyCheckinService {
  private readonly options: WorkBuddyCheckinServiceOptions
  private inflight: Promise<WorkBuddyCheckinSweep> | undefined
  private last: WorkBuddyCheckinSweep | undefined

  constructor(options: WorkBuddyCheckinServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.inflight !== undefined
  }

  /** The most recent sweep this process knows about. */
  lastOutcome(): WorkBuddyCheckinSweep | undefined {
    return this.last
  }

  /**
   * Read every parked account's state and claim what is claimable.
   *
   * Never rejects: an unreadable slot store or one unusable credential yields a
   * `failed` row for that account, because the value of the sweep is what the
   * *other* accounts did.
   */
  async sweepAll(): Promise<WorkBuddyCheckinSweep> {
    const inflight = this.inflight
    if (inflight !== undefined) return inflight
    const run = this.run().finally(() => {
      this.inflight = undefined
    })
    this.inflight = run
    return run
  }

  private async run(): Promise<WorkBuddyCheckinSweep> {
    const timeoutMs = this.options.timeoutMs
    const transports: WorkBuddyCheckinTransports = this.options.transports ?? {
      status: (credential, region, signal) => readCheckinStatus(credential, {
        region,
        ...timeoutMs === undefined ? {} : { timeoutMs },
      }),
      claim: (credential, region, signal) => claimCheckin(credential, {
        region,
        ...timeoutMs === undefined ? {} : { timeoutMs },
      }),
    }
    let slots: Awaited<ReturnType<WorkBuddyAccountStore['list']>>
    try {
      slots = await this.options.accounts.list()
    } catch {
      slots = []
    }
    const cap = this.options.maxAccounts ?? CHECKIN_MAX_ACCOUNTS
    const rows: WorkBuddyCheckinRow[] = []
    // Sequential on purpose, for the same reason the quota sweep is: these are
    // real requests to a rate-limited upstream, and a burst of parallel claims
    // is the most likely way to earn a 429 — which would then have to be
    // reported as `failed` for accounts that were perfectly claimable.
    for (const slot of slots.slice(0, cap)) {
      rows.push(await this.sweepOne(slot, transports))
    }
    const sweep: WorkBuddyCheckinSweep = { checkedAtMs: Date.now(), rows }
    this.last = sweep
    return sweep
  }

  /** Read one account and claim it when the status says to. */
  private async sweepOne(
    slot: Awaited<ReturnType<WorkBuddyAccountStore['list']>>[number],
    transports: WorkBuddyCheckinTransports,
  ): Promise<WorkBuddyCheckinRow> {
    const controller = new AbortController()
    const base = {
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
    }
    // First what the upstream says about today, then — only for `claimable` —
    // the claim that spends the write.
    const status = await transports.status(slot.credential, this.options.region, controller.signal)
    const statusDetail: Partial<WorkBuddyCheckinRow> = {
      ...status.dailyCredit === undefined ? {} : { dailyCredit: status.dailyCredit },
      ...status.streakDays === undefined ? {} : { streakDays: status.streakDays },
    }
    if (status.state === 'unavailable') {
      return {
        ...base,
        ...statusDetail,
        status: status.state,
        outcome: 'skipped',
        // The CN endpoint answers an all-false shell for personal accounts
        // rather than an error, so this is counted as "nothing to do" and not
        // as a failure the user should chase.
        reason: 'no check-in activity for this account',
      }
    }
    if (status.state === 'checked-in') {
      return {
        ...base,
        ...statusDetail,
        status: status.state,
        outcome: 'skipped',
        reason: 'already checked in today',
      }
    }
    if (status.state === 'unknown') {
      return {
        ...base,
        ...statusDetail,
        status: status.state,
        outcome: 'failed',
        ...status.reason === undefined ? {} : { reason: status.reason },
      }
    }
    const claim = await transports.claim(slot.credential, this.options.region, controller.signal)
    if (claim.state === 'claimed') {
      return {
        ...base,
        ...statusDetail,
        ...claim.credit === undefined ? {} : { credit: claim.credit },
        ...claim.streakDays === undefined ? {} : { streakDays: claim.streakDays },
        status: status.state,
        outcome: 'claimed',
      }
    }
    if (claim.state === 'already') {
      return {
        ...base,
        ...statusDetail,
        status: 'checked-in',
        outcome: 'skipped',
        reason: claim.reason ?? 'already checked in today',
      }
    }
    return {
      ...base,
      ...statusDetail,
      status: status.state,
      outcome: 'failed',
      ...claim.reason === undefined ? {} : { reason: claim.reason },
    }
  }
}
