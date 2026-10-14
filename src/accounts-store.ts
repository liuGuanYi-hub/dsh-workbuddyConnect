/**
 * Multi-account slots for WorkBuddy Connect.
 *
 * The plugin's original design follows whichever account the desktop app is
 * signed into: one auth file per product, read on every request. That is
 * exactly right for a single account and exactly wrong for several — the
 * desktop app holds one session at a time, so having a second account
 * available means *parking* the first account's credential somewhere the app
 * will not overwrite, and being able to point the running plugin at it.
 *
 * This module owns that parking lot. A slot is one archived credential plus
 * the identity needed to describe it, stored under `$DSH_HOME` in the same
 * envelope format the plugin already uses for its refresh copy, so the two
 * never disagree about how a credential is serialized.
 *
 * Two rules the rest of the plugin depends on:
 *
 * - **The desktop app's file is never written.** Slots are plugin-owned
 *   copies; switching changes which copy the plugin reads, never what the app
 *   wrote. This preserves the read-only promise the original store makes.
 * - **Nothing changes until the feature is switched on.** With no slots and
 *   no active pointer, {@link WorkBuddyAccountStore.isEnabled} is false and
 *   the credential store follows the desktop file exactly as before.
 *
 * @module dsh-workbuddy-connect/accounts-store
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** Current on-disk format of one slot document; readers reject others. */
const SLOT_FORMAT_VERSION = 1

/** Directory holding every variant's slots, inside the Harness home. */
const ACCOUNTS_DIRNAME = 'workbuddy-accounts'

/** Basename of the pointer naming the active slot, inside each variant's directory. */
const ACTIVE_FILENAME = 'active.json'

/** Longest user-supplied label; keeps the card and CLI output readable. */
const MAX_LABEL_LENGTH = 40

/** One archived account: the credential plus how the UI describes it. */
export interface WorkBuddyAccountSlot {
  /** Stable slot id; also the file basename. Never derived from the uid. */
  id: string
  /** User-facing label; falls back to the nickname when unset. */
  label?: string
  /** When the slot was first created, epoch milliseconds. */
  addedAtMs: number
  /** When the slot was last written, epoch milliseconds. */
  updatedAtMs: number
  /** The archived credential. */
  credential: WorkBuddyCredential
}

/** A slot rendered for the settings card and CLI: no token material. */
export interface WorkBuddyAccountSummary {
  id: string
  label?: string
  nickname?: string
  uid: string
  enterpriseId?: string
  domain: string
  addedAtMs: number
  updatedAtMs: number
  expiresAtMs: number
  /** Whether this slot is the one the plugin currently reads. */
  active: boolean
  /** Whether the slot's access token is already expired. */
  expired: boolean
}

/** The pointer document naming the active slot. */
interface ActiveDocument {
  version: typeof SLOT_FORMAT_VERSION
  activeId: string
}

/** Serialized slot document. */
interface SlotDocument {
  version: typeof SLOT_FORMAT_VERSION
  id: string
  label?: string
  addedAtMs: number
  updatedAtMs: number
  credential: WorkBuddyCredential
}

/** Why a slot operation could not proceed; carried so callers can branch. */
export type WorkBuddyAccountErrorCode =
  | 'slot-not-found'
  | 'slot-exists'
  | 'duplicate-account'
  | 'invalid-id'
  | 'invalid-label'

/** Typed failure for slot operations, never matched by message text. */
export class WorkBuddyAccountError extends Error {
  readonly code: WorkBuddyAccountErrorCode

  constructor(code: WorkBuddyAccountErrorCode, message: string) {
    super(message)
    this.name = 'WorkBuddyAccountError'
    this.code = code
  }
}

/** Slot ids are filenames, so the charset is deliberately narrow. */
const ID_PATTERN = /^[0-9a-z][0-9a-z-]{0,63}$/u

/** Whether a string is usable as a slot id. */
export function isValidSlotId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/**
 * Derive a slot id from the account's uid.
 *
 * Using the uid keeps the id stable across re-imports of the same account, so
 * re-adding an account updates its slot instead of creating a duplicate. The
 * value is hashed and hex-encoded rather than embedded: a uid is an opaque
 * upstream identifier and does not belong in a filename.
 */
export function slotIdForUid(uid: string): string {
  const normalized = uid.trim().toLowerCase()
  if (normalized === '') return 'anonymous'
  // FNV-1a, 32-bit: enough to keep ids distinct within one user's handful of
  // accounts, and dependency-free so this module stays importable from tests
  // without pulling in crypto.
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `acct-${hash.toString(16).padStart(8, '0')}`
}

