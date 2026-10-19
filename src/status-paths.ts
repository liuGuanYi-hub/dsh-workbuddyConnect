/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-connect/status'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-workbuddy-connect/probe'

/**
 * The international (WorkBuddy AI) variant's own pair of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-workbuddy-connect/ai/status'
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-workbuddy-connect/ai/probe'

/**
 * Same-origin route backing the browser's update reminder.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies; it answers public npm/GitHub metadata only and never token
 * material.
 */
export const WORKBUDDY_UPDATE_PATH = '/plugins/dsh-workbuddy-connect/update'

/**
 * Plugin-owned account-switching endpoint.
 *
 * A write route like the probe route, and gated the same way: loopback
 * Host/Origin plus the in-process key from the status document. Switching
 * accounts changes which credential every later request is sent as, so it is
 * guarded exactly as strictly as probe control — never by the read-only status
 * route alone.
 */
export const WORKBUDDY_ACCOUNTS_PATH = '/plugins/dsh-workbuddy-connect/accounts'
export const WORKBUDDY_AI_ACCOUNTS_PATH = '/plugins/dsh-workbuddy-connect/ai/accounts'

/** One variant's account routes, derived from its id. */
export function accountsPathFor(variantId: string): string {
  return variantId === 'workbuddy' ? WORKBUDDY_ACCOUNTS_PATH : WORKBUDDY_AI_ACCOUNTS_PATH
}

/** One parked account as the card renders it; never carries token material. */
export interface WorkBuddyWebAccount {
  id: string
  label?: string
  nickname?: string
  /** Whether the plugin is currently serving this account. */
  active: boolean
  /** Whether this account's access token is already expired. */
  expired: boolean
  /** Access-token expiry, epoch milliseconds. */
  expiresAt: number
  /**
   * Whether the upstream has refused this account for insufficient credit and
   * the verdict has not aged out.
   *
   * `undefined` means *no refusal has been recorded*, which is not the same as
   * "this account has quota": the plugin only learns an account is spent by
   * being refused, and it never polls for a balance on the chat path. The card
   * renders the difference rather than collapsing both into one badge, so a
   * user reading the list is not misled about what was actually observed.
   */
  exhausted?: boolean
  /** When exhaustion was last observed, epoch milliseconds. */
  exhaustedAt?: number
}

/**
 * Which actions the card may ask for.
 *
 * `capture` archives whatever the desktop app is signed into right now — the
 * only way to import an account whose session the app owns. `use` switches.
 * `remove` unparks. `rename` relabels.
 */
export type WorkBuddyAccountsAction =
  | { action: 'capture', label?: string }
  | { action: 'use', id: string }
  | { action: 'remove', id: string }
  | { action: 'rename', id: string, label?: string }

/** The account section of a status document, absent when unsupported. */
export interface WorkBuddyWebAccountsSection {
  accounts: readonly WorkBuddyWebAccount[]
  /** Directory holding the slots, shown so a user can back it up. */
  directory: string
  /**
   * Whether the desktop app itself currently holds a readable sign-in, which
   * is what `capture` needs. Answered without failing the document: a doctor
   * style probe, so the card can disable the capture control and say why.
   */
  canCapture: boolean
  /** Why capture is unavailable; present only when `canCapture` is false. */
  captureHint?: string
}

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** One account's on-demand quota-check result, as the card renders it. */
export interface WorkBuddyWebQuotaCheck {
  /** Slot id this result belongs to. */
  id: string
  /** The account's display name at check time, for a stable row label. */
  label?: string
  /** Whether the upstream accepted a request for this account. */
  state: 'available' | 'exhausted' | 'unknown'
  /** HTTP status observed; 0 for a transport failure. */
  status: number
  /** Why the state is `unknown`; absent otherwise. */
  reason?: string
  /** When this check ran, epoch milliseconds. */
  checkedAt: number
}

/**
 * The quota-check section of the status document.
 *
 * Present only once a check has run in this process, so the card can tell
 * "never checked" from "checked and found nothing" — the same distinction the
 * account rows make for a recorded refusal, and for the same reason: a
 * capability that has not been exercised must not read as a clean bill.
 */
