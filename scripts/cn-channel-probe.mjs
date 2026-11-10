/**
 * Live probe for the CN gateway's channel check (NOT part of the offline suite).
 *
 * Sends one message through the real client with the machine's current
 * credential, so a change to `chatHeaders` / `prepareCnChatBody` can be judged
 * by the only evidence that counts: 400/11128 versus an actual answer.
 *
 * Run from the package root after `npm run build`:
 *
 *   node scripts/cn-channel-probe.mjs            # small body (cheap, ~1 turn)
 *   node scripts/cn-channel-probe.mjs dumped     # the body the last 400 carried
 *
 * Credentials are read through the plugin's own store (read-only). Tokens are
 * never printed; failures print the status and the upstream `msg` only.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  CN_VARIANT,
  WorkBuddyCredentialStore,
  WorkBuddyUpstreamClient,
  chatUserAgent,
  resolveChatIdentity,
} from '../lib/index.js'

const mode = process.argv[2] === 'dumped' ? 'dumped' : 'small'

const store = new WorkBuddyCredentialStore({
  variant: CN_VARIANT,
  refresh: async () => {
    throw new Error('probe does not refresh tokens')
  },
})
const credential = await store.current()
if (credential === undefined) throw new Error('no signed-in WorkBuddy account found')

const identity = await resolveChatIdentity('cn')
const userAgent = chatUserAgent(identity, 'cn')
console.log(`identity  ${JSON.stringify(identity)}`)
console.log(`user-agent ${userAgent}`)
console.log(`uid       ${credential.uid === '' ? '(none)' : `${credential.uid.slice(0, 8)}…`}`)

const PROMPT = 'Reply with the single word: ok'

let bodyJson
if (mode === 'dumped') {
  const path = join(homedir(), '.dsh', 'workbuddy-last-failure.json')
  const dumped = JSON.parse(await readFile(path, 'utf8'))
  bodyJson = dumped.body
  console.log(`body      dumped (${bodyJson.length} bytes) from ${dumped.at}`)
} else {
  // The exact system prompt the last failure carried: the fingerprint lives in
  // this text, so a small body keeps the shape while costing almost nothing.
  const path = join(homedir(), '.dsh', 'workbuddy-last-failure.json')
  const dumped = JSON.parse(await readFile(path, 'utf8'))
  const source = JSON.parse(dumped.body)
  const system = source.messages.find(message => message.role === 'system')
  bodyJson = JSON.stringify({
    model: source.model,
    stream: true,
    max_tokens: 32,
    messages: [
      ...system === undefined ? [] : [system],
      { role: 'user', content: PROMPT },
    ],
  })
  console.log(`body      small (${bodyJson.length} bytes, system kept verbatim)`)
}

const client = new WorkBuddyUpstreamClient()
const started = Date.now()
const result = await client.chatStream(credential, bodyJson, AbortSignal.timeout(120_000))
const elapsed = `${Date.now() - started}ms`

if (!result.ok) {
  let detail = result.message
  try {
    const parsed = JSON.parse(result.message)
    detail = JSON.stringify({ code: parsed.code, msg: parsed.msg })
  } catch {
    detail = result.message.slice(0, 300)
  }
  console.log(`\nRESULT    400-family: http ${result.status} kind=${result.kind} (${elapsed})`)
  console.log(`upstream   ${detail}`)
  process.exitCode = 1
} else {
  const text = await Readable.fromWeb(result.response.body)
    .reduce((acc, chunk) => acc + chunk.toString('utf8'), '')
  const content = []
  for (const event of text.split('\n\n')) {
    const line = event.split('\n').find(row => row.startsWith('data:'))
    if (line === undefined) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string') content.push(delta)
    } catch {
      // Non-JSON keepalive line: nothing to collect.
    }
  }
  console.log(`\nRESULT    accepted: http ${result.response.status} (${elapsed})`)
  console.log(`answer    ${JSON.stringify(content.join('').slice(0, 120))}`)
}