/** Normalize a user-supplied label, rejecting unusable input. */
function normalizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  const trimmed = label.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new WorkBuddyAccountError(
      'invalid-label',
      `label must be at most ${MAX_LABEL_LENGTH} characters`,
    )
  }
  return trimmed
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Parse a JSON object, returning undefined for anything else. */
function parseObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** Rebuild a credential from stored fields, rejecting token-less documents. */
function parseCredential(value: unknown): WorkBuddyCredential | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const stored = value as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = typeof stored['enterpriseId'] === 'string' && stored['enterpriseId'] !== ''
    ? stored['enterpriseId']
    : undefined
  const nickname = typeof stored['nickname'] === 'string' && stored['nickname'] !== ''
    ? stored['nickname']
    : undefined
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: typeof stored['domain'] === 'string' ? stored['domain'] : '',
    uid: typeof stored['uid'] === 'string' ? stored['uid'] : '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    // A slot is always a plugin-owned copy, so the source is `dsh` regardless
    // of where the credential was originally imported from.
    source: 'dsh',
  }
}

/** Whether two credentials belong to the same upstream account. */
export function sameAccountIdentity(
  left: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>,
  right: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>,
): boolean {
  return left.uid === right.uid && left.enterpriseId === right.enterpriseId
}

/**
 * The per-variant slot store.
 *
 * Every method that mutates disk takes the same file lock the credential
 * store uses, so a switch racing a token refresh cannot interleave a partial
 * write.
 */
export class WorkBuddyAccountStore {
  private readonly variant: WorkBuddyVariant

  constructor(options: { variant: WorkBuddyVariant }) {
    this.variant = options.variant
  }

  /** Directory holding this variant's slots. */
  directory(): string {
    return join(resolveDshHome(), ACCOUNTS_DIRNAME, this.variant.id)
  }

  /** Path of the active-pointer document. */
  private activePath(): string {
    return join(this.directory(), ACTIVE_FILENAME)
  }

  /** Path of one slot document. */
  slotPath(id: string): string {
    return join(this.directory(), `${id}.json`)
  }