export interface WorkBuddyWebQuotaCheckSection {
  /** The model every result describes. */
  model: string
  /** When the most recent sweep finished, epoch milliseconds. */
  checkedAt: number
  /** Whether a sweep is running right now, so the card can disable its button. */
  running: boolean
  results: readonly WorkBuddyWebQuotaCheck[]
}

/** One account's daily check-in result, as the card renders it. */
export interface WorkBuddyWebCheckinRow {
  /** Slot id this row belongs to. */
  id: string
  /** The account's display name at check time, for a stable row label. */
  label?: string
  /**
   * What the status read said:
   * `unavailable` (no activity for this account), `claimable` (still available
   * when the sweep started), `checked-in` (today's reward is taken), or
   * `unknown` (the upstream could not be asked).
   */
  status: 'unavailable' | 'claimable' | 'checked-in' | 'unknown'
  /** What the sweep did: claimed the reward, skipped it, or failed to. */
  outcome: 'claimed' | 'skipped' | 'failed'
  /** Credits granted by this claim, when the upstream named a number. */
  credit?: number
  /** What today's reward is worth, when the status named a number. */
  dailyCredit?: number
  /** Consecutive check-in days, when the upstream counted them. */
  streakDays?: number
  /** Why nothing was claimed, or why the claim failed. */
  reason?: string
}

/**
 * The daily check-in section of the status document.
 *
 * Presence in the document is the card's capability signal: a host without a
 * slot store omits it and renders no sign-in control. Present but with no rows
 * means a sweep has run and there was nothing to report.
 */
export interface WorkBuddyWebCheckinSection {
  /** When the most recent sweep finished, epoch milliseconds; 0 if never. */
  checkedAt: number
  /** Whether a sweep is running right now, so the card can disable its button. */
  running: boolean
  rows: readonly WorkBuddyWebCheckinRow[]
}

/** One account's balance row in the automatic-switch section. */
export interface WorkBuddyWebAutoSwitchRow {
  /** Slot id. */
  id: string
  label?: string
  /** Whether this is the account currently being served. */
  active: boolean
  /**
   * Remaining credit, when the billing read succeeded.
   *
   * Absent when `error` is set, and absent for an `unlimited` account — the
   * upstream's "no cap" is a sentinel, not a number, and rendering it as one
   * would be a wrong number rather than a visible absence.
   */
  remaining?: number
  /** The account's cycle quota is uncapped. */
  unlimited?: boolean
  /** Why this account's balance could not be read. */
  error?: string
}

/**
 * The automatic-switch section of the status document.
 *
 * Present whenever the feature is wired at all, unlike the quota-check section:
 * the *decision* it last reached is useful even while the feature is off (it
 * shows what would have happened), and the card needs somewhere to render the
 * threshold and the enable/disable control. `enabled` is what distinguishes
 * "configured but idle" from "actively moving accounts".
 */
