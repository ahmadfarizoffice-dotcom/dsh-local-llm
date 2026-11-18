/**
 * Live check: does the model emit a tool call, and does its name survive the
 * adapter? Informational, because a 1.7B model may ignore the tool catalog.
 * Run: node test/tool-call-live.mjs <model.gguf> <llama-server> [port]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const [modelPath, binaryPath] = process.argv.slice(2)
if (!modelPath || !binaryPath) throw new Error('usage: tool-call-live.mjs <model.gguf> <llama-server> [port]')

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tool-live-'))
const manager = new __internals.LocalModel({}, {
  dataDir,
  modelPath,
  binaryPath,
  port: Number(process.argv[4] ?? 18180),
  contextSize: 4096,
  threads: 8,
  gpuLayers: 0,
})

try {
  await manager.init()
  const started = await manager.start()
  if (started.state !== 'ready') throw new Error(`start failed: ${started.lastError}`)

  const chunks = []
  for await (const chunk of __internals.streamLocal(manager, {
    provider: 'local-llama',
    model: started.modelId,
    system: 'You can call tools. When a question needs a tool, call it instead of answering from memory.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is the weather in Paris right now? Use the get_weather tool.' }],
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ],
    maxTokens: 256,
    temperature: 0,
  })) {
    chunks.push(chunk)
  }

  const starts = chunks.filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  const named = deltas.filter((chunk) => typeof chunk.name === 'string' && chunk.name !== '')
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  const finish = chunks.find((chunk) => chunk.type === 'finish')

  console.log('tool blocks   :', starts.length)
  console.log('deltas        :', deltas.length, '| named:', named.length)
  if (named.length > 0) console.log('first name    :', named[0].name, '| args so far:', JSON.stringify(named[0].argumentsDelta))
  console.log('finish        :', JSON.stringify(finish?.reason))
  console.log('text          :', JSON.stringify(text.slice(0, 160)))
  console.log(
    starts.length === 0
      ? 'RESULT: the model answered in prose without calling the tool'
      : named.length > 0
        ? 'RESULT: the model called a tool and the name reached the adapter'
        : 'RESULT: a tool call arrived with no name (the guard drops it)',
  )
} finally {
  await manager.stop()
  await rm(dataDir, { recursive: true, force: true })
}