  /** Create the slot directory on first write. */
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory(), { recursive: true, mode: 0o700 })
  }

  /**
   * Read every slot. Unreadable or malformed slot files are skipped rather
   * than thrown: one corrupt archive must not hide the others, and the card
   * reports the count it can actually use.
   */
  async list(): Promise<WorkBuddyAccountSlot[]> {
    let names: string[]
    try {
      names = await readdir(this.directory())
    } catch (error: unknown) {
      if (isENOENT(error)) return []
      throw error
    }
    const slots: WorkBuddyAccountSlot[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name === ACTIVE_FILENAME) continue
      const id = name.slice(0, -'.json'.length)
      if (!isValidSlotId(id)) continue
      const slot = await this.readSlot(id)
      if (slot !== undefined) slots.push(slot)
    }
    return slots
  }

  /** Read one slot, or undefined when absent or malformed. */
  async readSlot(id: string): Promise<WorkBuddyAccountSlot | undefined> {
    if (!isValidSlotId(id)) return undefined
    let text: string
    try {
      text = await readFile(this.slotPath(id), 'utf8')
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const document = parseObject(text)
    if (document === undefined) return undefined
    if (document['version'] !== SLOT_FORMAT_VERSION) return undefined
    const credential = parseCredential(document['credential'])
    if (credential === undefined) return undefined
    const label = typeof document['label'] === 'string' && document['label'] !== '' ? document['label'] : undefined
    return {
      id,
      ...label === undefined ? {} : { label },
      addedAtMs: typeof document['addedAtMs'] === 'number' ? document['addedAtMs'] : 0,
      updatedAtMs: typeof document['updatedAtMs'] === 'number' ? document['updatedAtMs'] : 0,
      credential,
    }
  }

  /** The active slot id, or undefined when no slot is selected. */
  async activeId(): Promise<string | undefined> {
    let text: string
    try {
      text = await readFile(this.activePath(), 'utf8')
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const document = parseObject(text)
    if (document === undefined || document['version'] !== SLOT_FORMAT_VERSION) return undefined
    const activeId = typeof document['activeId'] === 'string' ? document['activeId'] : ''
    return isValidSlotId(activeId) ? activeId : undefined
  }

  /**
   * Whether slot mode governs credential resolution.
   *
   * Deliberately requires *both* a slot on disk and a valid pointer: a
   * half-written state (pointer without slots, or slots nobody selected) must
   * fall back to the desktop file, because silently answering with an
   * arbitrary parked account would be worse than following the app.
   */
  async isEnabled(): Promise<boolean> {
    const activeId = await this.activeId()
    if (activeId === undefined) return false
    return await this.readSlot(activeId) !== undefined
  }

  /** The active slot's credential, or undefined when none applies. */
  async activeCredential(): Promise<WorkBuddyCredential | undefined> {
    const activeId = await this.activeId()
    if (activeId === undefined) return undefined
    const slot = await this.readSlot(activeId)
    return slot?.credential
  }

  /**
   * Archive a credential as a slot, keyed by its uid.
   *
   * Re-adding the same account updates the existing slot in place, keeping
   * its original `addedAtMs` and label, so the pointer stays valid across
   * re-imports. A different account never lands in the same slot.
   */
  async save(
    credential: WorkBuddyCredential,
    options: { label?: string; activate?: boolean } = {},
  ): Promise<WorkBuddyAccountSlot> {
    const id = slotIdForUid(credential.uid)
    const existing = await this.readSlot(id)
    const now = Date.now()
    const label = normalizeLabel(options.label) ?? existing?.label
    const slot: WorkBuddyAccountSlot = {
      id,
      ...label === undefined ? {} : { label },
      addedAtMs: existing?.addedAtMs ?? now,
      updatedAtMs: now,
      credential: { ...credential, source: 'dsh' },
    }
    await this.ensureDirectory()
    const document: SlotDocument = {
      version: SLOT_FORMAT_VERSION,
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
      addedAtMs: slot.addedAtMs,
      updatedAtMs: slot.updatedAtMs,
      credential: slot.credential,
    }
    await withFileLock(this.slotPath(id), async () => {
      await writeFileAtomic(this.slotPath(id), `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
    if (options.activate !== false) await this.setActive(id)
    return slot
  }

  /** Point the plugin at one slot. Throws when the slot does not exist. */
  async setActive(id: string): Promise<void> {
    if (!isValidSlotId(id)) {
      throw new WorkBuddyAccountError('invalid-id', `"${id}" is not a valid account id`)
    }
    if (await this.readSlot(id) === undefined) {
      throw new WorkBuddyAccountError('slot-not-found', `no stored account with id "${id}"`)
    }
    await this.ensureDirectory()
    const document: ActiveDocument = { version: SLOT_FORMAT_VERSION, activeId: id }
    await withFileLock(this.activePath(), async () => {
      await writeFileAtomic(this.activePath(), `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Remove a slot. When the removed slot was active the pointer is dropped,
   * handing resolution back to the desktop file rather than silently
   * promoting a different account.
   */
  async remove(id: string): Promise<void> {
    if (!isValidSlotId(id)) {
      throw new WorkBuddyAccountError('invalid-id', `"${id}" is not a valid account id`)
    }
    if (await this.readSlot(id) === undefined) {
      throw new WorkBuddyAccountError('slot-not-found', `no stored account with id "${id}"`)
    }
    await rm(this.slotPath(id), { force: true })
    await rm(`${this.slotPath(id)}.lock`, { force: true })
    if (await this.activeId() === id) {
      await rm(this.activePath(), { force: true })
      await rm(`${this.activePath()}.lock`, { force: true })
    }
  }

  /** Set or clear one slot's label. */
  async relabel(id: string, label: string | undefined): Promise<WorkBuddyAccountSlot> {
    const slot = await this.readSlot(id)
    if (slot === undefined) {
      throw new WorkBuddyAccountError('slot-not-found', `no stored account with id "${id}"`)
    }
    const normalized = normalizeLabel(label)
    // Built field by field rather than by spreading `slot`: the project
    // compiles with `exactOptionalPropertyTypes`, so an explicit
    // `label: undefined` is not assignable to an optional `label?: string`.
    const next: WorkBuddyAccountSlot = {
      id: slot.id,
      ...normalized === undefined ? {} : { label: normalized },
      addedAtMs: slot.addedAtMs,
      updatedAtMs: Date.now(),
      credential: slot.credential,
    }
    const document: SlotDocument = {
      version: SLOT_FORMAT_VERSION,
      id: next.id,
      ...next.label === undefined ? {} : { label: next.label },
      addedAtMs: next.addedAtMs,
      updatedAtMs: next.updatedAtMs,
      credential: next.credential,
    }
    await withFileLock(this.slotPath(id), async () => {
      await writeFileAtomic(this.slotPath(id), `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
    return next
  }

  /** Replace a slot's stored credential after a token refresh. */
  async updateCredential(id: string, credential: WorkBuddyCredential): Promise<void> {
    const slot = await this.readSlot(id)
    if (slot === undefined) return
    await this.save({ ...credential, source: 'dsh' }, {
      ...slot.label === undefined ? {} : { label: slot.label },
      // A refresh must not move the user's selection.
      activate: false,
    })
  }

  /** Slots with their active/expired state, for the card and CLI. */
  async summaries(): Promise<WorkBuddyAccountSummary[]> {
    const activeId = await this.activeId()
    const now = Date.now()
    const slots = await this.list()
    return slots.map((slot) => ({
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
      ...slot.credential.nickname === undefined ? {} : { nickname: slot.credential.nickname },
      uid: slot.credential.uid,
      ...slot.credential.enterpriseId === undefined ? {} : { enterpriseId: slot.credential.enterpriseId },
      domain: slot.credential.domain,
      addedAtMs: slot.addedAtMs,
      updatedAtMs: slot.updatedAtMs,
      expiresAtMs: slot.credential.expiresAtMs,
      active: slot.id === activeId,
      expired: slot.credential.expiresAtMs > 0 && slot.credential.expiresAtMs <= now,
    }))
  }
}

/** Slot directory name, exported for diagnostics and tests. */
export { ACCOUNTS_DIRNAME, ACTIVE_FILENAME, MAX_LABEL_LENGTH }
