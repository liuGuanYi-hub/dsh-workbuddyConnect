import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  quotaExhaustedHint,
  quotaHintAccountName,
  quotaHintAlternatives,
} from '../src/quota-hint.ts'
import { WorkBuddyQuotaStore, quotaAccountOf } from '../src/quota-state.ts'
import type { WorkBuddyAccountSlot } from '../src/accounts-store.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function tempQuota(): Promise<WorkBuddyQuotaStore> {
  const directory = await mkdtemp(join(tmpdir(), 'wb-hint-'))
  CLEANUP.push(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return new WorkBuddyQuotaStore({ path: join(directory, 'quota.json') })
}

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'dsh',
    ...overrides,
  }
}

function slot(id: string, overrides: { label?: string, nickname?: string, uid?: string } = {}): WorkBuddyAccountSlot {
  const { label, nickname, uid } = overrides
  return {
    id,
    ...label === undefined ? {} : { label },
    addedAtMs: 0,
    updatedAtMs: 0,
    credential: credential({
      uid: uid ?? id,
      ...nickname === undefined ? {} : { nickname },
    }),
  }
}

describe('quotaHintAccountName', () => {
  it('prefers the user label', () => {
    expect(quotaHintAccountName({ id: 'acct-1', label: 'Epiphany', nickname: '昵称' })).toBe('Epiphany')
  })

  it('falls back to the nickname', () => {
    expect(quotaHintAccountName({ id: 'acct-1', nickname: '昵称' })).toBe('昵称')
  })

  it('falls back to the id, which is what the CLI addresses', () => {
    expect(quotaHintAccountName({ id: 'acct-1' })).toBe('acct-1')
  })

  it('ignores a blank label rather than showing nothing', () => {
    expect(quotaHintAccountName({ id: 'acct-1', label: '   ' })).toBe('acct-1')
  })
})

describe('quotaHintAlternatives', () => {
  it('excludes the account that was just refused', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-a', { label: 'A' }), slot('acct-b', { label: 'B' })]
    const alternatives = quotaHintAlternatives(slots, quotaAccountOf(slots[0]!.credential), quota)
    expect(alternatives.map(a => a.id)).toEqual(['acct-b'])
  })

  it('excludes accounts carrying their own verdict', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-a', { label: 'A' }), slot('acct-b', { label: 'B' }), slot('acct-c', { label: 'C' })]
    quota.recordExhausted(quotaAccountOf(slots[1]!.credential))
    // Recommending an account the plugin has watched run dry sends the user in
    // a circle, so it must not appear as an option.
    const alternatives = quotaHintAlternatives(slots, quotaAccountOf(slots[0]!.credential), quota)
    expect(alternatives.map(a => a.id)).toEqual(['acct-c'])
  })

  it('treats an unkeyable account as a candidate rather than dropping it', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-x', { label: 'X', uid: '' })]
    const alternatives = quotaHintAlternatives(slots, 'someone-else', quota)
    expect(alternatives.map(a => a.id)).toEqual(['acct-x'])
  })
})

describe('quotaExhaustedHint', () => {
  it('names the refused account and a concrete alternative', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-a', { label: 'Epiphany' }), slot('acct-b', { label: '子丹' })]
    const hint = quotaExhaustedHint({
      accounts: slots,
      quota,
      exhaustedAccount: quotaAccountOf(slots[0]!.credential),
      exhaustedName: 'Epiphany',
    })
    expect(hint).toContain('额度已用尽')
    expect(hint).toContain('Epiphany')
    expect(hint).toContain('子丹')
    expect(hint).toContain('accounts use <id>')
  })

  it('never claims the alternative still has credit', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-a', { label: 'A' }), slot('acct-b', { label: 'B' })]
    const hint = quotaExhaustedHint({
      accounts: slots,
      quota,
      exhaustedAccount: quotaAccountOf(slots[0]!.credential),
    })
    // The honest claim is "not yet refused". Saying an account *has* quota
    // would assert something the plugin cannot observe.
    expect(hint).toContain('尚未用尽')
    expect(hint).not.toMatch(/有(剩余|足够)额度|还有额度/u)
  })

  it('summarises the remainder instead of listing every account', async () => {
    const quota = await tempQuota()
    const slots = [
      slot('acct-a', { label: '一号' }),
      slot('acct-b', { label: '二号' }),
      slot('acct-c', { label: '三号' }),
      slot('acct-d', { label: '四号' }),
    ]
    const hint = quotaExhaustedHint({
      accounts: slots,
      quota,
      exhaustedAccount: quotaAccountOf(slots[0]!.credential),
    })
    expect(hint).toContain('二号')
    expect(hint).toContain('三号')
    expect(hint).toContain('另有 1 个')
    // The point of the cap: naming every account would bury the next step.
    expect(hint).not.toContain('四号')
  })

  it('points at the capture flow when nothing is parked', async () => {
    const quota = await tempQuota()
    const hint = quotaExhaustedHint({ accounts: [], quota, exhaustedAccount: 'u1:' })
    expect(hint).toContain('还没有停放其他账号')
    expect(hint).toContain('捕获')
    // A non-existent slot must never be named.
    expect(hint).not.toContain('accounts use <id>')
  })

  it('says so when every parked account has been refused too', async () => {
    const quota = await tempQuota()
    const slots = [slot('acct-a', { label: 'A' }), slot('acct-b', { label: 'B' })]
    for (const one of slots) quota.recordExhausted(quotaAccountOf(one.credential))
    const hint = quotaExhaustedHint({
      accounts: slots,
      quota,
      exhaustedAccount: quotaAccountOf(slots[0]!.credential),
    })
    expect(hint).toContain('也都标记为额度用尽')
    expect(hint).toContain('额度周期重置')
  })

  it('omits the account name when it cannot be keyed', async () => {
    const quota = await tempQuota()
    const hint = quotaExhaustedHint({
      accounts: [slot('acct-a', { label: 'A' })],
      quota,
      exhaustedAccount: undefined,
    })
    expect(hint).toContain('额度已用尽')
    expect(hint).not.toContain('(undefined)')
  })

  it('is always non-empty, so it can be appended unconditionally', async () => {
    const quota = await tempQuota()
    for (const accounts of [[], [slot('acct-a')]]) {
      const hint = quotaExhaustedHint({ accounts, quota, exhaustedAccount: 'u1:' })
      expect(hint.trim().length).toBeGreaterThan(0)
    }
  })
})
