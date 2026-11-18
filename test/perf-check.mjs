/**
 * Live metrics check: the panel must see uptime, CPU, RAM, token totals,
 * latency and active calls move without asking. This starts a real server,
 * subscribes the way the page does, and drives one real model call.
 * Run: node test/perf-check.mjs <model.gguf> <llama-server> [port]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const modelPath = process.argv[2]
const binaryPath = process.argv[3]
if (!modelPath || !binaryPath) throw new Error('usage: perf-check.mjs <model.gguf> <llama-server> [port]')

const fail = (message) => {
  throw new Error(message)
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-perf-check-'))
const manager = new __internals.LocalModel({}, {
  dataDir,
  modelPath,
  binaryPath,
  port: Number(process.argv[4] ?? 18098),
  contextSize: 2048,
  threads: 8,
  gpuLayers: 0,
})

const frames = []
const unsubscribe = manager.subscribe((snapshot) => frames.push({ at: Date.now(), snapshot }))

try {
  await manager.init()
  const started = await manager.start()
  if (started.state !== 'ready') fail(`start failed: ${started.lastError}`)
  frames.length = 0

  // 1. Ticks must arrive with nothing changing; this is what froze uptime before.
  await new Promise((resolve) => setTimeout(resolve, 3600))
  if (frames.length < 2) fail(`expected periodic frames while idle, saw ${frames.length}`)
  const idle = frames[frames.length - 1].snapshot
  const span = frames[frames.length - 1].snapshot.uptimeMs - frames[0].snapshot.uptimeMs
  if (!(span > 500)) fail(`uptime did not advance between frames (${frames[0].snapshot.uptimeMs} → ${frames.at(-1).snapshot.uptimeMs})`)
  if (!(idle.startedAtMs > 0)) fail('the snapshot must carry an epoch start for interpolation')
  if (!Number.isFinite(idle.performance?.cpuPercent)) fail('cpuPercent must be a number')
  if (!(idle.performance?.ramTotalBytes > 0)) fail('RAM total must be reported')
  if (!(idle.performance?.ramPercent > 0)) fail('RAM percent must be reported')
  console.log(
    `TICKS OK          -> ${frames.length} frames, uptime +${Math.round(span)}ms, cpu ${idle.performance.cpuPercent}%, ram ${idle.performance.ramPercent}%`,
  )

  // 2. One real call: active while open, averaged when closed.
  const options = {
    provider: 'local-llama',
    model: started.modelId,
    system: 'Answer in one short sentence.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Name one benefit of a local model.' }] }],
    maxTokens: 400,
    temperature: 0,
  }

  let activeDuringCall = 0
  let text = ''
  for await (const chunk of __internals.streamLocal(manager, options)) {
    if (manager.stats.active > activeDuringCall) activeDuringCall = manager.stats.active
    if (chunk.type === 'text-delta') text += chunk.text
  }
  if (activeDuringCall !== 1) fail(`a call in flight must count as active, saw ${activeDuringCall}`)
  if (manager.stats.active !== 0) fail(`the call stayed active afterwards (${manager.stats.active})`)
  if (manager.stats.completed !== 1) fail(`completed calls should be 1, saw ${manager.stats.completed}`)
  const callStats = manager.performanceSnapshot()
  if (manager.stats.ttftCount !== 1) fail(`the first-token sample was not counted (${manager.stats.ttftCount})`)
  if (!(callStats.averageTtftMs > 0)) fail('the first-token average was never recorded')
  if (text.trim() === '') fail('the call produced no text')
  console.log(
    `CALL OK           -> active peak ${activeDuringCall}, ttft ${callStats.averageTtftMs}ms, ${text.trim().slice(0, 40)}…`,
  )

  // 3. Server counters arrive on the next tick.
  frames.length = 0
  await new Promise((resolve) => setTimeout(resolve, 1600))
  if (frames.length === 0) fail('no frame after the call')
  const busy = frames[frames.length - 1].snapshot.performance
  if (busy.metricsAvailable !== true) fail('the server metrics document was not parsed')
  if (!(busy.totalTokens > 0)) fail(`totalTokens should be positive, saw ${busy.totalTokens}`)
  if (!(busy.averageTokensPerSecond > 0)) fail('average tokens per second should be positive')
  if (!(busy.completedCalls >= 1)) fail('completedCalls should be reported')
  if (!(busy.averageTtftMs > 0)) fail('averageTtftMs should be reported')
  console.log(
    `SERVER STATS OK   -> ${busy.totalTokens} tokens (${busy.promptTokens} in / ${busy.predictedTokens} out), ` +
      `${busy.averageTokensPerSecond} tok/s avg, active ${busy.activeCalls}, processing ${busy.requestsProcessing}`,
  )

  // 4. The ticker belongs to the subscription.
  const before = manager.ticker
  if (before === undefined) fail('the subscription never started the ticker')
  unsubscribe()
  if (manager.ticker !== undefined) fail('the ticker outlived its last subscriber')
  console.log('TICKER LIFECYCLE OK')
  console.log('PERF CHECK OK')
} finally {
  unsubscribe()
  await manager.stop()
  await rm(dataDir, { recursive: true, force: true })
}
