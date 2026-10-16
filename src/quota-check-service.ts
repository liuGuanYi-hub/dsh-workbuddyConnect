/**
 * The on-demand quota sweep: test every parked account against one model and
 * remember the answer.
 *
 * Sits between the pure check in {@link module:dsh-workbuddy-connect/quota-check}
 * and the two surfaces that ask for it (the card's button and the CLI), and owns
 * the three things neither should have to:
 *
 * - **Which accounts to test, and with which credential.** Parking exists
 *   precisely so several accounts can be held at once; a check that only tested
 *   the served one would answer the easy half of the question.
 * - **Recording the outcome.** A verdict is written back through
 *   {@link WorkBuddyQuotaStore}, so a `check-quota` sweep and a real chat
 *   refusal feed the same badges rather than two disagreeing notions of state.
 *   The per-account rows are also persisted through
 *   {@link WorkBuddyQuotaCheckStore}, because the CLI is a different process and
 *   a host restart must not un-learn what the user paid requests to find out.
 * - **Serialising runs.** These are real requests to a rate-limited upstream;
 *   two concurrent sweeps would be the most likely way to earn a 429, which
 *   this module would then have to report as `unknown`.
 *
 * A deliberate asymmetry: `exhausted` is recorded, `available` *clears* any
 * earlier verdict. Both come from the same observation — the upstream just
 * answered this account — so applying only the negative half would leave an
 * account marked spent after a check that proved otherwise.
 *
 * @module dsh-workbuddy-connect/quota-check-service
 */

import type { WorkBuddyAccountStore } from './accounts-store.ts'
import type { WorkBuddyCredential } from './auth.ts'
import { checkAccounts, type WorkBuddyQuotaCheckResult } from './quota-check.ts'
import type { WorkBuddyQuotaCheckStore } from './quota-check-store.ts'
import type { ProbeAttempt } from './probe.ts'
import { quotaAccountOf, type WorkBuddyQuotaStore } from './quota-state.ts'

/** Per-account request ceiling; matches the reasoning-effort probe. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Strip token-shaped content from an upstream's own words.
 *
 * A `reason` is built from the error body the upstream returned, and it leaves
 * this process three times: to the card, into the persisted sweep file, and out
 * through the CLI. The body is not expected to carry a credential — the plugin
 * sends it in a header — but a free-text field written by a third party is not
 * a place to assume, and the same redaction the account route and status route
 * apply is applied here for exactly that reason.
 */
function redact(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/** Constructor dependencies. */
export interface WorkBuddyQuotaCheckServiceOptions {
  /** The variant's parked accounts; absent on a host that has no slot store. */
  accounts: WorkBuddyAccountStore | undefined
  /** Where verdicts are read and written. */
  quota: WorkBuddyQuotaStore
  /**
   * Where the sweep's per-account rows are persisted, so a host restart and
   * the CLI can both read what this process paid requests to learn. Absent
   * only in tests that hold the outcome in memory.
   */
  checks?: WorkBuddyQuotaCheckStore
  /**
   * Performs one attempt for one credential against one model. Bound by the
   * caller to the upstream client, so this module never touches HTTP or identity
   * headers. `model` is passed rather than baked in so a sweep checks the model
   * it was asked about — an account can be spendable on one model and refused on
   * another.
   */
  send: (credential: WorkBuddyCredential, model: string, signal: AbortSignal) => Promise<ProbeAttempt>
  timeoutMs?: number
}

/** What one sweep reports back to its caller. */
export interface WorkBuddyQuotaSweepOutcome {
  model: string
  checkedAt: number
  results: readonly WorkBuddyQuotaCheckResult[]
}

/**
 * Runs quota sweeps one at a time.
 *
 * A single in-flight promise is shared: a second press while the first sweep is
 * talking to the upstream joins it rather than starting a competing set of
 * requests, which is also what makes "is a sweep running?" answerable without a
 * separate flag.
 */
export class WorkBuddyQuotaCheckService {
  private readonly options: WorkBuddyQuotaCheckServiceOptions
  private inflight: Promise<WorkBuddyQuotaSweepOutcome> | undefined
  private last: WorkBuddyQuotaSweepOutcome | undefined

  constructor(options: WorkBuddyQuotaCheckServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.inflight !== undefined
  }

  /**
   * The most recent sweep this process knows about.
   *
   * Falls back to the persisted one: the rows are the answer to a question the
   * user paid real requests for, so a host restart must not put them back to
   * "never checked". `running` still describes only this process.
   */
  lastOutcome(): WorkBuddyQuotaSweepOutcome | undefined {
    if (this.last !== undefined) return this.last
    const stored = this.options.checks?.last()
    if (stored === undefined) return undefined
    return { model: stored.model, checkedAt: stored.checkedAtMs, results: stored.results }
  }

  /**
   * Test every parked account against `model`.
   *
   * Never rejects: an unusable slot store or a credential that cannot be read
   * yields a `unknown` row for that account, because the value of the sweep is
   * the comparison between accounts and one bad row must not erase the rest.
   */
  async checkAll(model: string): Promise<WorkBuddyQuotaSweepOutcome> {
    const inflight = this.inflight
    if (inflight !== undefined) return inflight
    const run = this.run(model).finally(() => {
      this.inflight = undefined
    })
    this.inflight = run
    return run
  }

  private async run(model: string): Promise<WorkBuddyQuotaSweepOutcome> {
    const checkedAt = Date.now()
    const slots = await this.readSlots()
    const targets = slots.map(slot => ({
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
      send: (signal: AbortSignal) => this.options.send(slot.credential, model, signal),
    }))
    const results = (await checkAccounts(targets, {
      ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
    })).map(result => result.reason === undefined
      ? result
      : { ...result, reason: redact(result.reason) })

    // Apply each verdict to the same store the chat path writes, so the card
    // shows one state rather than two that can disagree.
    for (const result of results) {
      const slot = slots.find(candidate => candidate.id === result.id)
      if (slot === undefined) continue
      const account = quotaAccountOf(slot.credential)
      if (result.state === 'exhausted') this.options.quota.recordExhausted(account)
      else if (result.state === 'available') this.options.quota.clear(account)
    }

    const outcome: WorkBuddyQuotaSweepOutcome = { model, checkedAt, results }
    // Persist the rows themselves, not only the verdicts derived from them:
    // `available` and `unknown` are part of the answer the CLI reports, and an
    // account the check could not decide must not read as never checked.
    this.options.checks?.record({ model, checkedAtMs: checkedAt, results })
    this.last = outcome
    return outcome
  }

  /** Read the parked slots, degrading to none when the store is unusable. */
  private async readSlots(): Promise<Awaited<ReturnType<WorkBuddyAccountStore['list']>>> {
    const accounts = this.options.accounts
    if (accounts === undefined) return []
    try {
      return await accounts.list()
    } catch {
      // An unreadable slot store means there is nothing to test; reporting an
      // empty sweep is honest, and the card says "no parked accounts".
      return []
    }
  }
}

export { DEFAULT_TIMEOUT_MS as QUOTA_CHECK_SWEEP_TIMEOUT_MS }
