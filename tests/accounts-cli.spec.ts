import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.ts'
import { WorkBuddyAccountStore, slotIdForUid } from '../src/accounts-store.ts'
import { WorkBuddyQuotaStore, quotaAccountOf, WORKBUDDY_QUOTA_FILENAME } from '../src/quota-state.ts'
import { WorkBuddyQuotaCheckStore, WORKBUDDY_QUOTA_CHECK_FILENAME } from '../src/quota-check-store.ts'
import { CN_VARIANT } from '../src/variants.ts'

/**
 * The `accounts` CLI: how a user captures the account the desktop app is
 * signed into, and switches between parked accounts.
 *
 * `WORKBUDDY_AUTH_FILE` stands in for the app's sign-in (so "what the app is
 * signed into" is controllable), and `DSH_HOME` holds the slots.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A harness home plus the auth file the desktop app "holds". */
async function setup(): Promise<{ home: string, authFile: string }> {
  const home = await tempDir('wb-cli-home-')
  const authFile = join(home, 'workbuddy-desktop.info')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', authFile)
  return { home, authFile }
}

/** Write a desktop sign-in for one account. */
async function signInAs(authFile: string, uid: string, options: { nickname?: string } = {}): Promise<void> {
  await writeFile(authFile, JSON.stringify({
    auth: {
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
    },
    account: { uid, ...options.nickname === undefined ? {} : { nickname: options.nickname } },
  }))
}

/** Run one command, capturing stdout/stderr instead of printing it. */
async function capture(args: string[]): Promise<{ code: number, out: string, err: string, json: Record<string, unknown> }> {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
  try {
    const code = await run(args)
    const stdout = out.join('')
    return {
      code,
      out: stdout,
      err: err.join(''),
      json: stdout.trim().startsWith('{') ? JSON.parse(stdout) as Record<string, unknown> : {},
    }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
}

describe('accounts list', () => {
  it('reports an empty store without failing', async () => {
    await setup()
    const { code, out, json } = await capture(['accounts', 'list', '--json'])
    expect(code).toBe(0)
    expect(json['accounts']).toEqual([])
    expect(json['activeId']).toBeUndefined()
    expect(out).not.toContain('at-')
  })

  it('suggests how to add the first account in human output', async () => {
    await setup()
    const { code, out } = await capture(['accounts', 'list'])
    expect(code).toBe(0)
    expect(out).toContain('no stored accounts')
    expect(out).toContain('accounts add')
  })

  it('lists parked accounts and marks the active one', async () => {
    const { home, authFile } = await setup()
    await signInAs(authFile, 'uid-1', { nickname: '一号' })
    await capture(['accounts', 'add', '--label', '国内一号'])
    await signInAs(authFile, 'uid-2', { nickname: '二号' })
    await capture(['accounts', 'add', '--label', '国内二号'])

    const { json, out } = await capture(['accounts', 'list', '--json'])
    const rows = json['accounts'] as { id: string, label: string, active: boolean }[]
    expect(rows).toHaveLength(2)
    expect(rows.filter(row => row.active)).toHaveLength(1)
    // The second add activated the second account.
    expect(rows.find(row => row.active)?.label).toBe('国内二号')
    expect(json['directory']).toContain(home)

    const text = (await capture(['accounts', 'list'])).out
    expect(text).toContain('国内一号')
    expect(text).toContain('*')
    void out
  })

  it('never prints token material', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    await capture(['accounts', 'add'])
    const { out, json } = await capture(['accounts', 'list', '--json'])
    expect(out).not.toContain('at-uid-1')
    expect(out).not.toContain('rt-uid-1')
    expect(JSON.stringify(json)).not.toContain('rt-uid-1')
  })

  describe('quota verdicts', () => {
    /** Record a refusal the way the shim does, against one account. */
    async function recordExhausted(home: string, uid: string): Promise<void> {
      const quota = new WorkBuddyQuotaStore({ path: join(home, WORKBUDDY_QUOTA_FILENAME) })
      quota.recordExhausted(quotaAccountOf({ uid }))
    }

    it('reports every account as ok when nothing has been refused', async () => {
      const { authFile } = await setup()
      await signInAs(authFile, 'uid-1', { nickname: '一号' })
      await capture(['accounts', 'add', '--label', '国内一号'])

      const { json, out } = await capture(['accounts', 'list', '--json'])
      const rows = json['accounts'] as { quota: string, exhaustedAt?: string }[]
      expect(rows[0]?.quota).toBe('ok')
      expect(rows[0]?.exhaustedAt).toBeUndefined()
      // Nothing to explain, so the legend stays out of the output.
      expect(out).not.toContain('QUOTA EXHAUSTED')
    })

    it('marks the refused account in both output modes', async () => {
      const { home, authFile } = await setup()
      await signInAs(authFile, 'uid-1', { nickname: '一号' })
      await capture(['accounts', 'add', '--label', '国内一号'])
      await signInAs(authFile, 'uid-2', { nickname: '二号' })
      await capture(['accounts', 'add', '--label', '国内二号'])

      await recordExhausted(home, 'uid-1')

      const { json } = await capture(['accounts', 'list', '--json'])
      const rows = json['accounts'] as { label: string, quota: string, exhaustedAt?: string }[]
      const byLabel = new Map(rows.map(row => [row.label, row]))
      expect(byLabel.get('国内一号')?.quota).toBe('exhausted')
      expect(byLabel.get('国内一号')?.exhaustedAt).toBeDefined()
      expect(byLabel.get('国内二号')?.quota).toBe('ok')

      const { out } = await capture(['accounts', 'list'])
      expect(out).toContain('QUOTA EXHAUSTED')
      expect(out).toContain('switch to another one')
    })

    it('stops marking an account once its verdict is cleared', async () => {
      const { home, authFile } = await setup()
      await signInAs(authFile, 'uid-1', { nickname: '一号' })
      await capture(['accounts', 'add', '--label', '国内一号'])

      await recordExhausted(home, 'uid-1')
      expect((await capture(['accounts', 'list', '--json'])).json['accounts'])
        .toMatchObject([{ quota: 'exhausted' }])

      // A later successful request clears it, exactly as the shim does.
      new WorkBuddyQuotaStore({ path: join(home, WORKBUDDY_QUOTA_FILENAME) })
        .clear(quotaAccountOf({ uid: 'uid-1' }))

      expect((await capture(['accounts', 'list', '--json'])).json['accounts'])
        .toMatchObject([{ quota: 'ok' }])
    })
  })
})

