/**
 * Daily check-in: read the reward activity's state, and claim today's reward.
 *
 * WorkBuddy's desktop app shows a 签到 (check-in) card that pays a small daily
 * credit. The plugin's whole premise is that a user should not have to keep the
 * desktop app open to get value out of the account it signed in, so the same
 * two calls are made here, with the same credential the chat path uses.
 *
 * The two endpoints are read out of the shipped desktop bundle
 * (`resources/app.asar`, `main/account.js`) rather than guessed:
 *
 * - **CN** (`www.codebuddy.cn`, `BackendProvider`):
 *   `POST /v2/billing/meter/checkin-status` and
 *   `POST /v2/billing/meter/daily-checkin`, both with an empty object body and
 *   an envelope of `{code, msg, data}` where `data` carries the activity.
 * - **International** (`www.workbuddy.ai`, `CloudAccountRepo`):
 *   `POST /v2/billing/meter/checkin-activity-status` and
 *   `POST /v2/billing/meter/daily-checkin`. The status endpoint answers
 *   `{code, msg, data: {active, today_checked_in, streak_days, daily_credit,
 *   today_credit, …}}`; the claim answers `{code, data: {credit, streak_days,
 *   is_streak_day}}`, with a non-zero `code` meaning "not claimed" and `msg`
 *   saying why.
 *
 * What a result may claim:
 *
 * - `unavailable` — the upstream says there is no check-in activity for this
 *   account right now (`active: false`). This is the common case for the CN
 *   region, whose status endpoint was measured answering an all-false shell.
 * - `checked-in` — the upstream says today's reward is already taken.
 * - `claimable` — the upstream says today's reward is still available.
 * - `unknown` — anything else (transport failure, an unexpected body, an
 *   unrecognised claim code). Never collapsed into `unavailable`: "we could not
 *   ask" and "there is nothing to claim" send the user to different places.
 *
 * Nothing here writes to the desktop app's credential file; the claim is a
 * request made with a copy of the token, exactly like a chat completion.
 *
 * @module dsh-workbuddy-connect/checkin
 */

import type { WorkBuddyCredential } from './auth.ts'
import { workbuddyBillingHeaders, type WorkBuddyRegion } from './upstream.ts'

/** Same ceiling as the billing reads; a check-in is a small POST. */
export const CHECKIN_TIMEOUT_MS = 20_000

/** Where the two endpoints live, per region. */
const CHECKIN_BASES: Record<WorkBuddyRegion, string> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/** The status path the region's desktop client calls. */
const CHECKIN_STATUS_PATH: Record<WorkBuddyRegion, string> = {
  cn: '/v2/billing/meter/checkin-status',
  global: '/v2/billing/meter/checkin-activity-status',
}

/** The claim path; the same on both measured endpoints. */
const CHECKIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin'

/** What one account's check-in state is, as far as the upstream said. */
export type WorkBuddyCheckinState =
  /** No check-in activity exists for this account right now. */
  | 'unavailable'
  /** The reward is still available today. */
  | 'claimable'
  /** Today's reward is already taken. */
  | 'checked-in'
  /** The upstream could not decide (or could not be reached). */
  | 'unknown'

/** One status read. */
export interface WorkBuddyCheckinStatus {
  state: WorkBuddyCheckinState
  /** Credits today's claim pays, when the upstream named one. */
  dailyCredit?: number
  /** Credits granted so far today, when the upstream named one. */
  todayCredit?: number
  /** Consecutive check-in days, when the upstream counted them. */
  streakDays?: number
  /** The activity's end time, verbatim, when the upstream sent one. */
  endTime?: string
  /** Why the state is `unknown`; absent otherwise. */
  reason?: string
}

/** What one claim attempt did. */
export interface WorkBuddyCheckinClaim {
  /**
   * `claimed` — the upstream accepted the claim.
   * `already` — the upstream refused it because today is already taken.
   * `unavailable` — no activity is running for this account.
   * `failed` — anything else; `reason` says what.
   */
  state: 'claimed' | 'already' | 'unavailable' | 'failed'
  /** Credits the claim paid, or that today already paid, when known. */
  credit?: number
  streakDays?: number
  isStreakDay?: boolean
  /** The upstream's own words (or a local diagnosis) for a non-claim. */
  reason?: string
}

