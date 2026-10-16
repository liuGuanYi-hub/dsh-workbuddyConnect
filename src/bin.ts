#!/usr/bin/env node
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, workbuddyOwnAuthPath } from './auth.ts'
import { WorkBuddyAccountError, WorkBuddyAccountStore } from './accounts-store.ts'
import { WorkBuddyQuotaStore, quotaAccountOf, workbuddyQuotaPath } from './quota-state.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from './catalog.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'
import { atRestKeyProviderFor } from './desktop-credential-protection.ts'
import { CN_VARIANT, variantFor, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'
import { resolveAppVersion } from './app-version.ts'

type Action = 'accounts' | 'doctor' | 'logout' | 'status'

/** Account subcommands, each acting on the slot store for one variant. */
type AccountsCommand = 'add' | 'list' | 'remove' | 'rename' | 'use'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-workbuddy-connect <doctor|status|logout|accounts> [options]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, remaining WorkBuddy credit, and host-bundle health',
    '  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  accounts manage parked accounts and switch between them:',
    '             accounts list                      parked accounts, * marks the active one',
    '             accounts add [--label <name>]      archive the account the app is signed into',
    '             accounts use <id>                  serve that account from now on',
    '             accounts rename <id> [--label <name>]',
    '             accounts remove <id>',
    '',
    '  --provider  which product to inspect; defaults to workbuddy',
    `              one of: ${WORKBUDDY_VARIANTS.map(variant => variant.id).join(', ')}`,
    '  --label     display name for accounts add / rename',
    '  --json      emit one secret-free JSON document (all commands except logout)',
    '',
    '  Sign in to each account in the desktop app and run `accounts add` once per',
    '  account; slots live under $DSH_HOME and the app\'s own auth file is never written.',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * One variant's store plus the client that performs its refreshes.
 *
 * The key provider is built by the same shared helper the plugin host uses,
 * so the CLI's `doctor`/`status` and the browser card can never disagree
 * about which product's Electron a variant resolves.
 */
function makeStore(variant: WorkBuddyVariant): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({
    variant,
    refresh: credential => client.refreshToken(credential),
    keyProvider: atRestKeyProviderFor(variant),
  })
}

/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant: WorkBuddyVariant): string {
  return makeStore(variant).ownAuthPath()
}

/** Fallback roster size for one variant. */
function fallbackCount(variant: WorkBuddyVariant): number {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length
}

async function doctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const status = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const desktopFormat = await store.desktopAuthFormat()
  // Name the file that was actually hit (e.g. the XDG data-home copy on
  // UOS/deepin, issue #43), falling back to the first *possible* location
  // when none exists so the hint still says where to point WORKBUDDY_AUTH_FILE.
  const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  // Only the international variant needs a UA, and reading it is how `doctor`
  // answers "where would the catalog version come from" without guessing.
  const appVersion = variant.region === 'global' ? await resolveAppVersion() : undefined
  // A signed-out state beside an encrypted file usually means the unlock
  // failed, not that nobody is signed in: the status reason carries the real
  // cause, it is promoted to the first hint, and the generic "sign in again"
  // hint is suppressed — sending the user to re-login would be the wrong fix.
  const decryptionNote = status.state === 'signed-out' && desktopFormat === 'encrypted' && status.reason !== undefined
    ? `Encrypted desktop credential could not be used: ${status.reason}`
    : undefined
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-workbuddy-connect',
    version: WORKBUDDY_CONNECT_VERSION,
    node: process.version,
    provider: variant.id,
    displayName: variant.displayName,
    desktopAuthFile: {
      path: desktopPath ?? `(no platform default; set ${variant.env})`,
      present: desktopPresent,
      // How the file reads on disk: absent | plaintext | encrypted |
      // unrecognized. WorkBuddy 5.6 seals its token fields, so "encrypted"
      // is a healthy state, not an error — the unlock is attempted (and its
      // failure explained) by the sign-in state below.
      format: desktopFormat,
    },
    ownAuthFile: ownAuthPath(variant),
    ...appVersion === undefined ? {} : {
      catalogUserAgent: {
        version: appVersion.version,
        source: appVersion.source,
        ...appVersion.bundle === undefined ? {} : { bundle: appVersion.bundle },
      },
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    fallbackModels: fallbackCount(variant),
    hints: [
      ...decryptionNote !== undefined ? [decryptionNote]
        : status.state === 'signed-out' ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
      ...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson({ ...report, ...decryptionNote === undefined ? {} : { decryptionNote } })
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} — ${desktopFormat} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...appVersion === undefined ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && desktopPresent ? 0 : 1
}

