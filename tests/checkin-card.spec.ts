import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'

/**
 * The daily check-in control inside the card's account section.
 *
 * What a user would notice going wrong: the control appearing on a host that
 * cannot run it, a press spending requests without asking first, or a result row
 * that describes a different account than the one it sits under.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acct-1',
    label: '工作号',
    nickname: '一号',
    active: true,
    expired: false,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  }
}

describe('WorkBuddy check-in control', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: Record<string, unknown>
  let posts: { url: string, body: unknown }[]
  let released: (() => void)[]
  let postResponse: { ok: boolean, status?: number, body: unknown }
  const request = vi.fn()

  function status(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      nickname: '一号',
      expiresAt: Date.now() + 3_600_000,
      probeKey: 'test-key',
      credits: { total: 100, accounts: [] },
      models: [],
      accounts: {
        accounts: [account()],
        directory: '/tmp/x',
        canCapture: true,
      },
      ...overrides,
    }
  }

  beforeEach(() => {
    status()
    posts = []
    released = []
    postResponse = { ok: true, body: { state: 'checked', reason: '1 claimed, 0 failed of 1' } }
    request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      posts.push({ url, body: JSON.parse(String(init.body)) as unknown })
      await new Promise<void>(resolve => { released.push(resolve) })
      return {
        ok: postResponse.ok,
        status: postResponse.status ?? (postResponse.ok ? 200 : 400),
        json: async () => postResponse.body,
      }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      confirm: () => true,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    view = undefined
    vi.unstubAllGlobals()
  })

  async function mountCard(): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(WorkBuddyPluginCard, { t }))
    })
    view = renderer
    await act(async () => { renderer!.root.findAllByType('button')[0]!.props.onClick() })
    return renderer!
  }

  function textOf(renderer: ReactTestRenderer): string {
    return JSON.stringify(renderer.toJSON())
  }

  function button(renderer: ReactTestRenderer, label: string): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
    return renderer.root.findAll(node => node.type === 'button'
      && node.children.join('') === label)[0]
  }

  it('renders no control when the host declares no check-in capability', async () => {
    const renderer = await mountCard()
    expect(button(renderer, t('checkinStart'))).toBeUndefined()
    expect(textOf(renderer)).not.toContain(t('checkinStart'))
  })

  it('asks for confirmation before spending one request per account', async () => {
    // The capability signal is the section itself, which the host only sends
    // once a sweep has run; this is the empty-after-first-press document.
    status({ checkin: { checkedAt: Date.now(), running: false, rows: [] } })
    const renderer = await mountCard()
    const start = button(renderer, t('checkinStart'))
    expect(start).toBeDefined()

    await act(async () => { start!.props.onClick() })
    // Nothing sent yet: the confirm block is the only outcome of the first press.
    expect(posts).toEqual([])
    expect(textOf(renderer)).toContain(t('checkinConfirm', { count: 1 }))

    const confirm = button(renderer, t('checkinConfirmAction'))
    expect(confirm).toBeDefined()
    await act(async () => { confirm!.props.onClick() })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual({ url: expect.stringContaining('/probe'), body: { action: 'checkin' } })

    await act(async () => { released.forEach(release => { release() }) })
  })

  it('renders the rows a sweep reported, named from the live account list', async () => {
    status({
      checkin: {
        checkedAt: Date.now(),
        running: false,
        rows: [
          { id: 'acct-1', status: 'claimable', outcome: 'claimed', credit: 100 },
          { id: 'acct-2', label: '旧名字', status: 'checked-in', outcome: 'skipped' },
          { id: 'acct-3', status: 'unavailable', outcome: 'skipped' },
        ],
      },
      accounts: {
        accounts: [
          account({ id: 'acct-1', label: '工作号' }),
          // Renamed since the sweep: the live name wins over the stored one.
          account({ id: 'acct-2', label: '个人号', active: false }),
          account({ id: 'acct-3', label: '备用号', active: false }),
        ],
        directory: '/tmp/x',
        canCapture: true,
      },
    })
    const renderer = await mountCard()
    const text = textOf(renderer)
    expect(text).toContain(t('checkinClaimed', { credit: 100 }))
    expect(text).toContain(t('checkinToday'))
    expect(text).toContain(t('checkinNoActivity'))
    expect(text).toContain('个人号')
    expect(text).not.toContain('旧名字')
    // The summary line says what the sweep earned rather than only that it ran.
    expect(text).toContain(t('checkinResult', { claimed: 1, credits: 100, skipped: 2, failed: 0 }))
  })

  it('surfaces a failed row with the upstream reason', async () => {
    status({
      checkin: {
        checkedAt: Date.now(),
        running: false,
        rows: [{ id: 'acct-1', status: 'unknown', outcome: 'failed', reason: 'status 401' }],
      },
    })
    const renderer = await mountCard()
    const text = textOf(renderer)
    expect(text).toContain(t('checkinFailed'))
    expect(text).toContain('status 401')
  })
})
