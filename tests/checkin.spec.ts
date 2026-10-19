import { describe, expect, it } from 'vitest'
import {
  CHECKIN_BASES,
  CHECKIN_CLAIM_PATH,
  CHECKIN_STATUS_PATH,
  claimCheckin,
  interpretCheckinClaim,
  interpretCheckinStatus,
  readCheckinStatus,
} from '../src/checkin.ts'
import { workbuddyBillingHeaders } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * The check-in wire.
 *
 * What this pins is what the shipped desktop client was measured doing
 * (`resources/app.asar`, `main/account.js`): the endpoint pair per region, an
 * empty-object body, and the reading of the two answer shapes. Everything here
 * is about not inventing claims from answers the upstream did not give.
 */

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.cn',
    uid: 'uid-1',
    source: 'dsh',
    ...overrides,
  }
}

/** One canned transport response. */
function response(document: unknown, status = 200) {
  return { status, document, text: JSON.stringify(document) }
}

describe('check-in endpoints', () => {
  it('uses the CN pair the desktop client uses', () => {
    expect(CHECKIN_BASES.cn).toBe('https://www.codebuddy.cn')
    expect(CHECKIN_STATUS_PATH.cn).toBe('/v2/billing/meter/checkin-status')
    expect(CHECKIN_CLAIM_PATH).toBe('/v2/billing/meter/daily-checkin')
  })

  it('uses the international activity-status pair', () => {
    expect(CHECKIN_BASES.global).toBe('https://www.workbuddy.ai')
    expect(CHECKIN_STATUS_PATH.global).toBe('/v2/billing/meter/checkin-activity-status')
  })

  it('presents the same account identity as the billing reads', () => {
    // The gateway splits accounts by this header pair; a check-in that built its
    // own headers would claim the reward for the wrong account.
    const withEnterprise = credential({ enterpriseId: 'ent-1' })
    expect(Object.keys(workbuddyBillingHeaders(withEnterprise)).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'X-Domain',
      'X-Enterprise-Id',
      'X-Tenant-Id',
      'X-User-Id',
    ])
  })
})

describe('interpretCheckinStatus', () => {
  it('reads an inactive activity as unavailable, not as "already done"', () => {
    // Measured shape: the CN personal endpoint answers an all-false shell.
    const status = interpretCheckinStatus(response({
      code: 0,
      msg: 'OK',
      data: { active: false, today_checked_in: false, streak_days: 0, daily_credit: 0, show: false },
    }))
    expect(status.state).toBe('unavailable')
    expect(status.dailyCredit).toBe(0)
  })

  it('reads an active, unclaimed activity as claimable', () => {
    const status = interpretCheckinStatus(response({
      code: 0,
      data: { active: true, today_checked_in: false, streak_days: 2, daily_credit: 100, today_credit: 100 },
    }))
    expect(status).toMatchObject({ state: 'claimable', dailyCredit: 100, streakDays: 2 })
  })

  it('reads an active, already taken activity as checked-in', () => {
    const status = interpretCheckinStatus(response({
      code: 0,
      data: { active: true, today_checked_in: true, daily_credit: 100, end_time: '2026-10-31 23:59:59' },
    }))
    expect(status).toMatchObject({ state: 'checked-in', endTime: '2026-10-31 23:59:59' })
  })

  it('reads a doubly wrapped document at data.data', () => {
    const status = interpretCheckinStatus(response({
      code: 0,
      data: { data: { active: true, today_checked_in: false } },
    }))
    expect(status.state).toBe('claimable')
  })

  it('never turns a failed read into "nothing to claim"', () => {
    expect(interpretCheckinStatus({ status: 500, document: { code: 500 }, text: '{}' }).state).toBe('unknown')
    expect(interpretCheckinStatus({ status: 200, document: undefined, text: '<html>' }).state).toBe('unknown')
    expect(interpretCheckinStatus(response({ code: 401, msg: 'unauthorized' })).state).toBe('unknown')
    // An active activity whose state is unreadable is still not a no-op.
    expect(interpretCheckinStatus(response({ code: 0, data: { active: true } })).state).toBe('claimable')
    expect(interpretCheckinStatus(response({ code: 0, data: { today_checked_in: 'yes' } })).state).toBe('unknown')
  })
})

describe('interpretCheckinClaim', () => {
  it('reads a claimed reward and its credit', () => {
    const claim = interpretCheckinClaim(response({
      code: 0,
      data: { credit: 100, streak_days: 3, is_streak_day: true },
    }))
    expect(claim).toMatchObject({ state: 'claimed', credit: 100, streakDays: 3, isStreakDay: true })
  })

  it('reads a duplicate refusal as "already", and keeps the upstream words', () => {
    const claim = interpretCheckinClaim(response({ code: 1001, msg: 'today already checked in' }))
    expect(claim.state).toBe('already')
    expect(claim.reason).toBe('today already checked in')
  })

  it('keeps an unrecognised refusal as a failure with its message', () => {
    const claim = interpretCheckinClaim(response({ code: 1003, msg: 'activity ended' }))
    expect(claim).toEqual({ state: 'failed', reason: 'activity ended' })
  })

  it('reports transport-shaped answers as failures', () => {
    expect(interpretCheckinClaim({ status: 502, document: undefined, text: 'bad gateway' }).state).toBe('failed')
    expect(interpretCheckinClaim({ status: 200, document: undefined, text: '' }).state).toBe('failed')
  })
})

describe('readCheckinStatus / claimCheckin', () => {
  it('posts an empty body to the region endpoint and never throws', async () => {
    const calls: { region: string, path: string, credential: string }[] = []
    const status = await readCheckinStatus(credential(), {
      region: 'global',
      send: async (region, path, cred) => {
        calls.push({ region, path, credential: cred.accessToken })
        return response({ code: 0, data: { active: true, today_checked_in: false } })
      },
    })
    expect(status.state).toBe('claimable')
    expect(calls).toEqual([{ region: 'global', path: '/v2/billing/meter/checkin-activity-status', credential: 'at-1' }])
  })

  it('degrades a throwing transport to unknown / failed', async () => {
    const status = await readCheckinStatus(credential(), {
      region: 'cn',
      send: async () => { throw new Error('ECONNRESET') },
    })
    expect(status.state).toBe('unknown')
    expect(status.reason).toContain('ECONNRESET')
    const claim = await claimCheckin(credential(), {
      region: 'cn',
      send: async () => { throw new Error('ECONNRESET') },
    })
    expect(claim.state).toBe('failed')
  })

  it('posts the claim to the shared daily-checkin path', async () => {
    const paths: string[] = []
    const claim = await claimCheckin(credential(), {
      region: 'cn',
      send: async (_region, path) => {
        paths.push(path)
        return response({ code: 0, data: { credit: 50 } })
      },
    })
    expect(paths).toEqual(['/v2/billing/meter/daily-checkin'])
    expect(claim).toMatchObject({ state: 'claimed', credit: 50 })
  })
})
