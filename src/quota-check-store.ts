/**
 * The persisted result of the last on-demand quota sweep.
 *
 * A sweep spends one real (if minimal) request per parked account, so what it
 * learns must survive the process that paid for it. Without this file the
 * answer would live only in the plugin host's memory: a DSH restart would erase
 * it, and the CLI — a separate process that a user runs precisely when they are
 * deciding which account to switch to — could never read it at all.
 *
 * Scope is deliberately *one sweep*, not a history. The rows describe one model
 * at one instant, and older sweeps against the same accounts would be merged
 * into the same rows anyway; keeping them would invite reading a three-day-old
 * `available` beside a fresh `exhausted` and averaging them.
 *
 * Stored per slot id rather than per account identity, because the sweep is
 * defined over the parked slots and their labels, and a slot is what the card
 * and `accounts list` rows are keyed by.
 *
 * Carries no token material: slot ids, display names, a model id, HTTP statuses
 * and timestamps. Written atomically like every other plugin-owned file under
 * `$DSH_HOME`, and never written by the desktop app.
 *
 * @module dsh-workbuddy-connect/quota-check-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyQuotaCheckResult } from './quota-check.ts'

/** On-disk format this reader accepts; other versions are discarded. */
const QUOTA_CHECK_FORMAT_VERSION = 1

/** Basename of the last-sweep file inside the Harness home. */
export const WORKBUDDY_QUOTA_CHECK_FILENAME = '.workbuddy-quota-check.json'

/** One account's persisted row from the last sweep. */
interface SavedQuotaCheckResult {
  /** Slot id the row belongs to. */
  id: string
  /** Display name at check time, so a renamed slot's history stays readable. */
  label?: string
  state: WorkBuddyQuotaCheckResult['state']
  /** HTTP status observed, or 0 for a transport failure. */
  status: number
  /** Why the state is `unknown`; absent otherwise. */
  reason?: string
}

interface QuotaCheckDocument {
  version: typeof QUOTA_CHECK_FORMAT_VERSION
  /** The model every row of this sweep was checked against. */
  model: string
  /** When the sweep finished, epoch milliseconds. */
  checkedAtMs: number
  /** Rows keyed by slot id. */
  results: Record<string, SavedQuotaCheckResult>
}

/** The last sweep, read back from disk. */
export interface WorkBuddyQuotaCheckSweep {
  model: string
  checkedAtMs: number
  /** Rows in slot order as written, newest label kept per account. */
  results: readonly WorkBuddyQuotaCheckResult[]
}

/** Plugin-owned last-sweep path inside the Harness home. */
export function workbuddyQuotaCheckPath(filename: string = WORKBUDDY_QUOTA_CHECK_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Options for {@link WorkBuddyQuotaCheckStore}. */
export interface WorkBuddyQuotaCheckStoreOptions {
  /** Explicit file path, overriding the `$DSH_HOME` default. */
  path?: string
}

/** Whether a parsed value is a row this reader can trust. */
function isSaved(value: unknown): value is SavedQuotaCheckResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry['id'] !== 'string' || entry['id'] === '') return false
  if (entry['state'] !== 'available' && entry['state'] !== 'exhausted' && entry['state'] !== 'unknown') return false
  return typeof entry['status'] === 'number' && Number.isFinite(entry['status'])
}

/**
 * Read once, write atomically.
 *
 * Writes are best-effort by design, matching {@link module:dsh-workbuddy-connect/quota-state}:
 * the caller is reporting a result the user has already paid for, and failing
 * the sweep because its record could not be persisted would throw away the
 * answer rather than protect it.
 */
export class WorkBuddyQuotaCheckStore {
  private readonly path: string
  private document: QuotaCheckDocument | undefined
  private loaded = false

  constructor(options: WorkBuddyQuotaCheckStoreOptions | string = {}) {
    this.path = typeof options === 'string' ? options : options.path ?? workbuddyQuotaCheckPath()
  }

  /** Resolved file path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  private load(): QuotaCheckDocument | undefined {
    if (this.loaded) return this.document
    this.loaded = true
    if (!existsSync(this.path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const document = parsed as Record<string, unknown>
      if (document['version'] !== QUOTA_CHECK_FORMAT_VERSION) return undefined
      if (typeof document['model'] !== 'string' || document['model'] === '') return undefined
      const checkedAtMs = document['checkedAtMs']
      if (typeof checkedAtMs !== 'number' || !Number.isFinite(checkedAtMs)) return undefined
      const raw = document['results']
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
      const results: Record<string, SavedQuotaCheckResult> = {}
      for (const [key, value] of Object.entries(raw)) {
        // A row that disagrees with its own key is not trusted: it would render
        // under one account and describe another.
        if (isSaved(value) && value.id === key) results[key] = value
      }
      this.document = {
        version: QUOTA_CHECK_FORMAT_VERSION,
        model: document['model'],
        checkedAtMs,
        results,
      }
      return this.document
    } catch {
      // Corrupt or unreadable reads as "never checked", which is what the card
      // and CLI report rather than a guess.
      return undefined
    }
  }

  /** The last sweep, or undefined when none is recorded. */
  last(): WorkBuddyQuotaCheckSweep | undefined {
    const document = this.load()
    if (document === undefined) return undefined
    return {
      model: document.model,
      checkedAtMs: document.checkedAtMs,
      results: Object.values(document.results).map(saved => ({
        id: saved.id,
        ...saved.label === undefined ? {} : { label: saved.label },
        state: saved.state,
        status: saved.status,
        ...saved.reason === undefined ? {} : { reason: saved.reason },
      })),
    }
  }

  /**
   * Replace the recorded sweep with this one.
   *
   * Whole-document replacement, not a merge: a sweep is a complete statement
   * about every parked account at one instant, and merging would keep vouching
   * for an account that was removed since, or for a model nobody re-checked.
   *
   * @returns whether the sweep was persisted.
   */
  record(sweep: WorkBuddyQuotaCheckSweep): boolean {
    const results: Record<string, SavedQuotaCheckResult> = {}
    for (const result of sweep.results) {
      results[result.id] = {
        id: result.id,
        ...result.label === undefined ? {} : { label: result.label },
        state: result.state,
        status: result.status,
        ...result.reason === undefined ? {} : { reason: result.reason },
      }
    }
    const document: QuotaCheckDocument = {
      version: QUOTA_CHECK_FORMAT_VERSION,
      model: sweep.model,
      checkedAtMs: sweep.checkedAtMs,
      results,
    }
    try {
      const directory = dirname(this.path)
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
      const temporary = resolve(`${this.path}.tmp`)
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch {
      return false
    }
    this.document = document
    this.loaded = true
    return true
  }
}