describe('accounts add', () => {
  it('archives the account the app is signed into and selects it', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1', { nickname: '一号' })
    const { code, json } = await capture(['accounts', 'add', '--label', '我的号', '--json'])

    expect(code).toBe(0)
    const added = json['added'] as { id: string, label: string, uid: string }
    expect(added.uid).toBe('uid-1')
    expect(added.label).toBe('我的号')
    expect(json['activeId']).toBe(added.id)
  })

  it('fails with guidance when nobody is signed in', async () => {
    const { code, err } = await setup().then(async () => await capture(['accounts', 'add']))
    expect(code).toBe(1)
    expect(err).toContain('no signed-in')
  })

  it('updates the existing slot when the same account is added twice', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const first = await capture(['accounts', 'add', '--json'])
    await signInAs(authFile, 'uid-1')
    const second = await capture(['accounts', 'add', '--json'])

    expect((second.json['added'] as { id: string }).id).toBe((first.json['added'] as { id: string }).id)
    const rows = (await capture(['accounts', 'list', '--json'])).json['accounts'] as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('rejects an over-long label', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const { code, err } = await capture(['accounts', 'add', '--label', 'x'.repeat(41)])
    expect(code).toBe(1)
    expect(err).toContain('at most 40')
  })

  it('does not write into the desktop app auth file', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const before = await readFile(authFile, 'utf8')
    await capture(['accounts', 'add'])
    expect(await readFile(authFile, 'utf8')).toBe(before)
  })

  it('captures a second account after the first is already parked', async () => {
    // Regression: `add` once read `current()`, which slot mode had already
    // redirected at the first parked account, so signing into a second account
    // and adding it silently re-imported the first and no second slot could
    // ever be created.
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const first = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string, uid: string }
    await signInAs(authFile, 'uid-2')
    const second = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string, uid: string }

    expect(first.uid).toBe('uid-1')
    expect(second.uid).toBe('uid-2')
    expect(second.id).not.toBe(first.id)
    expect((await capture(['accounts', 'list', '--json'])).json['accounts']).toHaveLength(2)
  })
})

