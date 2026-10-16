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
 * So this answers one question, in one command, after every such event:
 *
 *   node scripts/check-desktop-profile.mjs         # report, exit 1 when stale
 *   node scripts/check-desktop-profile.mjs --fix   # copy this build back, re-check
 *   node scripts/check-desktop-profile.mjs --profile web
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

async function main() {
  const argv = process.argv.slice(2)
  const fix = argv.includes('--fix')
  const profileFlag = argv.indexOf('--profile')
  const profileName = profileFlag === -1 ? 'desktop' : argv[profileFlag + 1] ?? 'desktop'
  const packageDir = join(harnessHome(), 'profiles', profileName, 'node_modules', PACKAGE)

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
    `repo:     ${localVersion} (${String(localLib.size)} lib files)`,
    `installed:${installedVersion === undefined ? ' (no package installed)' : ` ${installedVersion}`} (${installedLib === undefined ? 'no lib/' : `${String(installedLib.size)} lib files`})`,
    stale ? 'RESULT: NOT this build — the profile has a different copy' : 'RESULT: this build is installed',
    ...stale && !fix
      ? ['', 'A profile-level pnpm operation replaces this copy with the published build.',
        'Re-apply with: node scripts/check-desktop-profile.mjs --fix']
      : [],
    '',
  ].join('\n'))

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
