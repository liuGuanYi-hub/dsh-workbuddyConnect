/**
 * Same-origin account-switching route for the WorkBuddy plugin card.
 *
 * Read-only listing rides the status document; this route owns the *writes*
 * (capture, use, remove, rename). It is guarded exactly like the probe route —
 * loopback Host/Origin plus the in-process key — because a switch changes the
 * account every subsequent request is billed to, which is at least as
 * sensitive as starting a probe.
 *
 * Two rules hold throughout:
 *
 * - **No token material crosses to the browser.** The route answers with the
 *   same summarised rows the status document carries, never credential fields.
 * - **The desktop app's file is never written.** Capture reads it; nothing here
 *   modifies it.
 *
 * @module dsh-workbuddy-connect/accounts-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorkBuddyAccountError } from './accounts-store.ts'
import type { WorkBuddyAccountStore } from './accounts-store.ts'
import type { WorkBuddyCredential } from './auth.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { accountsPathFor } from './status-paths.ts'
import type { WorkBuddyAccountsAction, WorkBuddyWebAccount, WorkBuddyWebAccountsSection } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyAccountsRouteOptions {
  /** The variant's slot store, or undefined when this host has none. */
  accounts: WorkBuddyAccountStore | undefined
  /**
   * Reads whatever the desktop app is signed into right now, bypassing the
   * slots. Required for `capture`: once an account is parked, the ordinary
   * resolution path serves that slot, so capturing a second account has to
   * consult the app directly.
   */
  desktopCredential: () => Promise<WorkBuddyCredential | undefined>
  /** Called after any change so the host can re-read the served account. */
  onChange?: () => void | Promise<void>
  /** Route path to mount; defaults to the CN variant's. */
  path?: string
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read a size-capped request body, or undefined when it is too large. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Constant-time-ish comparison, matching the probe route's guard. */
function keyMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index)
  }
  return diff === 0
}

/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text: string): WorkBuddyAccountsAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  const label = wrapped['label']
  const id = wrapped['id']
  // A label is optional but must be a string when present; the store applies
  // its own length limit and reports a typed error for a bad one.
  const parsedLabel = label === undefined ? undefined : typeof label === 'string' ? label : undefined
  if (label !== undefined && parsedLabel === undefined) return undefined
  if (action === 'capture') {
    return { action: 'capture', ...parsedLabel === undefined ? {} : { label: parsedLabel } }
  }
  if (typeof id !== 'string' || id === '') return undefined
  if (action === 'use' || action === 'remove') return { action, id }
  if (action === 'rename') {
    return { action: 'rename', id, ...parsedLabel === undefined ? {} : { label: parsedLabel } }
  }
  return undefined
}

/**
 * Summarise a variant's parked accounts for the card.
 *
 * Exported so the status route and this one render the identical shape; a
 * second implementation would be free to drift from it.
 */
export async function workBuddyAccountsSection(
  accounts: WorkBuddyAccountStore | undefined,
  canCapture: () => Promise<{ ok: boolean, hint?: string }>,
): Promise<WorkBuddyWebAccountsSection | undefined> {
  if (accounts === undefined) return undefined
  const summaries = await accounts.summaries()
  const rows: WorkBuddyWebAccount[] = summaries.map(summary => ({
    id: summary.id,
    ...summary.label === undefined ? {} : { label: summary.label },
    ...summary.nickname === undefined ? {} : { nickname: summary.nickname },
    active: summary.active,
    expired: summary.expired,
    expiresAt: summary.expiresAtMs,
  }))
  const capture = await canCapture()
  return {
    accounts: rows,
    directory: accounts.directory(),
    canCapture: capture.ok,
    ...capture.hint === undefined ? {} : { captureHint: capture.hint },
  }
}

/**
 * The switching route's handler, extracted so tests can mount it on a bare
 * server with a known key.
 */
export function workBuddyAccountsHandler(
  deps: WorkBuddyAccountsRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-workbuddy-probe-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-probe-key' })
      return
    }
    const accounts = deps.accounts
    if (accounts === undefined) {
      json(res, 404, { error: 'accounts-unavailable' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      switch (action.action) {
        case 'capture': {
          // Read the app's own sign-in, never `current()`: after a first
          // account is parked, `current()` serves that slot and capturing a
          // second account would overwrite the first.
          const credential = await deps.desktopCredential()
          if (credential === undefined) {
            json(res, 409, { error: 'no-desktop-sign-in' })
            return
          }
          const slot = await accounts.save(credential, {
            ...action.label === undefined ? {} : { label: action.label },
          })
          await deps.onChange?.()
          json(res, 200, {
            state: 'captured',
            id: slot.id,
            ...slot.label === undefined ? {} : { label: slot.label },
          })
          return
        }
        case 'use': {
          await accounts.setActive(action.id)
          await deps.onChange?.()
          json(res, 200, { state: 'switched', id: action.id })
          return
        }
        case 'remove': {
          await accounts.remove(action.id)
          await deps.onChange?.()
          json(res, 200, { state: 'removed', id: action.id })
          return
        }
        case 'rename': {
          const slot = await accounts.relabel(action.id, action.label)
          await deps.onChange?.()
          json(res, 200, {
            state: 'renamed',
            id: slot.id,
            ...slot.label === undefined ? {} : { label: slot.label },
          })
          return
        }
      }
    } catch (error: unknown) {
      // A typed slot error is the user's mistake (unknown id, bad label) and
      // is reported as such; anything else is an internal failure.
      if (error instanceof WorkBuddyAccountError) {
        json(res, 400, { error: error.code, message: safeMessage(error) })
        return
      }
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the POST accounts route on an optional webServer context. */
export function registerWorkBuddyAccountsRoute(
  ctx: Context,
  deps: WorkBuddyAccountsRouteOptions & { key: string, variantId: string },
): void {
  const path = deps.path ?? accountsPathFor(deps.variantId)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyAccountsHandler(deps, deps.key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web accounts route')
}
