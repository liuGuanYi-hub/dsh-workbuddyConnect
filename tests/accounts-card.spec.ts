import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'

/**
 * The multi-account switcher in the plugin card.
 *
 * These pin the behaviours a user would notice going wrong: capture being
 * offered when the app has nothing to capture, a switch leaving the wrong row
 * marked active, and a failed write quietly replacing the account figures with
 * an error.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** One parked account as the status document reports it. */
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

describe('WorkBuddy account switcher', () => {
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
      ...overrides,
    }
  }

  beforeEach(() => {
    status({
      accounts: {
        accounts: [account()],
        directory: '/home/.dsh/workbuddy-accounts/workbuddy',
        canCapture: true,
      },
    })
    posts = []
    released = []
    postResponse = { ok: true, body: { state: 'switched' } }
    request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      posts.push({ url, body: JSON.parse(String(init.body)) as unknown })
      // Hold each write open until the test releases it, so "in flight" is
      // observable rather than a race against the microtask queue.
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
    // Unmount inside `act` and before the globals are restored: the card's poll
    // effect reads `window` while tearing down, so an unstubbed or unbatched
    // teardown makes React report that throw as a detached-tree error.
    act(() => view?.unmount())
    view = undefined
    vi.unstubAllGlobals()
  })

  /** Mount the card, expand it, and let the first read settle. */
  async function mountCard(): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(WorkBuddyPluginCard, { t }))
    })
    view = renderer
    // The header toggle is the first button; the rest only exist once the card
    // is expanded, which is what the account section needs.
    await act(async () => { renderer!.root.findAllByType('button')[0]!.props.onClick() })
    return renderer!
  }

  /** All rendered text, for assertions about copy. */
  function textOf(renderer: ReactTestRenderer): string {
    return JSON.stringify(renderer.toJSON())
  }

  /** Find a button whose label matches. */
  function button(renderer: ReactTestRenderer, label: string): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
    return renderer.root.findAll(node => node.type === 'button'
      && node.children.join('') === label)[0]
  }

  it('renders the parked accounts with the active one marked', async () => {
    const renderer = await mountCard()
    const text = textOf(renderer)
    expect(text).toContain('工作号')
    expect(text).toContain(t('accountsActive'))
    expect(text).toContain(t('accountsHeading'))
  })

  it('offers no switch control for the account already in use', async () => {
    const renderer = await mountCard()
    expect(button(renderer, t('accountsUse'))).toBeUndefined()
    // Remove stays available: the active account is still removable.
    expect(button(renderer, t('accountsRemove'))).toBeDefined()
  })

  it('sends a use action with the account id and refreshes', async () => {
    status({
      accounts: {
        accounts: [
          account({ id: 'acct-1', label: '工作号', active: false }),
          account({ id: 'acct-2', label: '个人号', active: true }),
        ],
        directory: '/tmp/x',
        canCapture: true,
      },
    })
    const renderer = await mountCard()
    const use = button(renderer, t('accountsUse'))
    expect(use).toBeDefined()

    await act(async () => { use!.props.onClick() })
    // The label flips to the in-flight copy while the write is held open.
    expect(textOf(renderer)).toContain(t('accountsUsing'))
    expect(posts[0]?.body).toEqual({ action: 'use', id: 'acct-1' })
    expect(posts[0]?.url).toContain('/accounts')

    await act(async () => { released.forEach(release => { release() }) })
    expect(textOf(renderer)).not.toContain(t('accountsUsing'))
  })

  it('disables capture when the desktop app has no readable sign-in', async () => {
    status({
      accounts: {
        accounts: [],
        directory: '/tmp/x',
        canCapture: false,
        captureHint: 'Sign in to WorkBuddy first.',
      },
    })
    const renderer = await mountCard()
    const capture = button(renderer, t('accountsCapture'))
    expect(capture?.props.disabled).toBe(true)
    expect(textOf(renderer)).toContain('Sign in to WorkBuddy first.')
  })

  it('captures the current sign-in', async () => {
    status({ accounts: { accounts: [], directory: '/tmp/x', canCapture: true } })
    const renderer = await mountCard()
    const capture = button(renderer, t('accountsCapture'))
    expect(capture?.props.disabled).toBe(false)

    await act(async () => { capture!.props.onClick() })
    expect(posts[0]?.body).toEqual({ action: 'capture' })

    await act(async () => { released.forEach(release => { release() }) })
  })

  it('reports a capture failure without discarding the account figures', async () => {
    status({ accounts: { accounts: [], directory: '/tmp/x', canCapture: true } })
    postResponse = { ok: false, status: 409, body: { error: 'no-desktop-sign-in' } }
    const renderer = await mountCard()
    const capture = button(renderer, t('accountsCapture'))

    await act(async () => { capture!.props.onClick() })
    await act(async () => { released.forEach(release => { release() }) })

    const text = textOf(renderer)
    // The specific copy for this failure, not the raw code. It rides the
    // card's existing "failed action" notice, so the account figures survive.
    expect(text).toContain(t('accountsCaptureFailed'))
    expect(text).toContain(t('accountsError', { message: t('accountsCaptureFailed') }))
    // And the credit total the user was reading is still on screen.
    expect(text).toContain('100')
  })

  it('confirms before removing and sends the removal when accepted', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      confirm,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    const renderer = await mountCard()
    const remove = button(renderer, t('accountsRemove'))

    await act(async () => { remove!.props.onClick() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(posts[0]?.body).toEqual({ action: 'remove', id: 'acct-1' })

    await act(async () => { released.forEach(release => { release() }) })
  })

  it('does not remove when the confirmation is declined', async () => {
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      confirm: () => false,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    const renderer = await mountCard()
    const remove = button(renderer, t('accountsRemove'))

    await act(async () => { remove!.props.onClick() })
    expect(posts).toHaveLength(0)
  })

  it('renders no switcher when the host sends no account section', async () => {
    status({ accounts: undefined })
    const renderer = await mountCard()
    const text = textOf(renderer)
    expect(text).not.toContain(t('accountsHeading'))
    expect(button(renderer, t('accountsCapture'))).toBeUndefined()
  })

  it('falls back to the nickname when an account has no label', async () => {
    status({
      accounts: {
        accounts: [account({ id: 'acct-9', label: undefined, nickname: '二号' })],
        directory: '/tmp/x',
        canCapture: true,
      },
    })
    const renderer = await mountCard()
    expect(textOf(renderer)).toContain('二号')
  })

  it('marks an expired account', async () => {
    status({
      accounts: {
        accounts: [account({ expired: true })],
        directory: '/tmp/x',
        canCapture: true,
      },
    })
    const renderer = await mountCard()
    expect(textOf(renderer)).toContain(t('accountsExpired'))
  })

  it('shows where the accounts are stored', async () => {
    status({
      accounts: {
        accounts: [],
        directory: '/custom/slot/dir',
        canCapture: true,
      },
    })
    const renderer = await mountCard()
    expect(textOf(renderer)).toContain('/custom/slot/dir')
  })

  /** Find the rename editor's text input, when a row is being edited. */
  function renameInput(renderer: ReactTestRenderer): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
    return renderer.root.findAll(node => node.type === 'input')[0]
  }

  /** Type into the open editor. */
  async function type(renderer: ReactTestRenderer, value: string): Promise<void> {
    const input = renameInput(renderer)
    expect(input).toBeDefined()
    await act(async () => { input!.props.onChange({ target: { value } }) })
  }

  /**
   * Submit the open editor the way a user does.
   *
   * The form's `onSubmit` is invoked rather than a click on the Save button:
   * Save is `type="submit"` and therefore carries no `onClick` of its own, and
   * React's `onSubmit` is exactly the handler the browser would call for both
   * Enter and a click. It runs inside `act` because the handler awaits the
   * write and only then updates state, and the assertions below read the tree
   * that results.
   */
  async function save(renderer: ReactTestRenderer): Promise<void> {
    const form = renderer.root.findAll(node => node.type === 'form')[0]
    expect(form).toBeDefined()
    await act(async () => {
      // `preventDefault` is stubbed because the handler calls it to keep the
      // SPA from navigating; the synthetic event is not available here.
      await form!.props.onSubmit({ preventDefault: () => {} })
    })
    // The write is held open by the fetch stub; release it so the handler's
    // post-await state updates land inside an act() boundary too.
    await act(async () => { released.forEach(release => { release() }) })
    released = []
  }

  it('opens an inline editor seeded with the current name', async () => {
    const renderer = await mountCard()
    const rename = button(renderer, t('accountsRename'))
    expect(rename).toBeDefined()

    await act(async () => { rename!.props.onClick() })
    const input = renameInput(renderer)
    expect(input).toBeDefined()
    // Seeded from the label so the user edits rather than retypes.
    expect(input!.props.value).toBe('工作号')
    expect(button(renderer, t('accountsRenameSave'))).toBeDefined()
    expect(button(renderer, t('accountsRenameCancel'))).toBeDefined()
  })

  it('sends a rename action with the new label and closes on success', async () => {
    postResponse = { ok: true, body: { state: 'renamed', id: 'acct-1', label: '新名字' } }
    const renderer = await mountCard()

    await act(async () => { button(renderer, t('accountsRename'))!.props.onClick() })
    await type(renderer, '  新名字  ')
    await save(renderer)

    // Trimmed before it leaves the card; the host trims again.
    expect(posts[0]?.body).toEqual({ action: 'rename', id: 'acct-1', label: '新名字' })
    expect(posts[0]?.url).toContain('/accounts')

    await act(async () => { released.forEach(release => { release() }) })
    // The editor is gone once the write was accepted.
    expect(renameInput(renderer)).toBeUndefined()
  })

  it('keeps the draft open when the host refuses the rename', async () => {
    postResponse = { ok: false, status: 400, body: { error: 'invalid-label', message: 'label must be at most 40 characters' } }
    const renderer = await mountCard()

    await act(async () => { button(renderer, t('accountsRename'))!.props.onClick() })
    await type(renderer, '太长')
    await save(renderer)
    await act(async () => { released.forEach(release => { release() }) })

    // Still editing, with the text preserved so it can be corrected.
    expect(renameInput(renderer)?.props.value).toBe('太长')
    expect(textOf(renderer)).toContain(t('accountsError', { message: 'label must be at most 40 characters' }))
  })

  it('refuses an over-long name before any request is sent', async () => {
    const renderer = await mountCard()
    await act(async () => { button(renderer, t('accountsRename'))!.props.onClick() })
    await type(renderer, 'x'.repeat(41))
    await save(renderer)

    expect(posts).toHaveLength(0)
    expect(textOf(renderer)).toContain(t('accountsRenameInvalid', { max: 40 }))
    expect(renameInput(renderer)).toBeDefined()
  })

  it('refuses a blank name rather than clearing the label', async () => {
    const renderer = await mountCard()
    await act(async () => { button(renderer, t('accountsRename'))!.props.onClick() })
    await type(renderer, '   ')
    await save(renderer)

    // A blank draft must not reach the store: an empty label there means
    // "clear it", which would silently drop the user's name.
    expect(posts).toHaveLength(0)
    expect(textOf(renderer)).toContain(t('accountsRenameInvalid', { max: 40 }))
  })

  it('abandons the draft when the rename is cancelled', async () => {
    const renderer = await mountCard()
    await act(async () => { button(renderer, t('accountsRename'))!.props.onClick() })
    await type(renderer, '改了但不保存')
    await act(async () => { button(renderer, t('accountsRenameCancel'))!.props.onClick() })

    expect(posts).toHaveLength(0)
    expect(renameInput(renderer)).toBeUndefined()
    // The original name is back on the row.
    expect(textOf(renderer)).toContain('工作号')
  })

  it('offers rename on the account already in use', async () => {
    // Unlike switching, renaming is meaningful for the served account too.
    const renderer = await mountCard()
    expect(button(renderer, t('accountsUse'))).toBeUndefined()
    expect(button(renderer, t('accountsRename'))).toBeDefined()
  })
})