async function status(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const client = new WorkBuddyUpstreamClient()
  const authStatus = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    if (jsonOutput) {
      printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-workbuddy-connect', version: WORKBUDDY_CONNECT_VERSION, provider: variant.id, status: 'signed-out', hostBundle: hostState })
    } else {
      process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`)
    }
    return 1
  }
  let credits: { total: number; unlimited?: true; error?: string } | undefined
  try {
    const credential = await store.current()
    if (credential !== undefined) {
      const fetched = await client.fetchCredits(credential)
      credits = {
        total: fetched.total,
        ...fetched.unlimited === true ? { unlimited: true } : {},
      }
    }
  } catch (error: unknown) {
    credits = { total: 0, error: safeMessage(error) }
  }
  const expiresAt = authStatus.expiresAtMs !== undefined ? new Date(authStatus.expiresAtMs).toISOString() : undefined
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy-connect',
      version: WORKBUDDY_CONNECT_VERSION,
      provider: variant.id,
      status: 'signed-in',
      ...expiresAt === undefined ? {} : { accessTokenExpires: expiresAt },
      ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
      ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
      source: authStatus.source,
      credits: credits?.total,
      ...credits?.unlimited === true ? { creditsUnlimited: true } : {},
      ...credits?.error === undefined ? {} : { creditsError: credits.error },
      hostBundle: hostState,
    })
    return 0
  }
  process.stdout.write([
    `${variant.displayName} Connect: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    credits?.error !== undefined
      ? `Remaining credit: unavailable (${credits.error})`
      // An uncapped quota has no balance to print; showing the placeholder 0
      // would read as "exhausted".
      : credits?.unlimited === true
        ? 'Remaining credit: unlimited'
        : `Remaining credit: ${credits?.total ?? 'unknown'}`,
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
    '',
  ].join('\n'))
  return 0
}

/** A slot row for the CLI, with no token material. */
interface AccountRow {
  id: string
  label?: string
  nickname?: string
  uid: string
  domain: string
  expiresAt: string
  active: boolean
  expired: boolean
  /** Whether the upstream has refused this account for insufficient credit. */
  quota: 'ok' | 'exhausted'
  /** When that refusal was last observed, ISO-8601; only when `exhausted`. */
  exhaustedAt?: string
}

/** Render slots plus the active pointer for `accounts list --json`. */
async function accountRows(
  store: WorkBuddyAccountStore,
  quota: WorkBuddyQuotaStore,
): Promise<{ rows: AccountRow[], activeId?: string }> {
  const activeId = await store.activeId()
  const summaries = await store.summaries()
  return {
    rows: summaries.map((summary) => {
      const status = quota.status(quotaAccountOf(summary))
      const exhausted = status.state === 'exhausted'
      return {
        id: summary.id,
        ...summary.label === undefined ? {} : { label: summary.label },
        ...summary.nickname === undefined ? {} : { nickname: summary.nickname },
        uid: summary.uid,
        domain: summary.domain,
        expiresAt: new Date(summary.expiresAtMs).toISOString(),
        active: summary.active,
        expired: summary.expired,
        // Always stated on the CLI, unlike the status document's optional
        // fields: a terminal shows one account per line, so there is room to
        // say "not observed" instead of leaving the reader to infer it.
        quota: exhausted ? 'exhausted' : 'ok',
        ...status.exhaustedAtMs === undefined
          ? {}
          : { exhaustedAt: new Date(status.exhaustedAtMs).toISOString() },
      }
    }),
    ...activeId === undefined ? {} : { activeId },
  }
}

/** Human-readable label for one slot. */
function rowLabel(row: AccountRow): string {
  const name = row.label ?? row.nickname
  return name === undefined ? row.id : `${name} (${row.id})`
}

/**
 * `accounts` — manage parked accounts for one variant.
 *
 * `add` archives whatever the desktop app is signed into right now, which is
 * the only way to capture an account whose sign-in the app owns: sign in, run
 * `add`, repeat. `use` moves the pointer the running plugin resolves against,
 * so a switch needs no restart.
 */
