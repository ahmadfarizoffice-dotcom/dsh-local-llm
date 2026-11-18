/**
 * Regression check for the "no first token for 20 minutes" failure.
 *
 * It starts the managed server exactly as the plugin does, with a stored
 * context of 256000 like the one that caused the stall, and asserts that:
 *   - the window is clamped to something this machine can prefill,
 *   - the adapter advertises the clamped window (so DSH compacts in time),
 *   - a full-size agent prompt reaches its first token in seconds, not minutes,
 *   - generation is capped and thinking is off by default.
 * Run: node test/engine-fix-check.mjs <model.gguf> <llama-server> [port]
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const modelPath = process.argv[2]
const binaryPath = process.argv[3]
if (!modelPath || !binaryPath) throw new Error('usage: engine-fix-check.mjs <model.gguf> <llama-server> [port]')

const fail = (message) => {
  throw new Error(message)
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-engine-fix-'))
const manager = new __internals.LocalModel({}, {
  dataDir,
  modelPath,
  binaryPath,
  port: Number(process.argv[4] ?? 18120),
  contextSize: 256000, // the value that stalled
  threads: 8,
  gpuLayers: 0,
})

/** Rough filler sized in tokens, matching the probe that reproduced the stall. */
function filler(tokens) {
  const unit = 'The harness records every step carefully while the agent reads a long instruction block. '
  return unit.repeat(Math.ceil(tokens / 18))
}

