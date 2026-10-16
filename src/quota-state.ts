/**
 * Per-account quota observations: which parked accounts the upstream has told
 * us have nothing left to spend.
 *
 * The problem this solves is specific and recurring. WorkBuddy bills per
 * account, and a model like DeepSeek v4.1 Flash burns a cycle quota quickly.
 * When that happens the upstream answers the *next* chat request with
 * `hard_credit` — and until this module existed, the only thing the user saw
 * was a bare `http 402`-flavoured error naming no remedy. Switching accounts
 * was possible the whole time; the plugin simply never said so, and never
 * remembered which account had run dry.
 *
 * Two facts are recorded per account, and they answer different questions:
 *
 * - **exhausted** — the upstream refused a request for this account with an
 *   insufficient-credit verdict. This is a real observation, not a guess, and
 *   it is remembered so the card can mark the account and the next refusal can
 *   name an alternative.
 * - **when it was seen** — so a stale verdict can be aged out and a cycle
 *   reset (which the user cannot observe directly) eventually clears it.
 *
 * Deliberately *not* recorded: how much credit remains. The billing endpoint
 * that answers that costs a request of its own, is already read by the status
 * route, and is the card's job — this file only carries the refusals that no
 * amount of polling would reveal.
 *
 * Keyed by the same `uid:enterpriseId` identity the visibility and catalog
 * stores use, so a slot's verdict follows the account, not the file position.
 * Never a place for secrets: an identity key and two numbers.
 *
 * @module dsh-workbuddy-connect/quota-state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** On-disk format this reader accepts; other versions are discarded. */
const QUOTA_FORMAT_VERSION = 1

/** Basename of the quota-state file inside the Harness home. */
export const WORKBUDDY_QUOTA_FILENAME = '.workbuddy-quota-state.json'

/**
 * How long an exhaustion verdict stays valid before it is treated as stale.
 *
 * WorkBuddy cycles reset on a schedule the plugin cannot read, and a verdict
 * with no expiry would permanently brand an account that has since recovered —
 * the exact failure mode that makes a "switch account" hint untrustworthy.
 * Twelve hours is chosen to survive a working session (a verdict recorded in
 * the morning still applies in the afternoon) while guaranteeing that an
 * overnight reset makes every account eligible again.
 */
export const QUOTA_VERDICT_TTL_MS = 12 * 60 * 60 * 1000

/** One account's recorded verdict. */
interface SavedQuotaVerdict {
  /** `uid:enterpriseId` the verdict belongs to. */
  account: string
  /** When the upstream last refused this account for insufficient credit, epoch ms. */
  exhaustedAtMs: number
  /** How many times exhaustion has been observed, for diagnostics. */
  count: number
}

interface QuotaDocument {
  version: typeof QUOTA_FORMAT_VERSION
  accounts: Record<string, SavedQuotaVerdict>
}

/** One account's quota status, as the card renders it. */
export interface WorkBuddyQuotaStatus {
  /**
   * `exhausted` when the upstream refused this account for insufficient credit
   * and the verdict has not aged out; `ok` otherwise.
   *
   * There is deliberately no `unknown` here: an account with no recorded
   * refusal is one the plugin has no contrary evidence about, and calling that
   * `ok` in the card (rather than a third state) keeps the common case
   * readable. A card that wants to say "we never asked" renders the absence of
   * a row instead.
   */
  state: 'ok' | 'exhausted'
  /** When exhaustion was last observed, epoch ms; only for `exhausted`. */
  exhaustedAtMs?: number
  /** How many refusals have been recorded, for diagnostics. */
  count?: number
}

/** Plugin-owned quota-state path inside the Harness home. */
export function workbuddyQuotaPath(filename: string = WORKBUDDY_QUOTA_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/**
 * The account key a verdict is stored under.
 *
 * Mirrors `visibilityAccountOf`: an identity without a uid is not keyable, and
 * the resulting `":enterpriseId"` would merge every uid-less account into one
 * bucket. Those accounts get no verdicts at all, which is the honest
 * degradation — the hint simply falls back to naming no specific account.
 */
export function quotaAccountOf(identity: { uid: string, enterpriseId?: string }): string | undefined {
  return identity.uid === '' ? undefined : `${identity.uid}:${identity.enterpriseId ?? ''}`
}

/** Whether a parsed value is a verdict this reader can trust. */
function isSaved(value: unknown): value is SavedQuotaVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry['account'] !== 'string' || entry['account'] === '') return false
  if (typeof entry['exhaustedAtMs'] !== 'number' || !Number.isFinite(entry['exhaustedAtMs'])) return false
  const count = entry['count']
  return typeof count === 'number' && Number.isFinite(count) && count >= 1
}