describe('accounts use', () => {
  it('switches the active account', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const one = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }
    await signInAs(authFile, 'uid-2')
    const two = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }

    const switched = await capture(['accounts', 'use', one.id, '--json'])
    expect(switched.code).toBe(0)
    expect(switched.json['activeId']).toBe(one.id)

    const back = await capture(['accounts', 'use', two.id, '--json'])
    expect(back.json['activeId']).toBe(two.id)
  })

  it('fails for an unknown id', async () => {
    await setup()
    const { code, err } = await capture(['accounts', 'use', 'acct-deadbeef'])
    expect(code).toBe(1)
    expect(err).toContain('no stored account')
  })

  it('requires an id', async () => {
    await setup()
    const { code, err } = await capture(['accounts', 'use'])
    expect(code).toBe(1)
    expect(err).toContain('needs an account id')
  })

  it('rejects an unsafe id', async () => {
    await setup()
    const { code } = await capture(['accounts', 'use', '../escape'])
    expect(code).toBe(1)
  })
})

describe('accounts rename and remove', () => {
  it('renames a slot', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const id = ((await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }).id

    const { code, out } = await capture(['accounts', 'rename', id, '--label', '新名字'])
    expect(code).toBe(0)
    expect(out).toContain('新名字')

    const rows = (await capture(['accounts', 'list', '--json'])).json['accounts'] as { label: string }[]
    expect(rows[0]?.label).toBe('新名字')
  })

  it('removes a non-active slot and keeps serving the active one', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const one = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }
    await signInAs(authFile, 'uid-2')
    const two = (await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }

    const { code } = await capture(['accounts', 'remove', one.id])
    expect(code).toBe(0)
    expect((await capture(['accounts', 'list', '--json'])).json['activeId']).toBe(two.id)
  })

  it('clears the selection when the active slot is removed', async () => {
    const { home, authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    const id = ((await capture(['accounts', 'add', '--json'])).json['added'] as { id: string }).id

    const { code, out } = await capture(['accounts', 'remove', id])
    expect(code).toBe(0)
    expect(out).toContain('follows the desktop app')

    const store = new WorkBuddyAccountStore({ variant: CN_VARIANT })
    expect(await store.isEnabled()).toBe(false)
    expect(await store.list()).toEqual([])
    void home
  })

  it('fails when removing an unknown id', async () => {
    await setup()
    const { code } = await capture(['accounts', 'remove', 'acct-deadbeef'])
    expect(code).toBe(1)
  })
})

describe('accounts command validation', () => {
  it('rejects an unknown subcommand', async () => {
    await setup()
    const { code, err } = await capture(['accounts', 'frobnicate'])
    expect(code).toBe(1)
    expect(err).toContain('unknown accounts command')
  })

  it('rejects an unknown provider', async () => {
    await setup()
    const { code, err } = await capture(['accounts', 'list', '--provider', 'nope'])
    expect(code).toBe(1)
    expect(err).toContain('unknown provider')
  })

  it('keeps each provider on its own slots', async () => {
    const { authFile } = await setup()
    await signInAs(authFile, 'uid-cn')
    await capture(['accounts', 'add', '--provider', 'workbuddy', '--json'])

    const ai = await capture(['accounts', 'list', '--provider', 'workbuddy-ai', '--json'])
    expect(ai.json['accounts']).toEqual([])
  })

  it('still accepts --provider=<id> in the joined form', async () => {
    await setup()
    const { code } = await capture(['accounts', 'list', '--provider=workbuddy-ai'])
    expect(code).toBe(0)
  })
})