export interface WorkBuddyWebAutoSwitchSection {
  /** Whether automatic switching is on. */
  enabled: boolean
  /** Remaining credit at or below which the served account is abandoned. */
  threshold: number
  /** Shortest interval between two balance-driven switches, milliseconds. */
  cooldownMs: number
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** When the last sweep finished, epoch milliseconds; 0 if never. */
  checkedAt: number
  /** One row per parked account, in slot order. */
  rows: readonly WorkBuddyWebAutoSwitchRow[]
  /**
   * Why the last sweep did not switch.
   *
   * A closed vocabulary rather than a sentence so the card can localise it and
   * tests can branch on it; the host never sends prose the browser has to match.
   */
  stayReason?: string
  /** Why the last sweep switched, when it did. */
  moveReason?: string
  /** The account the last sweep switched to, when it switched. */
  movedTo?: string
  /** The account the last sweep switched away from, when it switched. */
  movedFrom?: string
  /** Why a decided switch could not be carried out. */
  switchError?: string
  /** When the most recent automatic switch happened, epoch milliseconds. */
  lastSwitchAt?: number
  /** How many automatic switches this process has performed. */
  switchCount: number
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the international card preference;
   * `set-model-visibility` hides or shows one model for the signed-in
   * account's picker; `check-quota` tests every parked account against one
   * model and reports which still have quota left; `checkin` reads every
   * parked account's daily check-in state and claims whatever reward is still
   * unclaimed.
   *
   * All nine are writes, which is why they share this route's in-process key
   * and loopback guard rather than the read-only status GET. `check-quota` and
   * `checkin` earn their place here for the same reason as `probe`: each spends
   * a real upstream request per parked account, and `checkin` also performs a
   * state-changing claim. `set-auto-switch` and `auto-switch-now` are here
   * because both decide which account every later request is billed to — the
   * same authority the accounts route guards, for the same reason.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'set-model-visibility' | 'check-quota' | 'checkin' | 'set-auto-switch' | 'auto-switch-now'
  /**
   * Target model id; required for `probe` and `set-model-visibility`.
   *
   * For `check-quota` it is optional: omitted means the model the plugin
   * serves by default (see `QUOTA_CHECK_MODEL`), which is what the card sends.
   */
  model?: string
  /** Requested value for `set-maximum-context-window`, `set-model-visibility` and `set-auto-switch`. */
  enabled?: boolean
  /**
   * Requested remaining-credit floor for `set-auto-switch`.
   *
   * Optional so a toggle can flip the feature without restating the threshold;
   * a value that is present but unusable (negative, non-finite) is refused by
   * the route rather than clamped, because "switch always" is never something a
   * user meant to ask for.
   */
  threshold?: number
  /** Requested picker visibility for `set-model-visibility`. */
  visible?: boolean
  /**
   * Expected account key for `set-model-visibility`: the `visibility.account`
   * the card rendered its checkboxes from. The host refuses the write when the
   * signed-in account has moved on, so a stale card can never land one
   * account's toggle in another account's bucket.
   */
  account?: string
}

/**
 * Model-visibility section of the status document (issue #36).
 *
 * Present only when an account with a stable user id is signed in: the
 * preferences are per account, so a credential without a uid has nothing to
 * key them by and the card renders no visibility controls rather than editing
 * a bucket every uid-less account would share. The account key is the same
 * non-secret `uid:enterpriseId` identity the saved catalogs use — never a
 * token.
 */