/** How a request is performed; injectable so tests never touch the network. */
export type CheckinFetch = (
  region: WorkBuddyRegion,
  path: string,
  credential: WorkBuddyCredential,
  signal: AbortSignal,
) => Promise<{ status: number; document: unknown; text: string }>

/** The default transport: one JSON POST with a timeout. */
async function fetchJson(
  region: WorkBuddyRegion,
  path: string,
  credential: WorkBuddyCredential,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; document: unknown; text: string }> {
  // Delegates to the upstream client's own billing headers and envelope
  // reader. Both are shared rather than copied: the gateway splits accounts by
  // the `X-User-Id` / `X-Enterprise-Id` pair, so a check-in presenting a
  // different identity would pay the wrong account — and one reader means a
  // future header change cannot reach chat and check-in separately.
  const response = await fetch(`${CHECKIN_BASES[region]}${path}`, {
    method: 'POST',
    headers: workbuddyBillingHeaders(credential),
    body: JSON.stringify({}),
    signal,
  })
  const text = await response.text()
  let document: unknown
  try {
    document = text === '' ? undefined : JSON.parse(text)
  } catch {
    document = undefined
  }
  return { status: response.status, document, text }
}

/** Read a finite number off an unknown record. */
function numberAt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Whether a value can be read field-by-field. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Find the record that carries the activity fields.
 *
 * The CN endpoint wraps twice on some deployments (`{code,data:{data:{…}}}`)
 * while the international one answers the fields at `data`; the shipped desktop
 * reader looks through both, so this does too — but it still requires a
 * recognisable field before treating a record as the activity, so an unrelated
 * wrapper is never read as "no activity".
 */
function activityOf(document: unknown): Record<string, unknown> | undefined {
  if (!isRecord(document)) return undefined
  const candidates: Record<string, unknown>[] = []
  const data = document['data']
  if (isRecord(data)) {
    const inner = data['data']
    if (isRecord(inner)) candidates.push(inner)
    candidates.push(data)
  }
  candidates.push(document)
  for (const candidate of candidates) {
    if ('active' in candidate || 'today_checked_in' in candidate) return candidate
  }
  return undefined
}

/**
 * Interpret one status envelope.
 *
 * `active === false` is reported as `unavailable`, not as "already checked in":
 * the CN endpoint was measured answering an all-false shell for personal
 * accounts, and calling that "today is taken" would hide the fact that the
 * account has no activity at all.
 */
export function interpretCheckinStatus(
  response: { status: number; document: unknown; text: string },
): WorkBuddyCheckinStatus {
  if (response.status !== 200) {
    return { state: 'unknown', reason: `status ${response.status}` }
  }
  const envelope = isRecord(response.document) ? response.document : undefined
  if (envelope === undefined) {
    return { state: 'unknown', reason: `non-JSON response: ${response.text.slice(0, 160)}` }
  }
  const code = numberAt(envelope, 'code')
  if (code !== undefined && code !== 0) {
    return { state: 'unknown', reason: `code ${code}${typeof envelope['msg'] === 'string' ? `: ${(envelope['msg'] as string).slice(0, 160)}` : ''}` }
  }
  const activity = activityOf(response.document)
  if (activity === undefined) {
    return { state: 'unknown', reason: 'no activity fields in the response' }
  }
  const dailyCredit = numberAt(activity, 'daily_credit')
  const todayCredit = numberAt(activity, 'today_credit')
  const streakDays = numberAt(activity, 'streak_days')
  const endTime = typeof activity['end_time'] === 'string' && activity['end_time'] !== ''
    ? activity['end_time']
    : undefined
  const detail = {
    ...dailyCredit === undefined ? {} : { dailyCredit },
    ...todayCredit === undefined ? {} : { todayCredit },
    ...streakDays === undefined ? {} : { streakDays },
    ...endTime === undefined ? {} : { endTime },
  }
  if (activity['active'] === false) return { state: 'unavailable', ...detail }
  if (activity['today_checked_in'] === true) return { state: 'checked-in', ...detail }
  if (activity['active'] === true) return { state: 'claimable', ...detail }
  // `active` absent or of an unexpected type: the activity exists but its
  // state is unreadable, which is not the same as "nothing to claim".
  return { state: 'unknown', reason: 'activity state was not readable', ...detail }
}