describe('help', () => {
  it('documents the accounts commands', async () => {
    const { code, out } = await capture(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('accounts add')
    expect(out).toContain('accounts use')
    expect(out).toContain('accounts quota')
  })
})

/**
 * `accounts quota` — the command-line half of the on-demand check.
 *
 * The sweep itself is spent from the card, in the plugin host's process; this
 * reader runs in a *different* process against the same file. These pin the
 * handover: what the card paid for must still be here for the terminal, for the
 * right provider, and without any credential in the output.
 */
describe('accounts quota', () => {
  /** Write a sweep the way the card's button does. */
  async function recordSweep(home: string, filename = WORKBUDDY_QUOTA_CHECK_FILENAME): Promise<void> {
    const checks = new WorkBuddyQuotaCheckStore({ path: join(home, filename) })
    checks.record({
      model: 'deepseek-v4.1-flash',
      checkedAtMs: 1_800_000_000_000,
      results: [
        // The first row is keyed by the real slot id of `uid-1`, so the reader
        // can recognise which account is being served.
        { id: slotIdForUid('uid-1'), label: '国内一号', state: 'available', status: 200 },
        { id: 'acct-2', label: '国内二号', state: 'exhausted', status: 402 },
        { id: 'acct-3', state: 'unknown', status: 401, reason: 'status 401 (session_dead): 会话已失效' },
      ],
    })
  }

  it('says nothing is on record before the first check', async () => {
    const { code, out, json } = await capture(['accounts', 'quota', '--json'])
    expect(code).toBe(0)
    expect(json['checked']).toBe(false)
    expect((await capture(['accounts', 'quota'])).out).toContain('no quota check on record')
  })

  it('reads back the rows a sweep wrote, marking the served account', async () => {
    const { home, authFile } = await setup()
    await signInAs(authFile, 'uid-1', { nickname: '一号' })
    await capture(['accounts', 'add', '--label', '国内一号'])
    await recordSweep(home)

    const { out, json } = await capture(['accounts', 'quota', '--json'])
    expect(json['checked']).toBe(true)
    expect(json['model']).toBe('deepseek-v4.1-flash')
    const results = json['results'] as { id: string, state: string, active: boolean }[]
    expect(results).toHaveLength(3)
    expect(results.find(row => row.id === slotIdForUid('uid-1'))).toMatchObject({ state: 'available', active: true })
    expect(results.find(row => row.id === 'acct-2')?.state).toBe('exhausted')

    const text = (await capture(['accounts', 'quota'])).out
    expect(text).toContain('国内一号')
    expect(text).toContain('QUOTA USED UP')
    expect(text).toContain('会话已失效')
    // `unknown` must not read as spent: the user's fix there is to sign in again.
    expect(text).toContain('Not a spent account')
    void out
  })

  it('explains that an undecided row is not a spent account', async () => {
    const { home } = await setup()
    await recordSweep(home)
    const { out } = await capture(['accounts', 'quota'])
    expect(out).toContain('unknown = the check could not decide')
  })

  it('keeps each provider on its own record', async () => {
    const { home } = await setup()
    await recordSweep(home)
    // The international variant reads its own file, which nothing has written:
    // a CN sweep says nothing about an international account's credit.
    const { json } = await capture(['accounts', 'quota', '--provider', 'workbuddy-ai', '--json'])
    expect(json['checked']).toBe(false)
    expect(json['provider']).toBe('workbuddy-ai')
  })

  it('prints no credential material', async () => {
    const { home, authFile } = await setup()
    await signInAs(authFile, 'uid-1')
    await capture(['accounts', 'add'])
    await recordSweep(home)
    const { out, json } = await capture(['accounts', 'quota', '--json'])
    expect(out).not.toContain('at-uid-1')
    expect(out).not.toContain('rt-uid-1')
    expect(JSON.stringify(json)).not.toContain('rt-uid-1')
  })
})