export interface WorkBuddyWebVisibilitySection {
  /** The `uid:enterpriseId` identity these preferences belong to. */
  account: string
  /** Model ids this account has hidden from the picker (the full list, including ids not in the current catalog). */
  disabled: readonly string[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * The plan requires the card to distinguish a live catalog from the built-in
 * fallback, and to say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface WorkBuddyWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** App version used as the catalog User-Agent, when the variant needed one. */
  appVersion?: string
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /** When the package lapses, in epoch milliseconds; absent when unknown. */
  endTimeMs?: number
}

/** Credit lapsing inside one horizon, as the card reports it. */
export interface WorkBuddyWebExpiringCredits {
  /** Sum of the contributing packages' remaining credit. */
  total: number
  /** How many packages contribute. */
  packages: number
  /** Soonest expiry among them, epoch milliseconds. */
  earliestEndTimeMs?: number
}

/**
 * Credit at risk, bucketed by horizon.
 *
 * Only present when the upstream actually reported end times — a card must not
 * read "no expiry data" as "nothing expires soon".
 *
 * Future horizons only: the billing query behind this covers `valid` + `usedUp`
 * packages from the current time forward, so a lapsed package is never in the
 * set and has no bucket here.
 */
export interface WorkBuddyWebCreditExpiry {
  within24h: WorkBuddyWebExpiringCredits
  within3d: WorkBuddyWebExpiringCredits
  within7d: WorkBuddyWebExpiringCredits
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
  /** Credit lapsing soon, for the card's warning banner. */
  expiry?: WorkBuddyWebCreditExpiry
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
  /**
   * Context capacity in tokens, taken verbatim from the upstream
   * `maxAllowedSize`/`maxInputTokens`, or from the international document's
   * `contextWindow.defaultLength` when it declares one.
   *
   * The international card can opt into the largest declared alternative. The
   * selected value is what DSH receives as its actual context budget.
   */
  contextWindow?: number
  /** The upstream default, when the card currently uses a selected maximum. */
  defaultContextWindow?: number
  /**
   * The international document's larger selectable window, when it declares
   * one, and the model's maximum input ceiling.
   *
   * Kept apart from {@link contextWindow} because they answer different
   * questions: `contextWindow` is the budget the plugin actually requests under,
   * while these are facts about what the upstream will accept. Showing the 1M
   * ceiling as though it were the working window would overstate the budget.
   */
  maxContextWindow?: number
  maxInputTokens?: number
}

/**
 * Why no credential is usable, as a closed enum the browser half switches on.
 *
 * Deliberately separate from `reason`: `reason` is free text meant for a human
 * to read, so matching on it would break the moment the wording changes. This
 * is the machine-readable half, and the card uses it — never a substring of
 * `reason` — to decide whether the Agent assist block applies.
 */
export type WorkBuddySignedOutReasonCode =
  /** Nobody is signed in; nothing diagnosable beyond that. */
  | 'no-credential'
  /** A credential for the *other* product was found in this variant's file. */
  | 'credential-region-mismatch'
  /** An encrypted credential exists but could not be opened (wrong key, GCM failure, helper crash). */
  | 'encrypted-credential-unreadable'
  /** A product on a supported platform: discovery ran to completion and found no usable candidate. */
  | 'electron-binary-not-found'
  /** A product on a supported platform: discovery found more than one distinct usable app. */
  | 'electron-binary-ambiguous'
  /** No auto-discovery for this product/platform and no explicit path configured. */
  | 'electron-binary-unavailable'
  /** An explicit path (option or env) is set but missing or not executable. */
  | 'electron-path-invalid'
  /** Discovery could not finish: tool missing, timeout, output overflow, unreadable plist. */
  | 'electron-discovery-incomplete'

/** Every reason code, for validation without trusting a wire value. */
const SIGNED_OUT_REASON_CODES: readonly WorkBuddySignedOutReasonCode[] = [
  'no-credential',
  'credential-region-mismatch',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
]

/** Whether a value is one of the closed set of signed-out reason codes. */
export function isWorkBuddySignedOutReasonCode(value: unknown): value is WorkBuddySignedOutReasonCode {
  return typeof value === 'string' && (SIGNED_OUT_REASON_CODES as readonly string[]).includes(value)
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — today a credential belonging to the other product.
     * The card renders it in place of the generic sign-in hint.
     */
    reason?: string
    /** Machine-readable companion to `reason`; see {@link WorkBuddySignedOutReasonCode}. */
    reasonCode?: WorkBuddySignedOutReasonCode
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyWebModelBadge[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: WorkBuddyWebCatalog
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /** International-card preference selecting larger declared context windows. */
    useMaximumContextWindow?: boolean
    /** Per-account hidden-model state for the card's visibility controls. */
    visibility?: WorkBuddyWebVisibilitySection
    /**
     * Parked accounts and which one is being served. Absent on a host with no
     * account store, which is the card's signal to render no switcher at all.
     */
    accounts?: WorkBuddyWebAccountsSection
    /**
     * The model a `check-quota` sweep targets when the card names none.
     *
     * Presence of this field is the card's capability signal for the quota
     * button: a host that cannot run a sweep omits it and the card renders no
     * button at all, rather than one whose click can only be refused.
     */
    quotaCheckModel?: string
    /**
     * Results of the last on-demand quota check, when one has run. Absent until
     * then, which is the card's signal to render no result rows at all.
     */
    quotaCheck?: WorkBuddyWebQuotaCheckSection
    /**
     * The daily check-in sweep.
     *
     * Presence is the card's capability signal for the check-in control; the
     * section itself appears only once a sweep has run, so its own presence
     * answers "has anyone pressed this yet" separately from "can this host do
     * it at all".
     */
    checkin?: WorkBuddyWebCheckinSection
    /**
     * Automatic account switching.
     *
     * Presence is the card's capability signal: a host without a slot store has
     * nothing to switch between and omits the section, so the card renders no
     * control rather than one that can only be refused. Unlike `checkin`, the
     * section appears even before the first sweep — the enable toggle and the
     * threshold are configuration, and a user who has just switched the feature
     * on needs to see it acknowledged.
     */
    autoSwitch?: WorkBuddyWebAutoSwitchSection
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
  }
  | { status: 'error'; message: string }