/**
 * Interpret one claim envelope.
 *
 * The CN and international claim answers differ only in where the credit sits
 * (`data.credit` on both, per the shipped readers), so one reader serves both.
 * A non-zero `code` is the upstream's refusal; its `msg` is carried verbatim
 * because "already checked in" and "activity ended" are both `code !== 0` and
 * the user needs the distinction.
 */
export function interpretCheckinClaim(
  response: { status: number; document: unknown; text: string },
): WorkBuddyCheckinClaim {
  if (response.status !== 200) {
    return { state: 'failed', reason: `status ${response.status}` }
  }
  if (!isRecord(response.document)) {
    return { state: 'failed', reason: `non-JSON response: ${response.text.slice(0, 160)}` }
  }
  const envelope = response.document
  const code = numberAt(envelope, 'code')
  const message = typeof envelope['msg'] === 'string' ? envelope['msg'] : undefined
  if (code !== undefined && code !== 0) {
    const already = /(already|重复|已签|已领取|已签到|has been|duplicate)/iu.test(message ?? '')
    return {
      state: already ? 'already' : 'failed',
      ...message === undefined ? {} : { reason: message.slice(0, 200) },
    }
  }
  const data = isRecord(envelope['data']) ? envelope['data'] : envelope
  const credit = numberAt(data, 'credit')
  const streakDays = numberAt(data, 'streak_days')
  const isStreakDay = data['is_streak_day']
  return {
    state: 'claimed',
    ...credit === undefined ? {} : { credit },
    ...streakDays === undefined ? {} : { streakDays },
    ...typeof isStreakDay === 'boolean' ? { isStreakDay } : {},
  }
}

/** Options shared by the two calls. */
export interface CheckinOptions {
  /** Region of the credential's endpoint. */
  region: WorkBuddyRegion
  /** Transport override; tests inject a deterministic one. */
  send?: CheckinFetch
  timeoutMs?: number
}

/**
 * Read one account's check-in state.
 *
 * Never throws: every failure becomes `unknown` with a reason, because a sweep
 * over several accounts must not lose the accounts that did answer.
 */
export async function readCheckinStatus(
  credential: WorkBuddyCredential,
  options: CheckinOptions,
): Promise<WorkBuddyCheckinStatus> {
  const timeoutMs = options.timeoutMs ?? CHECKIN_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const send = options.send ?? ((region, path, cred, signal) =>
      fetchJson(region, path, cred, signal, timeoutMs))
    const response = await send(options.region, CHECKIN_STATUS_PATH[options.region], credential, controller.signal)
    return interpretCheckinStatus(response)
  } catch (error: unknown) {
    return { state: 'unknown', reason: `transport error: ${String(error).slice(0, 160)}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Claim today's reward for one account.
 *
 * Never throws, for the same reason as {@link readCheckinStatus}. The caller is
 * expected to have read the status first and skipped accounts that are already
 * checked in or have no activity; this function does not second-guess that, so
 * a direct call is exactly one claim request.
 */
export async function claimCheckin(
  credential: WorkBuddyCredential,
  options: CheckinOptions,
): Promise<WorkBuddyCheckinClaim> {
  const timeoutMs = options.timeoutMs ?? CHECKIN_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const send = options.send ?? ((region, path, cred, signal) =>
      fetchJson(region, path, cred, signal, timeoutMs))
    const response = await send(options.region, CHECKIN_CLAIM_PATH, credential, controller.signal)
    return interpretCheckinClaim(response)
  } catch (error: unknown) {
    return { state: 'failed', reason: `transport error: ${String(error).slice(0, 160)}` }
  } finally {
    clearTimeout(timer)
  }
}

export { CHECKIN_STATUS_PATH, CHECKIN_CLAIM_PATH, CHECKIN_BASES }