async function accounts(
  jsonOutput: boolean,
  variant: WorkBuddyVariant,
  command: string | undefined,
  operands: readonly string[],
  label: string | undefined,
): Promise<number> {
  const store = new WorkBuddyAccountStore({ variant })
  // One reader for every listing command: `list` and `use` both report the
  // recorded quota verdicts, and they must not disagree within one invocation.
  const quota = new WorkBuddyQuotaStore(workbuddyQuotaPath(variant.quotaFilename))

  if (command === undefined || command === 'list') {
    const { rows, activeId } = await accountRows(store, quota)
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-workbuddy-connect',
        version: WORKBUDDY_CONNECT_VERSION,
        provider: variant.id,
        directory: store.directory(),
        ...activeId === undefined ? {} : { activeId },
        accounts: rows,
      })
      return 0
    }
    if (rows.length === 0) {
      process.stdout.write([
        `${variant.displayName}: no stored accounts`,
        `Add one after signing in: dsh-workbuddy-connect accounts add [--label <name>] --provider ${variant.id}`,
        '',
      ].join('\n'))
      return 0
    }
    process.stdout.write([
      `${variant.displayName} accounts (${rows.length}):`,
      ...rows.map(row => `  ${row.active ? '*' : ' '} ${rowLabel(row)}`
        + `${row.nickname === undefined || row.label === undefined ? '' : ` as ${row.nickname}`}`
        + ` — token ${row.expired ? 'expired' : `expires ${row.expiresAt}`}`
        + `${row.quota === 'exhausted' ? ` — QUOTA EXHAUSTED${row.exhaustedAt === undefined ? '' : ` since ${row.exhaustedAt}`}` : ''}`),
      '',
      '(* = currently served; switch with: accounts use <id>)',
      ...rows.some(row => row.quota === 'exhausted')
        ? ['', 'QUOTA EXHAUSTED = the upstream refused this account for insufficient credit; switch to another one.']
        : [],
      '',
    ].join('\n'))
    return 0
  }

  if (command === 'add') {
    // Read the app's own sign-in, not `current()`: once one account is parked
    // slot mode governs `current()`, so using it here would re-import the
    // already-stored account instead of the one the app just switched to.
    const live = makeStore(variant)
    const credential = await live.desktopCredential()
    if (credential === undefined) {
      process.stderr.write(
        `dsh-workbuddy-connect: no signed-in ${variant.appName} account found;`
        + ' sign in once in the desktop app, then run accounts add again\n',
      )
      return 1
    }
    const slot = await store.save(credential, label === undefined ? {} : { label })
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-workbuddy-connect',
        version: WORKBUDDY_CONNECT_VERSION,
        provider: variant.id,
        added: { id: slot.id, ...slot.label === undefined ? {} : { label: slot.label }, uid: slot.credential.uid },
        activeId: slot.id,
      })
      return 0
    }
    process.stdout.write([
      `${variant.displayName}: stored ${rowLabel({
        id: slot.id,
        ...slot.label === undefined ? {} : { label: slot.label },
        ...slot.credential.nickname === undefined ? {} : { nickname: slot.credential.nickname },
        uid: slot.credential.uid,
        domain: slot.credential.domain,
        expiresAt: new Date(slot.credential.expiresAtMs).toISOString(),
        active: true,
        expired: false,
        // A freshly captured account has just been read from the desktop app, so
        // any verdict from a previous life of this slot is stale by definition.
        quota: quota.status(quotaAccountOf(slot.credential)).state === 'exhausted' ? 'exhausted' : 'ok',
      })} and selected it`,
      '',
    ].join('\n'))
    return 0
  }

  if (command === 'use') {
    const id = operands[0]
    if (id === undefined) {
      process.stderr.write('dsh-workbuddy-connect: accounts use needs an account id (see accounts list)\n')
      return 1
    }
    await store.setActive(id)
    const { rows, activeId } = await accountRows(store, quota)
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-workbuddy-connect',
        version: WORKBUDDY_CONNECT_VERSION,
        provider: variant.id,
        ...activeId === undefined ? {} : { activeId },
        accounts: rows,
      })
      return 0
    }
    const active = rows.find(row => row.active)
    process.stdout.write(
      `${variant.displayName}: now serving ${active === undefined ? id : rowLabel(active)};`
      + ' the running plugin picks this up on its next request\n',
    )
    return 0
  }

  if (command === 'rename') {
    const id = operands[0]
    if (id === undefined) {
      process.stderr.write('dsh-workbuddy-connect: accounts rename needs an account id and an optional label\n')
      return 1
    }
    const slot = await store.relabel(id, label)
    process.stdout.write(`${variant.displayName}: ${slot.id} is now ${slot.label ?? '(unnamed)'}\n`)
    return 0
  }

  if (command === 'remove') {
    const id = operands[0]
    if (id === undefined) {
      process.stderr.write('dsh-workbuddy-connect: accounts remove needs an account id (see accounts list)\n')
      return 1
    }
    await store.remove(id)
    // Removing the active slot hands resolution back to the desktop file
    // rather than silently promoting another parked account, so the message
    // says which of the two happened.
    const stillSelected = await store.isEnabled()
    process.stdout.write([
      `${variant.displayName}: removed ${id}`,
      ...stillSelected ? [] : ['No account is selected now, so the plugin follows the desktop app again.'],
      '',
    ].join('\n'))
    return 0
  }

  process.stderr.write(
    `dsh-workbuddy-connect: unknown accounts command ${JSON.stringify(command)};`
    + ' expected add, list, remove, rename, or use\n',
  )
  return 1
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['accounts', 'doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-workbuddy-connect: expected accounts, doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the CN provider, so
  // every existing invocation keeps its behaviour. `--label <text>` names a
  // slot on `accounts add` / `accounts rename`.
  let providerId: string | undefined
  let label: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    if (flag === '--label') {
      label = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--label=')) {
      label = flag.slice('--label='.length)
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CN_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  const positional = rest.filter(flag => !flag.startsWith('--'))
  const unknown = rest.filter(flag => flag.startsWith('--') && flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'accounts': {
        const [command, ...operands] = positional
        return await accounts(jsonOutput, variant, command, operands, label)
      }
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await status(jsonOutput, variant)
      case 'logout': {
        const store = makeStore(variant)
        // Only this variant's plugin-owned copy is removed: the desktop app's
        // own sign-in is never touched, and the model group is not promised to
        // disappear (the desktop file may still supply a credential).
        await store.logout()
        process.stdout.write(
          `${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`,
        )
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