try {
  await manager.init()

  // 1. The stored 256000 must not survive init.
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'))
  if (persisted.contextSize !== 8192) fail(`init must persist the clamped window, found ${persisted.contextSize}`)
  const resolution = manager.resolveContext()
  if (resolution.effective !== 8192) fail(`effective context should be 8192, saw ${resolution.effective}`)
  if (!(manager.contextClampedFrom >= 256000)) fail('the clamp must remember what it replaced')
  console.log(`CLAMP OK          -> 256000 → ${resolution.effective} (limit ${resolution.limit})`)

  // 2. The advertised window is what DSH compacts against.
  const adapter = __internals.createAdapter(manager)
  const advertised = await adapter.resolveModel('local-llama', 'probe')
  if (advertised.context?.contextWindow !== 8192) {
    fail(`the adapter must advertise 8192, saw ${advertised.context?.contextWindow}`)
  }
  if (advertised.defaultMaxTokens !== 1024) fail(`output cap should be 1024, saw ${advertised.defaultMaxTokens}`)
  console.log(`ADVERTISED OK     -> contextWindow ${advertised.context.contextWindow}, maxTokens ${advertised.defaultMaxTokens}`)

  // 3. Launch uses the clamped window and the guarding flags.
  const started = await manager.start()
  if (started.state !== 'ready') fail(`start failed: ${started.lastError}`)
  const launch = manager.logs.find((line) => line.startsWith('args ')) ?? ''
  if (!/-c 8192\b/.test(launch)) fail(`the launch must use -c 8192, log says: ${launch.slice(0, 160)}`)
  if (!/-np 1\b/.test(launch)) fail('the launch must ask for a single slot')
  if (!/-n 1024\b/.test(launch)) fail('the launch must cap generation')
  if (!/--reasoning-budget 0/.test(launch)) fail('thinking must be off at the server level too')
  console.log('LAUNCH OK         -> -c 8192 -np 1 -n 1024 --reasoning-budget 0')

  // 4. A prompt near the whole window must still answer promptly.
  const prompt = filler(6000)
  const t0 = performance.now()
  let firstTokenMs
  let reasoningChars = 0
  let text = ''
  for await (const chunk of __internals.streamLocal(manager, {
    provider: 'local-llama',
    model: started.modelId,
    system: prompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one sentence about local models.' }] }],
    // No maxTokens on purpose: the adapter must cap it by itself.
    temperature: 0,
  })) {
    if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
    if (chunk.type === 'text-delta') {
      firstTokenMs ??= performance.now() - t0
      text += chunk.text
    }
  }
  if (firstTokenMs === undefined) fail('the call produced no text at all')
  if (text.trim() === '') fail('the call produced empty text')
  if (reasoningChars > 0) fail(`thinking should be off, saw ${reasoningChars} reasoning characters`)
  const seconds = firstTokenMs / 1000
  if (seconds > 90) fail(`first token took ${seconds.toFixed(1)}s — the stall is back`)
  console.log(
    `FIRST TOKEN OK    -> ${seconds.toFixed(1)}s for a 6000-token prompt, no reasoning phase, ${text.trim().slice(0, 40)}…`,
  )

  // 5. The server never generated past the cap. Read the counters directly:
  //    the ticker only runs while a page is subscribed.
  await manager.sampleMetrics()
  const perf = manager.performanceSnapshot()
  if (!(perf.predictedTokens > 0)) fail('the server reported no generated tokens')
  if (perf.predictedTokens > 1024) fail(`generation exceeded the cap: ${perf.predictedTokens} tokens`)
  console.log(`OUTPUT CAP OK     -> ${perf.predictedTokens} tokens generated (cap 1024)`)

  // 6. A catalog far larger than the window must be trimmed, not refused: this is
  //    the profile's real shape (265 tools, about 229k tokens of schemas).
  const hugeTools = Array.from({ length: 265 }, (_, index) => ({
    name: index < 5 ? `core_tool_${index}` : `mcp__big__tool_${index}`,
    description: index < 5 ? 'short core tool' : 'x'.repeat(3100),
    parameters: { type: 'object', properties: {} },
  }))
  const catalogTokens = Math.ceil(
    JSON.stringify(
      hugeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    ).length / 3.6,
  )
  if (!(catalogTokens > 200_000)) fail(`the fixture should model a huge catalog, got ${catalogTokens} tokens`)

  const before = performance.now()
  let trimmedText = ''
  let refusedWith
  try {
    for await (const chunk of __internals.streamLocal(manager, {
      provider: 'local-llama',
      model: started.modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi in one short sentence.' }] }],
      tools: hugeTools,
      // A small cap keeps the suite quick: this step tests the trim, not length.
      maxTokens: 24,
      temperature: 0,
    })) {
      if (chunk.type === 'text-delta') trimmedText += chunk.text
    }
  } catch (error) {
    refusedWith = error.message
  }
  const elapsed = Math.round(performance.now() - before)
  if (refusedWith !== undefined) fail(`a huge catalog must be trimmed instead of refused: ${refusedWith.slice(0, 200)}`)
  if (trimmedText.trim() === '') fail('the trimmed request produced no text')

  const perfAfter = manager.performanceSnapshot()
  if (!(perfAfter.lastDroppedTools > 0)) fail('the panel was not told how many tools were dropped')
  if (perfAfter.lastOfferedTools === 0) fail('the panel was not told how many tools were offered')
  if (perfAfter.lastOfferedTools >= hugeTools.length) fail('nothing was actually dropped')
  const notice = manager.logs.find((line) => line.startsWith('offered '))
  if (notice === undefined) fail('the trim was not logged')
  console.log(
    `TRIM OK           -> catalog ~${catalogTokens} tokens trimmed to ` +
      `${perfAfter.lastOfferedTools}/${hugeTools.length} tools in ${elapsed}ms`,
  )
  void notice

  // 7. Only the conversation can make a request impossible now.
  let historyRefusal
  try {
    for await (const chunk of __internals.streamLocal(manager, {
      provider: 'local-llama',
      model: started.modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(120_000) }] }],
      tools: hugeTools,
      temperature: 0,
    })) {
      void chunk
    }
  } catch (error) {
    historyRefusal = error.message
  }
  if (historyRefusal === undefined) fail('an oversized conversation must still be refused')
  if (!/conversation alone/u.test(historyRefusal)) {
    fail(`the refusal must name the conversation: ${historyRefusal.slice(0, 200)}`)
  }
  console.log('HISTORY GUARD OK  -> the conversation, not the catalog, is named')
  console.log('ENGINE FIX CHECK OK')
} finally {
  await manager.stop()
  await rm(dataDir, { recursive: true, force: true })
}
