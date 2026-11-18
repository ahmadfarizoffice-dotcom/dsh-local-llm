/**
 * Regression check for tool calls: the assembled call must carry a name.
 *
 * A real failure had every call arrive as `unknown tool ""`, because the adapter
 * forwarded argument deltas without ever forwarding the tool name, and the
 * Harness assembler builds the name from `chunk.name`. This drives a canned
 * OpenAI stream — including the awkward shape where the name arrives after some
 * arguments — and asserts the chunk contract, plus the nameless-call guard.
 * Run: node test/tool-call-check.mjs
 */
import { createServer } from 'node:http'
import { __internals } from '../index.js'

const fail = (message) => {
  throw new Error(message)
}

/** Canned SSE frames, one per `data:` line. */
const streams = {
  // Name first, arguments chunked: the ordinary shape.
  ordinary: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ],
  // Arguments before the name: the shape that used to reach the Harness nameless.
  lateName: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b', function: { arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_weather' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  // A call the model never named: it must be dropped, not offered.
  nameless: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_c', function: { arguments: '{"a":1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  // A named call to a tool that was not offered: the Harness would answer
  // `unknown tool <name>`, so the adapter drops it with a clearer log instead.
  notOffered: [
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_d', type: 'function', function: { name: 'delete_everything', arguments: '{}' } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
}

let current = 'ordinary'
const server = createServer((req, res) => {
  const body = streams[current]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of body) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})

const manager = {
  baseURL: () => `http://127.0.0.1:${server.address().port}`,
  modelId: () => 'probe',
  authHeaders: () => ({}),
  resolveContext: () => ({ effective: 8192, limit: 32768, requested: 8192, clamped: false }),
  log: (line) => logs.push(line),
}
const logs = []

/** Assemble the chunks the way the Harness does, to prove the name survives. */
function assemble(chunks) {
  const blocks = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') blocks.set(chunk.index, { type: chunk.blockType, name: '', args: '' })
    if (chunk.type === 'tool-call-delta') {
      const block = blocks.get(chunk.index)
      if (block === undefined) fail('a tool-call-delta arrived before its block-start')
      if (typeof chunk.name === 'string' && chunk.name !== '') block.name = chunk.name
      block.args += chunk.argumentsDelta ?? ''
    }
  }
  return [...blocks.values()]
}

async function run(scenario) {
  current = scenario
  const chunks = []
  for await (const chunk of __internals.streamLocal(manager, {
    provider: 'local-llama',
    model: 'probe',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
    maxTokens: 64,
    temperature: 0,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  // 1. Ordinary shape.
  const ordinary = assemble(await run('ordinary'))
  if (ordinary.length !== 1) fail(`expected one tool block, saw ${ordinary.length}`)
  if (ordinary[0].name !== 'get_weather') fail(`the call lost its name: "${ordinary[0].name}"`)
  if (ordinary[0].args !== '{"city":"Paris"}') fail(`the arguments were mangled: ${ordinary[0].args}`)
  console.log('NAME OK           ->', ordinary[0].name, ordinary[0].args)

  // 2. Arguments before the name: nothing may be emitted before the name is known.
  const lateChunks = await run('lateName')
  const firstToolChunk = lateChunks.find((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
  const firstDelta = lateChunks.find((chunk) => chunk.type === 'tool-call-delta')
  if (firstToolChunk === undefined) fail('a late-named call was never emitted')
  if (firstDelta === undefined || typeof firstDelta.name !== 'string' || firstDelta.name === '') {
    fail('the first tool-call-delta must already carry the name')
  }
  const late = assemble(lateChunks)
  if (late[0].name !== 'get_weather') fail(`the late-named call lost its name: "${late[0].name}"`)
  if (late[0].args !== '{"city":"Paris"}') fail(`the late-named call mangled arguments: ${late[0].args}`)
  console.log('LATE NAME OK      -> buffered until', firstDelta.name, 'arrived, args', late[0].args)

  // 3. A nameless call is dropped and reported, and the turn ends as a stop.
  logs.length = 0
  const namelessChunks = await run('nameless')
  const toolChunks = namelessChunks.filter((chunk) => chunk.type === 'block-start' || chunk.type === 'tool-call-delta')
  if (toolChunks.length !== 0) fail('a nameless call must not be emitted at all')
  const finish = namelessChunks.find((chunk) => chunk.type === 'finish')
  if (finish?.reason?.kind !== 'stop') fail(`a dropped call must end as stop, saw ${finish?.reason?.kind}`)
  if (!logs.some((line) => line.includes('tool call with no name'))) fail('the drop was not logged')
  console.log('NAMELESS GUARD OK -> dropped, logged, finish stop')

  // 4. A call to a tool that was not offered is dropped with its real name.
  logs.length = 0
  const unofferedChunks = await run('notOffered')
  const unofferedTool = unofferedChunks.filter(
    (chunk) => chunk.type === 'block-start' || chunk.type === 'tool-call-delta',
  )
  if (unofferedTool.length !== 0) fail('a call to an unoffered tool must not reach the Harness')
  const unofferedFinish = unofferedChunks.find((chunk) => chunk.type === 'finish')
  if (unofferedFinish?.reason?.kind !== 'stop') fail('an unoffered call must end the turn as stop')
  if (!logs.some((line) => line.includes('"delete_everything"') && line.includes('not offered'))) {
    fail('the dropped call must name the tool and say it was not offered')
  }
  console.log('UNOFFERED GUARD OK -> delete_everything dropped by name')
  console.log('TOOL CALL CHECK OK')
} finally {
  server.close()
}
