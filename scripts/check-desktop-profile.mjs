#!/usr/bin/env node
/**
 * Desktop-profile install check.
 *
 * `~/.dsh/profiles/desktop` is app-managed, and its plugin list is pinned to the
 * published build (`"dsh-workbuddy-connect": "0.7.4"`). A fork gets in by copying
 * files — which works until the app runs *any* profile-level pnpm operation
 * (installing or updating any other plugin re-resolves the whole tree) and
 * rewrites this package back to the published build. Nothing errors: the fork's
 * features simply stop existing, and the version string is the only tell.
 *
 * So this answers two questions, in one command:
 *
 *   node scripts/check-desktop-profile.mjs         # report, exit 1 when stale
 *   node scripts/check-desktop-profile.mjs --fix   # copy this build back, re-check
 *   node scripts/check-desktop-profile.mjs --profile web
 *
 *   1. is the copy in the profile this repository's build right now (per-file md5);
 *   2. what would the *next* sync install — the profile's own pin, plus whether a
 *      pinned local tarball still exists.
 *
 * Writes are confined to the plugin's own directory in the profile. The profile's
 * `package.json`, lockfile and `pnpm-workspace.yaml` are read but never touched:
 * they decide what the app installs, and changing them is a separate decision
 * with a much larger blast radius.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-workbuddy-connect'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every non-manifest file the profile's copy of a package is made of. */
async function digestDirectory(directory) {
  const entries = new Map()
  let names
  try {
    names = await readdir(directory)
  } catch {
    return undefined
  }
  for (const name of names.sort()) {
    const bytes = await readFile(join(directory, name)).catch(() => undefined)
    if (bytes === undefined) continue
    entries.set(name, createHash('md5').update(bytes).digest('hex'))
  }
  return entries
}

/** `$DSH_HOME`, mirroring the plugin's own resolution without importing it. */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv === undefined || fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

/**
 * The local file behind a `file:` dependency spec, or undefined for a registry
 * spec.
 *
 * Worth checking because pinning this package to a tarball is what keeps a later
 * profile sync from reverting it — and that makes the tarball a dependency of
 * the install. If it is gone, the next sync fails for the whole profile, not
 * just this plugin.
 */
function localTargetOf(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return undefined
  let path = spec.slice('file:'.length)
  if (path.startsWith('//')) path = path.slice(2)
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return resolve(path)
}

async function main() {
  const argv = process.argv.slice(2)
  const fix = argv.includes('--fix')
  const profileFlag = argv.indexOf('--profile')
  const profileName = profileFlag === -1 ? 'desktop' : argv[profileFlag + 1] ?? 'desktop'
  const profileDir = join(harnessHome(), 'profiles', profileName)
  const packageDir = join(profileDir, 'node_modules', PACKAGE)

  // The profile's own manifest says where this package comes from on the next
  // sync; the installed directory only says where the current copy came from.
  const pin = await readFile(join(profileDir, 'package.json'), 'utf8')
    .then(text => JSON.parse(text).dependencies?.[PACKAGE])
    .catch(() => undefined)
  const tarball = localTargetOf(pin)
  const tarballMissing = tarball !== undefined
    && await readFile(tarball).then(() => false, () => true)

  const localVersion = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version
  const localLib = await digestDirectory(join(projectRoot, 'lib'))
  if (localLib === undefined || localLib.size === 0) {
    process.stdout.write(`${PACKAGE}: no built lib/ in this repository — run \`npm run build\` first\n`)
    return 1
  }
  const installedVersion = await readFile(join(packageDir, 'package.json'), 'utf8')
    .then(text => JSON.parse(text).version)
    .catch(() => undefined)
  const installedLib = await digestDirectory(join(packageDir, 'lib'))

  const missing = installedLib === undefined
  const stale = missing
    || installedVersion !== localVersion
    || [...localLib.keys()].join(',') !== [...installedLib.keys()].join(',')
    || [...localLib].some(([name, sum]) => installedLib.get(name) !== sum)

  process.stdout.write([
    `profile:  ${profileName}`,
    `package:  ${packageDir}`,
    `pin:      ${pin ?? '(the profile does not list this package)'}`,
    ...(pin === undefined
      ? []
      : tarball === undefined
        ? ['durability: a registry pin — the next profile sync replaces this copy with the published build']
        : [
          `tarball:  ${tarball}${tarballMissing ? '  MISSING' : ' (present)'}`,
          tarballMissing
            ? 'durability: UNRESOLVED — the sync would install from a file that is not there'
            : 'durability: the profile resolves this package from the local tarball, so a later sync keeps the fork',
        ]),
    `repo:     ${localVersion} (${String(localLib.size)} lib files)`,
    `installed:${installedVersion === undefined ? ' (no package installed)' : ` ${installedVersion}`} (${installedLib === undefined ? 'no lib/' : `${String(installedLib.size)} lib files`})`,
    stale ? 'RESULT: NOT this build — the profile has a different copy' : 'RESULT: this build is installed',
    ...tarballMissing
      ? ['', 'The pinned tarball is gone: the next profile-level pnpm operation fails, and it takes every',
        'plugin in this profile with it. Re-pack it (npm pack --pack-destination <that directory>),',
        'or restore the profile manifest from a backup.']
      : [],
    ...stale && !fix
      ? ['', 'A profile-level pnpm operation replaces this copy with the published build.',
        'Re-apply with: node scripts/check-desktop-profile.mjs --fix']
      : [],
    '',
  ].join('\n'))

  if (tarballMissing) return 1
  if (!stale) return 0
  if (!fix) return 1

  await mkdir(join(packageDir, 'lib'), { recursive: true })
  for (const [name] of localLib) {
    await writeFile(join(packageDir, 'lib', name), await readFile(join(projectRoot, 'lib', name)))
  }
  // Files the current build no longer produces (a renamed shared chunk, above
  // all) must go: leaving them behind makes a later check pass on a directory
  // that no longer matches any build.
  for (const name of installedLib?.keys() ?? []) {
    if (!localLib.has(name)) await rm(join(packageDir, 'lib', name), { force: true })
  }
  for (const file of ['package.json', 'README.md', 'README.en.md', 'cordis.patch.yml']) {
    await writeFile(join(packageDir, file), await readFile(join(projectRoot, file)))
  }
  process.stdout.write('copied this build into the profile; re-checking\n')
  return await main()
}

process.exitCode = await main()
