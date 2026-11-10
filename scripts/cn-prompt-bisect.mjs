/**
 * Bisect the CN gateway's prompt fingerprint.
 *
 * `minimal` headers prove the credential and endpoint are fine, and
 * `plugin-headers-neutral` proves the headers are not the gate — so the 400 is
 * triggered by the system text itself. This walks that text by halves and
 * reports the smallest block that still fails, which is what the rewrite table
 * has to cover.
 *
 *   node scripts/cn-prompt-bisect.mjs
 *
 * The text under test is the body the plugin actually sends: the last dumped
 * request's system message with the current rewrite applied.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CN_VARIANT, WorkBuddyCredentialStore } from '../lib/index.js'

const UPSTREAM = `${process.env['PROBE_BASE'] ?? 'https://copilot.tencent.com'}/v2/chat/completions`

const store = new WorkBuddyCredentialStore({
  variant: CN_VARIANT,
  refresh: async () => {
    throw new Error('bisect does not refresh tokens')
  },
})
const credential = await store.current()
if (credential === undefined) throw new Error('no signed-in WorkBuddy account found')

const dumped = JSON.parse(await readFile(join(homedir(), '.dsh', 'workbuddy-last-failure.json'), 'utf8'))
const source = JSON.parse(dumped.body)
const system = source.messages.find(message => message.role === 'system').content.split('DeepSeek Harness').join('DSH')

let calls = 0
async function blocked(text) {
  calls++
  const response = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: source.model,
      stream: true,
      max_tokens: 8,
      messages: [{ role: 'system', content: text }, { role: 'user', content: 'ok' }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await response.text()
  if (response.ok) return false
  const code = (() => {
    try {
      return JSON.parse(body).code
    } catch {
      return undefined
    }
  })()
  console.log(`  [${String(calls).padStart(2)}] ${text.length.toString().padStart(5)} chars -> ${response.status} ${code ?? ''}`)
  return true
}

const paragraphs = system.split('\n\n').filter(part => part.trim() !== '')
console.log(`system: ${system.length} chars in ${paragraphs.length} paragraphs`)

if (!await blocked(system)) {
  console.log('full text passes: nothing to bisect')
  process.exit(0)
}

/** Recurse into whichever half still fails. */
async function walk(parts, label) {
  const text = parts.join('\n\n')
  if (!await blocked(text + '\n\nReply with one word.')) {
    console.log(`pass  ${label} (${parts.length} paragraphs)`)
    return false
  }
  console.log(`FAIL  ${label} (${parts.length} paragraphs)`)
  if (parts.length === 1) return true
  const mid = Math.floor(parts.length / 2)
  const left = await walk(parts.slice(0, mid), `${label}.a`)
  if (left) return true
  return walk(parts.slice(mid), `${label}.b`)
}

const found = await walk(paragraphs, 'root')
if (!found) {
  // Both halves pass alone: the trigger is an aggregate (repetition or total
  // size), not one paragraph.
  console.log('\nno single paragraph fails on its own: the check aggregates mentions')
}
