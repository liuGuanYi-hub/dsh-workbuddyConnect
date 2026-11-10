/**
 * One-variable-at-a-time matrix for the CN gateway's channel check.
 *
 * The 400/11128 body carries four candidate causes — request headers, the
 * system-prompt wording, the client version in the UA, and the body shape —
 * and only a single-variable run separates them. Each case sends the same
 * small request and changes exactly one thing.
 *
 *   node scripts/cn-channel-matrix.mjs plugin        # control (current behaviour)
 *   node scripts/cn-channel-matrix.mjs official-headers
 *   node scripts/cn-channel-matrix.mjs neutral-body
 *   node scripts/cn-channel-matrix.mjs version
 *   node scripts/cn-channel-matrix.mjs all
 *
 * Credentials come from the plugin's own store (read-only). Tokens are never
 * printed. `all` runs every case sequentially and prints one line each.
 */

import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CN_VARIANT, WorkBuddyCredentialStore } from '../lib/index.js'

const BASE = process.env['PROBE_BASE'] ?? 'https://copilot.tencent.com'
const UPSTREAM = `${BASE}/v2/chat/completions`

const store = new WorkBuddyCredentialStore({
  variant: CN_VARIANT,
  refresh: async () => {
    throw new Error('matrix does not refresh tokens')
  },
})
const credential = await store.current()
if (credential === undefined) throw new Error('no signed-in WorkBuddy account found')

const dumped = JSON.parse(await readFile(join(homedir(), '.dsh', 'workbuddy-last-failure.json'), 'utf8'))
const source = JSON.parse(dumped.body)
const originalSystem = source.messages.find(message => message.role === 'system').content

/** The plugin's shipped rewrite: every `DeepSeek Harness` becomes `DSH`. */
function pluginRewrite(text) {
  return text.split('DeepSeek Harness').join('DSH')
}

/** Official-client wording: no harness name, no acronym, no runtime symbol. */
function neutralRewrite(text) {
  return text
    .split('You are an AI agent powered by DeepSeek Harness.')
    .join('You are an AI agent powered by WorkBuddy.')
    .split('DeepSeek Harness')
    .join('WorkBuddy')
    .split('the DSH implementation checkout')
    .join('the WorkBuddy implementation checkout')
    .split('DSH Web GUI')
    .join('WorkBuddy Web GUI')
    .split('only dsh web injects window.__DSH_BOOT__')
    .join('only the WorkBuddy web app injects its boot flag')
    .split('DSH')
    .join('WorkBuddy')
    .split('dsh web')
    .join('the web app')
}

