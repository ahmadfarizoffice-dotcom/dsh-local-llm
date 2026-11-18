/**
 * Realtime check: the panel is supposed to learn about state changes without
 * asking. This serves the exported status stream over a real socket, drives a
 * manager through a real start and stop, and reads the frames a browser would.
 * Run: node test/stream-check.mjs <model.gguf> <llama-server> [port]
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const modelPath = process.argv[2]
const binaryPath = process.argv[3]
if (!modelPath || !binaryPath) throw new Error('usage: stream-check.mjs <model.gguf> <llama-server>')

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-stream-check-'))
const manager = new __internals.LocalModel({}, {
  dataDir,
  modelPath,
  binaryPath,
  port: Number(process.argv[4] ?? 18091),
  contextSize: 2048,
  threads: 8,
  gpuLayers: 0,
})

const server = createServer((req, res) => {
  if (!(req.url ?? '').startsWith('/events')) {
    res.writeHead(404)
    res.end()
    return
  }
  __internals.attachStatusStream(req, res, manager)
})

/** Read one complete SSE frame from a body stream, returning its data payload. */
async function readFrame(reader, pending) {
  for (;;) {
    const split = pending.text.indexOf('\n\n')
    if (split >= 0) {
      const frame = pending.text.slice(0, split)
      pending.text = pending.text.slice(split + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data === '') continue // a keep-alive comment
      return JSON.parse(data)
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error('the stream ended before the expected frame')
    pending.text += new TextDecoder().decode(chunk.value)
  }
}

try {
  await manager.init()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal })
  if (response.status !== 200) throw new Error(`the stream answered HTTP ${response.status}`)
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new Error('the stream must answer as text/event-stream')
  }

  const reader = response.body.getReader()
  const pending = { text: '' }

  const first = await readFrame(reader, pending)
  if (first.state !== 'stopped') throw new Error(`the first frame reported "${first.state}"`)
  if (typeof first.streamToken !== 'string' || first.streamToken === '') {
    throw new Error('the snapshot must carry the stream token the page needs')
  }
  console.log('FIRST FRAME OK   -> state', first.state, '· token', first.streamToken.slice(0, 6) + '…')

  // A start must arrive as pushed frames, without the reader ever asking.
  const started = manager.start()
  const sawStarting = []
  let sawReady = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !sawReady) {
    const frame = await readFrame(reader, pending)
    if (sawStarting[sawStarting.length - 1] !== frame.state) sawStarting.push(frame.state)
    if (frame.state === 'ready') {
      sawReady = true
      if (typeof frame.runningModelPath !== 'string' || frame.runningModelPath === '') {
        throw new Error('a ready frame must name the file the server serves')
      }
      if (frame.baseURL === '') throw new Error('a ready frame must carry the endpoint')
    }
  }
  await started
  if (!sawReady) throw new Error(`never observed a ready frame; saw ${sawStarting.join(' → ')}`)
  console.log('PUSHED START OK  ->', [...new Set(sawStarting)].join(' → '))

  // A log line is a change too, and must reach the same stream. Periodic ticks
  // interleave, so scan forward for the frame that carries it.
  manager.log('stream-check marker')
  let sawMarker = false
  const markerDeadline = Date.now() + 10_000
  while (Date.now() < markerDeadline && !sawMarker) {
    const frame = await readFrame(reader, pending)
    if (frame.logs.includes('stream-check marker')) sawMarker = true
  }
  if (!sawMarker) throw new Error('a log line never reached the stream')
  console.log('PUSHED LOG OK    -> stream-check marker')

  await manager.stop()
  let sawStopped = false
  const stopDeadline = Date.now() + 20_000
  while (Date.now() < stopDeadline && !sawStopped) {
    const frame = await readFrame(reader, pending)
    if (frame.state === 'stopped') sawStopped = true
  }
  if (!sawStopped) throw new Error('the stream never reported the stop')
  console.log('PUSHED STOP OK   -> stopped')

  const listenersAtClose = manager.listeners.size
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (manager.listeners.size !== 0) {
    throw new Error(`the disconnect left ${manager.listeners.size} subscriber(s) behind`)
  }
  console.log('UNSUBSCRIBE OK   -> listeners', listenersAtClose, '→', manager.listeners.size)
  console.log('STREAM CHECK OK')
} finally {
  server.close()
  await manager.stop()
  await rm(dataDir, { recursive: true, force: true })
}
