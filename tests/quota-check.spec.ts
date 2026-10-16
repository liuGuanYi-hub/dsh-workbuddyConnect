import { describe, expect, it } from 'vitest'
import {
  QUOTA_CHECK_MODEL,
  checkAccounts,
  checkOneAccount,
  interpretQuotaCheck,
} from '../src/quota-check.ts'
import type { ProbeAttempt } from '../src/probe.ts'

/**
 * The pure half of the on-demand quota check: what one upstream answer means,
 * and what a sweep of many accounts reports.
 *
 * The distinction these tests exist to protect is `unknown` versus `exhausted`.
 * Reporting an undecided check as a spent account sends the user to burn a
 * second account for nothing, so every inconclusive shape has to stay
 * inconclusive.
 */

describe('interpretQuotaCheck', () => {
  it('reads a streamed 200 as acceptance', () => {
    expect(interpretQuotaCheck({ status: 200, streamed: true }).state).toBe('available')
  })

  it('refuses to read a silent 200 as acceptance', () => {
    // The upstream opened a response and said nothing usable. The probe treats
    // that as inconclusive, and so must the quota check — it is not evidence
    // that the account may spend.
    const result = interpretQuotaCheck({ status: 200, streamed: false })
    expect(result.state).toBe('unknown')
  })

  it('reads a 402 as an exhausted account', () => {
    expect(interpretQuotaCheck({ status: 402, streamed: false, detail: 'http 402' }).state)
      .toBe('exhausted')
  })

  it('honours an insufficient-credit body behind an unexpected status', () => {
    // The verdict is spelled in the body, and the status is not always 402.
    // Reading the status alone would miss exactly the refusals this check
    // exists to catch.
    const attempt: ProbeAttempt = {
      status: 403,
      streamed: false,
      body: '{"msg":"余额不足，请充值 (insufficient credit)"}',
    }
    expect(interpretQuotaCheck(attempt).state).toBe('exhausted')
  })

  it('classifies from the body rather than the extError code', () => {
    // A JSON error collapses `detail` to `extError.code`; the credit verdict
    // lives in the message fields. Feeding only the code would report this as
    // `unknown` — the one mistake this test exists to prevent.
    const attempt: ProbeAttempt = {
      status: 400,
      streamed: false,
      errorCode: 'some_other_code',
      detail: 'some_other_code',
      body: '{"extError":{"code":"some_other_code"},"msg":"积分不足，请充值后再试"}',
    }
    expect(interpretQuotaCheck(attempt).state).toBe('exhausted')
  })

  it('keeps a dead session unknown, because re-signing is not switching accounts', () => {
    const result = interpretQuotaCheck({ status: 401, streamed: false, detail: 'http 401' })
    expect(result.state).toBe('unknown')
    expect(result.reason).toContain('401')
  })

  it('carries the upstream code and detail into the reason', () => {
    const result = interpretQuotaCheck({
      status: 429,
      streamed: false,
      errorCode: 'rate_limited',
      detail: 'too many requests',
    })
    expect(result.state).toBe('unknown')
    expect(result.reason).toContain('429')
    expect(result.reason).toContain('rate_limited')
    expect(result.reason).toContain('too many requests')
  })

  it('reports a transport failure as unknown with its cause', () => {
    const result = interpretQuotaCheck({ status: 0, streamed: false, detail: 'socket hung up' })
    expect(result.state).toBe('unknown')
    expect(result.reason).toContain('socket hung up')
  })
})

describe('checkOneAccount', () => {
  it('returns the account, its label and the observed status', async () => {
    const result = await checkOneAccount({
      id: 'acct-1',
      label: '工作号',
      send: async () => ({ status: 200, streamed: true }),
    })
    expect(result).toEqual({ id: 'acct-1', label: '工作号', state: 'available', status: 200 })
  })

  it('omits a label it was not given rather than storing an undefined key', async () => {
    const result = await checkOneAccount({
      id: 'acct-2',
      send: async () => ({ status: 402, streamed: false }),
    })
    expect('label' in result).toBe(false)
  })

  it('turns a sender that throws into an unknown row instead of failing', async () => {
    const result = await checkOneAccount({
      id: 'acct-3',
      send: async () => { throw new Error('dns failure') },
    })
    expect(result.state).toBe('unknown')
    expect(result.status).toBe(0)
    expect(result.reason).toContain('dns failure')
  })

  it('abandons a request that outlives the timeout', async () => {
    // A sender that honours its signal must not be able to stall the sweep
    // past one request; the whole sweep is sequential.
    const result = await checkOneAccount({
      id: 'acct-4',
      timeoutMs: 5,
      send: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) })
      }),
    })
    expect(result.state).toBe('unknown')
    expect(result.status).toBe(0)
  })
})

describe('checkAccounts', () => {
  it('tests every account in order and reports one row each', async () => {
    const probed: string[] = []
    const results = await checkAccounts([
      { id: 'acct-1', send: async () => { probed.push('acct-1'); return { status: 200, streamed: true } } },
      { id: 'acct-2', send: async () => { probed.push('acct-2'); return { status: 402, streamed: false } } },
    ])
    expect(probed).toEqual(['acct-1', 'acct-2'])
    expect(results.map(result => result.state)).toEqual(['available', 'exhausted'])
  })

  it('keeps the other rows when one target throws unexpectedly', async () => {
    const results = await checkAccounts([
      { id: 'acct-1', send: async () => ({ status: 200, streamed: true }) },
      {
        id: 'acct-2',
        send: (): Promise<ProbeAttempt> => { throw new Error('a bug') },
      },
      { id: 'acct-3', send: async () => ({ status: 200, streamed: true }) },
    ])
    // The value of the sweep is the comparison between accounts, so one bad
    // row must not erase the two honest ones beside it.
    expect(results).toHaveLength(3)
    expect(results[1]).toMatchObject({ id: 'acct-2', state: 'unknown' })
    expect(results[2]?.state).toBe('available')
  })
})

describe('QUOTA_CHECK_MODEL', () => {
  it('targets the model the user burns credit on', () => {
    expect(QUOTA_CHECK_MODEL).toBe('deepseek-v4.1-flash')
  })
})
