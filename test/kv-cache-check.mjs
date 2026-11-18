/**
 * Checks the on-disk prompt cache: a saved state must be reused after a restart,
 * and a state written by another model must be refused and discarded.
 * Run: node test/kv-cache-check.mjs <main.gguf> <other.gguf> <llama-server> [port]
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const [mainModel, otherModel, binary] = process.argv.slice(2)
if (!mainModel || !otherModel || !binary) {
  throw new Error('usage: kv-cache-check.mjs <main.gguf> <other.gguf> <llama-server> [port]')
}
const port = Number(process.argv[5] ?? 18150)
const fail = (message) => {
  throw new Error(message)
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-kv-cache-'))
const config = { dataDir, threads: 8, gpuLayers: 0, contextSize: 2048, port, cacheToDisk: true, binaryPath: binary }

const prompt =
  'The harness records every step carefully while the agent reads a long instruction block. '.repeat(60) +
  'Reply with one short sentence about caching.'

async function runOnce(manager, label, body = prompt) {
  const started = performance.now()
  let text = ''
  for await (const chunk of __internals.streamLocal(manager, {
    provider: 'local-llama',
    model: manager.modelId(),
    messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
    maxTokens: 32,
    temperature: 0,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  const ms = Math.round(performance.now() - started)
  if (text.trim() === '') fail(`${label}: no text produced`)
  return ms
}

try {
  // ---- pass 1: fresh prefill, then persist
  let manager = new __internals.LocalModel({}, { ...config, modelPath: mainModel })
  await manager.init()
  const first = await manager.start()
  if (first.state !== 'ready') fail(`first start failed: ${first.lastError}`)
  const cold = await runOnce(manager, 'cold')
  await manager.saveCache(true)
  await manager.sampleMetrics()
  const coldMetrics = manager.performanceSnapshot()
  await manager.stop()

  const cacheDir = manager.paths.cacheDir
  const states = (await readdir(cacheDir)).filter((name) => name.endsWith('.state'))
  if (states.length !== 1) fail(`expected one state file, saw ${states.length}`)
  const statePath = path.join(cacheDir, states[0])
  const stateInfo = await manager.cacheInfo()
  if (!(stateInfo.bytes > 0)) fail('the state file is empty')
  if (coldMetrics.cachedPromptTokens !== 0) fail('a cold pass must not report cached tokens')
  console.log(`SAVE OK           -> ${states[0]} (${Math.round(stateInfo.bytes / 1048576)} MB), cold ${cold}ms`)

  // ---- pass 2: a new process, same model, restored state
  manager = new __internals.LocalModel({}, { ...config, modelPath: mainModel })
  await manager.init()
  const second = await manager.start()
  if (second.state !== 'ready') fail(`second start failed: ${second.lastError}`)
  if (!(second.cache.restoredTokens > 0)) fail('the restart did not restore the saved state')
  const warm = await runOnce(manager, 'warm')
  await manager.sampleMetrics()
  const warmMetrics = manager.performanceSnapshot()
  if (!(warmMetrics.cachedPromptTokens > 0)) fail('the warm pass reported no cached tokens')
  console.log(
    `RESTORE OK        -> restored ${second.cache.restoredTokens} tokens, ` +
      `${warmMetrics.cachedPromptTokens} reused, ${cold}ms → ${warm}ms`,
  )
  await manager.stop()

  // ---- pass 3: a state written by another model must be refused, not trusted
  const other = new __internals.LocalModel({}, { ...config, modelPath: otherModel })
  await other.init()
  const otherState = other.cacheFile()
  if (otherState === undefined) fail('the second model has no cache file name')
  await copyFile(statePath, otherState.path)
  const third = await other.start()
  if (third.state !== 'ready') fail(`third start failed: ${third.lastError}`)
  if (third.cache.restoredTokens > 0) fail('a state from another model must not restore')
  const survived = (await readdir(cacheDir)).includes(path.basename(otherState.path))
  if (survived) fail('a state the server refused must be deleted')
  // The second fixture is a 128-token toy model, so this step needs a short prompt.
  const after = await runOnce(other, 'after-refusal', 'Say hi.')
  if (after <= 0) fail('the slot was left unusable after the refused restore')
  console.log(`CROSS-MODEL OK    -> refused and discarded, slot still answers (${after}ms)`)
  await other.stop()
  console.log('KV CACHE CHECK OK')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