function traceHeaders() {
  const traceId = randomBytes(16).toString('hex')
  const spanId = randomBytes(8).toString('hex')
  const parentId = randomBytes(8).toString('hex')
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${parentId}`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-ParentSpanId': parentId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,
  }
}

/** Headers the plugin sends today. */
function pluginHeaders(version, cli) {
  const product = 'WorkBuddy'
  const userAgent = [`WorkBuddy/${version}`, `${product}/${version}`, ...cli === undefined ? [] : [`CLI/${cli}`]].join(' ')
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://copilot.tencent.com',
    'Referer': 'https://copilot.tencent.com/',
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product': 'SaaS',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

/** The extra markers the official 5.9.3 client adds on gateway calls. */
function officialExtras() {
  return {
    'x-codebuddy-request': '1',
    'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'local-agent',
    'X-Agent-Runtime': 'local-agent',
    'X-Private-Data': 'true',
    ...traceHeaders(),
  }
}

function body(systemText) {
  return JSON.stringify({
    model: process.env['PROBE_MODEL'] ?? source.model,
    stream: true,
    max_tokens: 16,
    messages: [{ role: 'system', content: systemText }, { role: 'user', content: 'Reply with the single word: ok' }],
  })
}

const CASES = {
  'plugin': () => ({ headers: pluginHeaders('5.5.6'), payload: body(pluginRewrite(originalSystem)) }),
  'neutral-body': () => ({ headers: pluginHeaders('5.5.6'), payload: body(neutralRewrite(originalSystem)) }),
  'official-headers': () => ({ headers: { ...pluginHeaders('5.5.6'), ...officialExtras() }, payload: body(pluginRewrite(originalSystem)) }),
  'version': () => ({ headers: pluginHeaders('5.9.3', '2.165.0'), payload: body(pluginRewrite(originalSystem)) }),
  'all': () => ({ headers: { ...pluginHeaders('5.9.3', '2.165.0'), ...officialExtras() }, payload: body(neutralRewrite(originalSystem)) }),
  // ACP transport markers: the desktop app forwards model calls over an ACP
  // connection and stamps its id on every forwarded request.
  'acp': () => ({
    headers: { ...pluginHeaders('5.9.3', '2.165.0'), 'x-codebuddy-request': '1', 'acp-connection-id': randomUUID() },
    payload: body(pluginRewrite(originalSystem)),
  }),
  // Auth style: the official CLI also carries X-API-Key beside the bearer.
  'apikey': () => ({
    headers: { ...pluginHeaders('5.9.3', '2.165.0'), 'X-API-Key': credential.accessToken },
    payload: body(pluginRewrite(originalSystem)),
  }),
  // Session/channel ids the internal header table lists next to the trio.
  'session': () => ({
    headers: { ...pluginHeaders('5.9.3', '2.165.0'), 'X-Session-ID': randomUUID(), 'X-Agent-Type': 'cli' },
    payload: body(pluginRewrite(originalSystem)),
  }),
  // Product token variants: `SaaS` is what the plugin sends; the app derives it
  // from the deployment type.
  'product-wb': () => ({
    headers: { ...pluginHeaders('5.9.3', '2.165.0'), 'X-Product': 'WorkBuddy' },
    payload: body(pluginRewrite(originalSystem)),
  }),
  // The `X-No-*` markers are the plugin's own invention; omit them entirely.
  'no-xno': () => {
    const headers = pluginHeaders('5.9.3', '2.165.0')
    for (const name of Object.keys(headers)) {
      if (name.startsWith('X-No-')) delete headers[name]
    }
    return { headers, payload: body(pluginRewrite(originalSystem)) }
  },
  // Floor: only what a bare HTTP client would send.
  'minimal': () => ({
    headers: {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    payload: body('You are a helpful assistant.'),
  }),
  // Bisect: minimal headers, the plugin's (rewritten) system prompt.
  'min-headers-prompt': () => ({
    headers: {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    payload: body(pluginRewrite(originalSystem)),
  }),
  // Bisect: the plugin's headers, a neutral prompt.
  'plugin-headers-neutral': () => ({
    headers: pluginHeaders('5.5.6'),
    payload: body('You are a helpful assistant.'),
  }),
}

async function run(name) {
  const build = CASES[name]
  if (build === undefined) throw new Error(`unknown case ${name}`)
  const { headers, payload } = build()
  const started = Date.now()
  const response = await fetch(UPSTREAM, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(90_000) })
  const text = await response.text()
  const elapsed = `${Date.now() - started}ms`
  if (response.ok) {
    let answer = ''
    for (const event of text.split('\n\n')) {
      const line = event.split('\n').find(row => row.startsWith('data:'))
      if (line === undefined) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (typeof delta === 'string') answer += delta
      } catch {
        // Keepalive line.
      }
    }
    console.log(`${name.padEnd(17)} 200 (${elapsed}) answer=${JSON.stringify(answer.slice(0, 40))}`)
    return true
  }
  let detail = text.slice(0, 200)
  try {
    const parsed = JSON.parse(text)
    detail = JSON.stringify({ code: parsed.code, msg: parsed.msg })
  } catch {
    // Not JSON.
  }
  console.log(`${name.padEnd(17)} ${response.status} (${elapsed}) ${detail}`)
  return false
}

const requested = process.argv[2] ?? 'plugin'
const names = requested === 'matrix' ? Object.keys(CASES) : [requested]
let failures = 0
for (const name of names) {
  if (!await run(name)) failures++
}
process.exitCode = failures === 0 ? 0 : 1
