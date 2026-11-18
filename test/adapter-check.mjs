/**
 * Offline check of the adapter's wire conversion against a running llama-server.
 * Run: node test/adapter-check.mjs [baseURL]
 */
import { __internals } from '../index.js'

const baseURL = process.argv[2] ?? 'http://127.0.0.1:18080'
const manager = {
  baseURL: () => baseURL,
  modelId: () => 'LFM3-1.7B-Q4_K_M',
  snapshot: () => ({ contextSize: 4096 }),
  modelIds: async () => ['LFM3-1.7B-Q4_K_M'],
}

const options = {
  provider: 'local-llama',
  model: 'LFM3-1.7B-Q4_K_M',
  system: 'You are a terse assistant. Answer in one short sentence.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Name one benefit of running a model locally.' }] },
  ],
  maxTokens: 320,
  temperature: 0,
}

const allowed = new Set([
  'block-start',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
  'usage',
  'finish',
])

const chunks = []
for await (const chunk of __internals.streamLocal(manager, options)) {
  if (!allowed.has(chunk.type)) throw new Error(`unknown chunk type ${chunk.type}`)
  chunks.push(chunk)
}

const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const finish = chunks.find((c) => c.type === 'finish')
const usage = chunks.find((c) => c.type === 'usage')

console.log('chunk types :', [...new Set(chunks.map((c) => c.type))].join(', '))
console.log('reasoning   :', JSON.stringify(reasoning.slice(0, 120)))
console.log('text        :', JSON.stringify(text.slice(0, 240)))
console.log('finish      :', JSON.stringify(finish?.reason))
console.log('usage       :', JSON.stringify(usage?.usage))
if (finish === undefined) throw new Error('the stream never emitted a finish chunk')
if (finish.reason.kind !== 'stop' && finish.reason.kind !== 'max-tokens') {
  throw new Error(`unexpected finish reason ${finish.reason.kind}: ${JSON.stringify(finish.reason)}`)
}
if (text.trim() === '') throw new Error('the stream produced no text')
console.log('ADAPTER CHECK OK')

// Conversion smoke check: a tool round must serialize into OpenAI messages.
const converted = __internals.toOpenAiMessages({
  system: 'sys',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
  ],
})
console.log('converted   :', JSON.stringify(converted))
if (converted[0].role !== 'system') throw new Error('the system prompt must lead the request')
if (converted[2].tool_calls?.[0]?.function?.name !== 'read') throw new Error('a tool call did not survive conversion')
if (converted[3].role !== 'tool' || converted[3].tool_call_id !== 'call_1') {
  throw new Error('a tool result did not survive conversion')
}
console.log('CONVERSION CHECK OK')

// Adapter surface: the exact object handed to ctx.llm.registerAdapter().
const adapter = __internals.createAdapter(manager)
const info = adapter.providerInfo('local-llama')
if (info.id !== 'local-llama' || info.name === '') throw new Error('providerInfo must preserve the route id')
const models = await adapter.listModels('local-llama')
console.log('listModels  :', JSON.stringify(models.map((m) => m.id)))
if (models.length === 0) throw new Error('the adapter advertised no model, so no picker group would appear')
const resolved = await adapter.resolveModel('local-llama', models[0].id)
if (resolved.context?.contextWindow !== 4096) throw new Error('resolveModel must carry the context window')
const prepared = await adapter.prepareCall('local-llama', models[0].id)
if (typeof prepared.stream !== 'function') throw new Error('prepareCall must return a stream entry point')
const preparedText = []
// LFM3 is a reasoning model: a small budget is spent entirely on reasoning,
// so the prepared-call check needs room for both phases.
for await (const chunk of prepared.stream({ ...options, model: models[0].id, maxTokens: 512 })) {
  if (chunk.type === 'text-delta') preparedText.push(chunk.text)
}
console.log('prepareCall :', JSON.stringify(preparedText.join('').slice(0, 120)))
if (preparedText.join('').trim() === '') throw new Error('the prepared call produced no text')
console.log('ADAPTER SURFACE CHECK OK')