/** Options for {@link WorkBuddyQuotaStore}. */
export interface WorkBuddyQuotaStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string
  /**
   * Verdict lifetime in milliseconds; overridden only by tests, which need a
   * deterministic horizon rather than a twelve-hour one.
   */
  ttlMs?: number
}

/**
 * Recorded per-account quota refusals, read once and written atomically.
 *
 * Writes are best-effort by design: this store sits on the *chat path*, where a
 * refusal is already being reported to the user. Failing the request a second
 * time because a diagnostic file could not be written would trade a useful
 * error for a useless one, so {@link recordExhausted} reports whether it
 * persisted and never throws.
 */
export class WorkBuddyQuotaStore {
  private readonly path: string
  private readonly ttlMs: number
  private accounts: Record<string, SavedQuotaVerdict> | undefined

  constructor(options: WorkBuddyQuotaStoreOptions | string = {}) {
    this.path = typeof options === 'string' ? options : options.path ?? workbuddyQuotaPath()
    this.ttlMs = typeof options === 'string' ? QUOTA_VERDICT_TTL_MS : options.ttlMs ?? QUOTA_VERDICT_TTL_MS
  }

  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  private load(): Record<string, SavedQuotaVerdict> {
    if (this.accounts !== undefined) return this.accounts
    const accounts: Record<string, SavedQuotaVerdict> = {}
    if (existsSync(this.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const document = parsed as Record<string, unknown>
          const raw = document['version'] === QUOTA_FORMAT_VERSION ? document['accounts'] : undefined
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw)) {
              if (isSaved(value)) accounts[key] = value
            }
          }
        }
      } catch {
        // Corrupt or unreadable: treated as "no verdict recorded", which only
        // ever costs the hint its specificity.
      }
    }
    this.accounts = accounts
    return accounts
  }

  /**
   * One account's status, with an aged-out verdict reported as `ok`.
   *
   * The expiry is applied on read rather than by rewriting the file, so a
   * stale verdict costs nothing until the account is actually consulted again.
   *
   * @param account - `uid:enterpriseId` key, or undefined for an unkeyable account.
   */
  status(account: string | undefined): WorkBuddyQuotaStatus {
    if (account === undefined) return { state: 'ok' }
    const saved = this.load()[account]
    if (saved === undefined) return { state: 'ok' }
    if (Date.now() - saved.exhaustedAtMs > this.ttlMs) return { state: 'ok' }
    return { state: 'exhausted', exhaustedAtMs: saved.exhaustedAtMs, count: saved.count }
  }

  /** Whether this account has a live exhaustion verdict. */
  isExhausted(account: string | undefined): boolean {
    return this.status(account).state === 'exhausted'
  }

  /**
   * Record that the upstream refused this account for insufficient credit.
   *
   * The observation count accumulates across a session so a later diagnostic
   * can tell "refused once" from "refused repeatedly", while the timestamp
   * moves forward — each new refusal restarts the verdict's life, because the
   * upstream has just re-confirmed it.
   *
   * @returns whether the verdict was persisted. A false answer is not an error
   *   worth failing a chat request over; the caller may log it.
   */
  recordExhausted(account: string | undefined): boolean {
    if (account === undefined) return false
    const current = this.load()
    const previous = current[account]
    const accounts = {
      ...current,
      [account]: {
        account,
        exhaustedAtMs: Date.now(),
        count: (previous?.count ?? 0) + 1,
      },
    }
    try {
      this.persist(accounts)
    } catch {
      return false
    }
    this.accounts = accounts
    return true
  }

  /**
   * Drop one account's verdict, so a recovered account reads as usable again.
   *
   * Called when a request for that account succeeds: a cycle reset is invisible
   * to the plugin, and the first successful call afterwards is the earliest
   * honest evidence that the refusal no longer holds.
   *
   * @returns whether anything changed.
   */
  clear(account: string | undefined): boolean {
    if (account === undefined) return false
    const current = this.load()
    if (current[account] === undefined) return false
    const accounts = { ...current }
    delete accounts[account]
    try {
      this.persist(accounts)
    } catch {
      return false
    }
    this.accounts = accounts
    return true
  }

  private persist(accounts: Record<string, SavedQuotaVerdict>): void {
    const directory = dirname(this.path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document: QuotaDocument = { version: QUOTA_FORMAT_VERSION, accounts }
    const temporary = resolve(`${this.path}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
