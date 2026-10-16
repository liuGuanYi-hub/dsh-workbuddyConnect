/**
 * On-demand "can this account still spend on this model?" check.
 *
 * The recorded-verdict design in {@link module:dsh-workbuddy-connect/quota-state}
 * answers "has this account been refused?", which is only ever learned by
 * failing a real chat. That is the wrong shape for the question a user actually
 * asks before starting work: *is this account still good for DeepSeek v4.1
 * Flash right now?* Waiting to be refused answers it too late, and asking the
 * billing endpoint answers a different question — remaining credit is not the
 * same as this model being servable (a model can be separately gated, and a
 * balance can be spent by another client between the read and the request).
 *
 * So this module spends the only thing that answers it: one deliberately
 * minimal chat request per account, exactly the way the reasoning-effort probe
 * already does (`max_tokens: 1`, body never assembled, hang up on the first
 * event). The request is tiny but not free, which is why it is strictly
 * on demand and never automatic.
 *
 * What a result may claim:
 *
 * - `available` — the upstream accepted the request. This is the strongest
 *   honest statement available: it will be wrong only if the account runs dry
 *   between this check and the user's next message, which no design can prevent.
 * - `exhausted` — the upstream refused it with an insufficient-credit verdict.
 * - `unknown` — anything else (transport failure, an unrelated 4xx, an
 *   unrecognised body). Never collapsed into `exhausted`: a 500 or a dead
 *   session is not a spent account, and reporting it as one would send the user
 *   to burn a second account for nothing.
 *
 * @module dsh-workbuddy-connect/quota-check
 */

import { PROBE_PROMPT } from './probe.ts'
import type { ProbeAttempt } from './probe.ts'
import { classifyUpstreamError } from './upstream.ts'

/** Model the check targets by default: the one the user burns quota on. */
export const QUOTA_CHECK_MODEL = 'deepseek-v4.1-flash'

/** Per-request ceiling, matching the reasoning-effort probe. */
export const QUOTA_CHECK_TIMEOUT_MS = 30_000

/** One account's answer. */
export type WorkBuddyQuotaCheckState =
  /** The upstream accepted a request for this account. */
  | 'available'
  /** The upstream refused it for insufficient credit. */
  | 'exhausted'
  /** The check could not decide; `reason` says why. */
  | 'unknown'

/** One account's check result. */
export interface WorkBuddyQuotaCheckResult {
  /** Slot id this result belongs to. */
  id: string
  /** Display name, when the caller knows one. */
  label?: string
  state: WorkBuddyQuotaCheckState
  /** HTTP status observed, or 0 for a transport failure. */
  status: number
  /** Why the state is `unknown`; absent otherwise. */
  reason?: string
}

/** How one attempt is performed; the caller owns credentials and HTTP. */
export type QuotaCheckSender = (signal: AbortSignal) => Promise<ProbeAttempt>

/**
 * Interpret one attempt.
 *
 * The decision reads the upstream's *own* classification rather than a local
 * status list, so a body that says "insufficient credit" is honoured even when
 * it arrives as a 200-shaped envelope or an unexpected status — the same
 * reasoning the chat path uses, and the reason `classifyUpstreamError` is
 * shared rather than reimplemented here.
 */
export function interpretQuotaCheck(attempt: ProbeAttempt): {
  state: WorkBuddyQuotaCheckState
  reason?: string
} {
  // A streamed event is acceptance. The body is never read, so this is not a
  // claim about the answer's content — only that the account may spend.
  if (attempt.status === 200 && attempt.streamed) return { state: 'available' }
  if (attempt.status === 0) {
    return { state: 'unknown', reason: attempt.detail ?? 'transport error' }
  }
  // Classify from the raw body, not `detail`. For a JSON error `detail` is only
  // the `extError.code`, and the insufficient-credit verdict is spelled in the
  // body's message fields — reading the code alone would report exactly the
  // refusals this check exists to catch as `unknown`.
  const kind = classifyUpstreamError(attempt.status, attempt.body ?? attempt.detail ?? '')
  if (kind === 'hard_credit') return { state: 'exhausted' }

  // Everything else stays undecided, with the most specific explanation to
  // hand. Notably a `session_dead` is a sign-in problem, not a quota problem:
  // reporting it as exhausted would tell the user to switch accounts when the
  // real fix is to sign in again.
  const code = attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`
  const detail = attempt.detail === undefined ? '' : `: ${attempt.detail.slice(0, 200)}`
  return { state: 'unknown', reason: `status ${attempt.status}${code}${detail}` }
}

/**
 * Check one account.
 *
 * A 200 that never streamed is *not* acceptance — it means the upstream opened
 * a response and said nothing usable, which the probe treats as inconclusive
 * and so does this. The timeout is owned here so a hung upstream cannot stall
 * the sweep past one request.
 */
export async function checkOneAccount(options: {
  id: string
  label?: string
  send: QuotaCheckSender
  timeoutMs?: number
}): Promise<WorkBuddyQuotaCheckResult> {
  const timeoutMs = options.timeoutMs ?? QUOTA_CHECK_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let attempt: ProbeAttempt
  try {
    attempt = await options.send(controller.signal)
  } catch (error: unknown) {
    attempt = { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
  } finally {
    clearTimeout(timer)
  }
  const interpreted = interpretQuotaCheck(attempt)
  return {
    id: options.id,
    ...options.label === undefined ? {} : { label: options.label },
    state: interpreted.state,
    status: attempt.status,
    ...interpreted.reason === undefined ? {} : { reason: interpreted.reason },
  }
}

/** One account to check. */
export interface QuotaCheckTarget {
  id: string
  label?: string
  /** Performs the attempt for this account; the caller binds the credential. */
  send: QuotaCheckSender
}

/**
 * Check several accounts, in order.
 *
 * Sequential on purpose, for the same reason the reasoning probe is: these are
 * real requests against a rate-limited upstream, and a burst of parallel checks
 * would be the one thing most likely to be answered with a 429 — which this
 * module would then have to report as `unknown`, making a faster sweep less
 * useful than a slower one.
 *
 * Never throws. One account's unexpected failure must not hide the others'
 * results, because the whole value of the sweep is the comparison between them.
 */
export async function checkAccounts(
  targets: readonly QuotaCheckTarget[],
  options: { timeoutMs?: number } = {},
): Promise<WorkBuddyQuotaCheckResult[]> {
  const results: WorkBuddyQuotaCheckResult[] = []
  for (const target of targets) {
    try {
      results.push(await checkOneAccount({
        id: target.id,
        ...target.label === undefined ? {} : { label: target.label },
        send: target.send,
        ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      }))
    } catch (error: unknown) {
      // `checkOneAccount` already absorbs its own failures; this guard exists so
      // an unexpected throw (a bug, an OOM) still yields a row rather than
      // losing every result collected so far.
      results.push({
        id: target.id,
        ...target.label === undefined ? {} : { label: target.label },
        state: 'unknown',
        status: 0,
        reason: `check failed: ${String(error).slice(0, 200)}`,
      })
    }
  }
  return results
}

/** The prompt a quota check sends; exported so tests pin it. */
export { PROBE_PROMPT as QUOTA_CHECK_PROMPT }
