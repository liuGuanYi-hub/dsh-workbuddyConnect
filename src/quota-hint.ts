/**
 * The "your quota ran out — switch accounts" hint.
 *
 * When the upstream refuses a chat request for insufficient credit, the useful
 * reply is not the refusal itself but the remedy: this machine already holds
 * several parked WorkBuddy accounts, and the plugin can switch between them. So
 * the hint answers three questions in one string — *what happened*, *which
 * account it happened on*, and *what to do about it* — and names a concrete
 * alternative when one is available.
 *
 * Kept separate from both the shim (which produces it) and the card (which
 * renders a different, richer view) because the sentence is the one piece of
 * this feature that must read well in a chat transcript, where there is no
 * layout, no colour, and no second chance to explain.
 *
 * Two rules the wording obeys:
 *
 * - **It never claims an alternative definitely has credit.** All the plugin
 *   knows is that the other account has *not been refused yet*. Saying "switch
 *   to X" is honest; saying "X has quota left" would not be.
 * - **It never invents an account.** With no parked accounts, the hint points
 *   at the capture flow instead of naming a slot that does not exist.
 *
 * @module dsh-workbuddy-connect/quota-hint
 */

import type { WorkBuddyAccountSlot } from './accounts-store.ts'
import type { WorkBuddyQuotaStore } from './quota-state.ts'
import { quotaAccountOf } from './quota-state.ts'

/**
 * How many alternatives the hint names before summarising the rest.
 *
 * Two is deliberate: the point is to make the *next step* obvious, and a list
 * of every parked account would bury that step in an error message. The card is
 * where the full list belongs.
 */
const MAX_NAMED_ALTERNATIVES = 2

/** What the hint needs to know about the host's parked accounts. */
export interface QuotaHintAccount {
  /** Slot id, as `accounts use <id>` and the card's button both address it. */
  id: string
  /** The label the user gave it, when they gave one. */
  label?: string
}

/**
 * One account that is not the refused one and carries no live refusal of its own.
 *
 * Carries the nickname as well as the label so {@link quotaHintAccountName} can
 * fall back to it; whether the account is *currently being served* is the
 * caller's knowledge, not this filter's, and is deliberately not modelled here.
 */
export interface QuotaHintAlternative extends QuotaHintAccount {
  nickname?: string
}

/**
 * The display name for one account: its label, else its nickname, else a
 * shortened slot id.
 *
 * A slot always has *some* name to show — a bare "switch to another account"
 * with no noun is not actionable — and the id is the last resort because it is
 * at least the exact string the user would type on the command line.
 */
export function quotaHintAccountName(account: {
  id: string
  label?: string
  nickname?: string
}): string {
  const label = account.label?.trim() ?? ''
  if (label !== '') return label
  const nickname = account.nickname?.trim() ?? ''
  if (nickname !== '') return nickname
  return account.id
}

/**
 * Every parked account that could plausibly serve the next request.
 *
 * Excluded: the account that was just refused, and any account carrying its own
 * live exhaustion verdict — recommending an account the plugin has just watched
 * run dry would send the user in a circle.
 */
export function quotaHintAlternatives(
  slots: readonly WorkBuddyAccountSlot[],
  exhaustedAccount: string | undefined,
  quota: WorkBuddyQuotaStore,
): QuotaHintAlternative[] {
  const candidates: QuotaHintAlternative[] = []
  for (const slot of slots) {
    const identity = quotaAccountOf(slot.credential)
    if (identity !== undefined && identity === exhaustedAccount) continue
    if (quota.isExhausted(identity)) continue
    candidates.push({
      id: slot.id,
      ...slot.label === undefined ? {} : { label: slot.label },
      ...slot.credential.nickname === undefined ? {} : { nickname: slot.credential.nickname },
    })
  }
  return candidates
}

/**
 * Build the sentence appended to a `hard_credit` refusal.
 *
 * @param options.accounts - every parked account, in the order the card lists them.
 * @param options.quota - recorded verdicts, used to avoid recommending a spent account.
 * @param options.exhaustedAccount - the `uid:enterpriseId` key that was refused.
 * @param options.exhaustedName - how to name the refused account; omitted when unkeyable.
 * @returns one line of guidance, always non-empty.
 */
export function quotaExhaustedHint(options: {
  accounts: readonly WorkBuddyAccountSlot[]
  quota: WorkBuddyQuotaStore
  exhaustedAccount: string | undefined
  exhaustedName?: string
}): string {
  const where = options.exhaustedName === undefined ? '' : ` (${options.exhaustedName})`
  const head = `积分/额度已用尽${where}，本账号暂时无法继续请求 DeepSeek v4.1 Flash。`

  const alternatives = quotaHintAlternatives(options.accounts, options.exhaustedAccount, options.quota)

  if (alternatives.length === 0) {
    // Either nothing is parked, or everything parked has been refused too. Both
    // leave the same two real remedies, so they share one honest sentence
    // rather than inventing a difference the plugin cannot observe.
    const tail = options.accounts.length === 0
      ? '还没有停放其他账号：请先在 WorkBuddy 桌面 App 登录另一个账号，再到插件卡片里「捕获」它。'
      : '已停放的账号目前也都标记为额度用尽：请登录并捕获一个新账号，或等额度周期重置后重试。'
    return `${head} ${tail}`
  }

  const named = alternatives.slice(0, MAX_NAMED_ALTERNATIVES).map(quotaHintAccountName)
  const remaining = alternatives.length - named.length
  const more = remaining > 0 ? `（另有 ${remaining} 个可切换账号）` : ''

  return `${head} 检测到 ${alternatives.length} 个尚未用尽的其他账号，可切换后继续：`
    + `${named.join('、')}${more}。`
    + '命令行：accounts use <id>；或打开插件卡片 → WorkBuddy →「多账号」区。'
}
