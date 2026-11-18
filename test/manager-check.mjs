/**
 * Offline check of the process manager and its bearer-token hardening.
 * Starts its own llama-server on a spare port with a scratch data directory.
 * Run: node test/manager-check.mjs <model.gguf> <binary.exe> <port>
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const modelPath = process.argv[2]
const binaryPath = process.argv[3]
const port = Number(process.argv[4] ?? 18081)
if (!modelPath || !binaryPath) throw new Error('usage: manager-check.mjs <model.gguf> <llama-server> [port]')

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-llm-check-'))
const manager = new __internals.LocalModel({}, {
  dataDir,
  modelPath,
  binaryPath,
  port,
  contextSize: 2048,
  threads: 8,
  gpuLayers: 0,
})

try {
  await manager.init()
  const started = await manager.start()
  console.log('state        :', started.state)
  console.log('modelId      :', started.modelId)
  if (started.state !== 'ready') throw new Error(`start failed: ${started.lastError}`)

  const base = manager.baseURL()
  const anonymous = await fetch(`${base}/v1/models`).then(
    (response) => response.status,
    (error) => `threw ${error.message}`,
  )
  console.log('anonymous    :', anonymous)
  if (anonymous === 200) throw new Error('the local server answered without the generated key')

  const authorized = await fetch(`${base}/v1/models`, { headers: manager.authHeaders() })
  console.log('authorized   :', authorized.status)
  if (authorized.status !== 200) throw new Error('the generated key was rejected')

  const completion = await manager.test('Reply with the single word: ok')
  console.log('completion   :', JSON.stringify(completion.text.slice(0, 60)))
  if (completion.text.trim() === '') throw new Error('the local server returned no text')
  console.log('MANAGER CHECK OK')
} finally {
  const stopped = await manager.stop()
  console.log('stopped      :', stopped.state)
  await rm(dataDir, { recursive: true, force: true })
}
