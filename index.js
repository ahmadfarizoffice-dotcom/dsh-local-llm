/**
 * Host half of the Local model bundle.
 *
 * Owns one llama.cpp `llama-server` process, serves the management RPC the
 * sidebar panel calls, and registers the running model as an LLM provider so
 * the composer's model selector can pick it.
 *
 * Everything here is plain ESM with no build step. Bundled Harness packages
 * resolve from the running dsh installation; this package itself declares no
 * runtime dependencies.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const PROVIDER_ID = 'local-llama'
const RPC_PREFIX = '/local-llm'
const EVENTS_PREFIX = '/local-llm/events'
const LOG_LIMIT = 400

/** Published llama.cpp Windows builds this panel can install. */
const RUNTIME_VARIANTS = {
  cpu: {
    label: 'llama.cpp (CPU)',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12466/llama-b12466-bin-win-cpu-x64.zip',
  },
  vulkan: {
    label: 'llama.cpp (Vulkan)',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12466/llama-b12466-bin-win-vulkan-x64.zip',
  },
}

/**
 * Context is the one setting that decides whether a chat answers or appears to
 * hang: a CPU model prefills roughly 100 tokens a second, so a window the
 * Harness is told about is also the history it will keep before compacting.
 * These defaults keep the advertised window inside what this class of machine
 * can actually prefill, and the ceiling is a hard stop for a stored value that
 * no amount of waiting would serve.
 */
const DEFAULT_CONTEXT = 8192
const CEILING_CONTEXT = 32768
const DEFAULT_MAX_OUTPUT = 1024

const DEFAULTS = {
  dataDir: path.join(os.homedir(), '.dsh', 'local-llm'),
  binaryPath: '',
  modelPath: '',
  modelId: '',
  port: 18080,
  contextSize: DEFAULT_CONTEXT,
  maxContextSize: CEILING_CONTEXT,
  maxOutputTokens: DEFAULT_MAX_OUTPUT,
  thinking: false,
  limitTools: true,
  maxToolTokens: 0,
  excludeTools: [],
  cacheToDisk: true,
  cacheDir: '',
  threads: 8,
  gpuLayers: 0,
  extraArgs: [],
  autoStart: false,
  autoSetup: true,
  autoRuntime: 'cpu',
  autoModel: '',
  runtimeUrl: '',
  providerId: PROVIDER_ID,
}

/* ------------------------------------------------------------------ paths */

function pathsFor(settings) {
  const dataDir = settings.dataDir
  return {
    dataDir,
    settingsFile: path.join(dataDir, 'settings.json'),
    runtimeDir: path.join(dataDir, 'runtime'),
    cacheDir: settings.cacheDir && String(settings.cacheDir).trim() !== '' ? settings.cacheDir : path.join(dataDir, 'cache'),
    modelsDir: path.join(dataDir, 'models'),
    downloadsDir: path.join(dataDir, 'downloads'),
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function isFileSync(file) {
  try {
    return fsSync.statSync(file).isFile()
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- settings */

function mergeSettings(base, stored) {
  const merged = { ...DEFAULTS, dataDir: DEFAULTS.dataDir }
  const absorb = (source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined || value === null) continue
      // An empty directory would make every other path relative; keep the default.
      if (key === 'dataDir' && String(value).trim() === '') continue
      if (key === 'excludeTools') {
        merged.excludeTools = Array.isArray(value) ? value.map(String).filter((entry) => entry !== '') : []
        continue
      }
      if (key === 'extraArgs') {
        if (Array.isArray(value)) merged.extraArgs = value.map(String)
        continue
      }
      merged[key] = value
    }
  }
  absorb(base)
  absorb(stored)
  if (!Array.isArray(merged.extraArgs)) merged.extraArgs = []
  return merged
}

/* ------------------------------------------------------ llama-server mgmt */

class LocalModel {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.settings = mergeSettings(this.config, undefined)
    this.child = undefined
    this.logs = []
    this.state = 'stopped'
    this.lastError = ''
    this.startedAt = 0
    this.loading = undefined
    this.adapterHandle = undefined
    this.download = undefined
    this.runningPort = undefined
    this.runningModelId = undefined
    this.runningModelPath = undefined
    this.listeners = new Set()
    this.emitTimer = undefined
    this.ticker = undefined
    /** Last machine-wide CPU delta, so a snapshot never fabricates a spike. */
    this.cpuSample = undefined
    this.systemCpuPercent = 0
    /** Last parsed `/metrics` document; undefined until the server answers. */
    this.metrics = undefined
    /** Call accounting the server does not publish, filled by the adapter. */
    this.stats = { active: 0, completed: 0, ttftMsSum: 0, ttftCount: 0, lastTtftMs: 0 }
    /** Size of the on-disk state, kept in memory because snapshot() is synchronous. */
    this.cacheBytes = 0
    this.cacheRestoredTokens = 0
    /** One token per plugin activation, so only this page can open the stream. */
    this.streamToken = randomBytes(18).toString('hex')
  }

  /** Subscribe to status changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener)
    this.startTicker()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopTicker()
    }
  }

  /**
   * While a page is watching, sample once a second. Idle uptime and the
   * server counters are otherwise unchanged, and a snapshot that never changes
   * would leave the panel frozen between real events.
   */
  startTicker() {
    if (this.ticker !== undefined) return
    this.ticker = setInterval(() => {
      void this.tick()
    }, 1000)
    if (typeof this.ticker.unref === 'function') this.ticker.unref()
  }

  stopTicker() {
    if (this.ticker === undefined) return
    clearInterval(this.ticker)
    this.ticker = undefined
  }

  async tick() {
    if (this.listeners.size === 0) {
      this.stopTicker()
      return
    }
    this.systemCpuPercent = this.computeCpuPercent()
    await this.sampleMetrics()
    this.changed()
  }

  /** Machine-wide busy share between the previous sample and this one. */
  computeCpuPercent() {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const previous = this.cpuSample
    this.cpuSample = { idle, total }
    if (previous === undefined) return 0
    const idleDelta = idle - previous.idle
    const totalDelta = total - previous.total
    if (totalDelta <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10))
  }

  systemMemory() {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    return {
      ramTotalBytes: totalBytes,
      ramUsedBytes: usedBytes,
      ramPercent: totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10,
    }
  }

  /** Read llama-server's own Prometheus counters; failure only clears them. */
  async sampleMetrics() {
    if (this.state !== 'ready') {
      this.metrics = undefined
      return
    }
    try {
      const response = await fetch(`${this.baseURL()}/metrics`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) {
        this.metrics = undefined
        return
      }
      const text = await response.text()
      const parsed = {}
      for (const line of text.split('\n')) {
        const match = /^llamacpp:([a-z0-9_]+)(?:\{[^}]*\})?\s+(-?[0-9.eE+]+)$/u.exec(line.trim())
        if (match === null) continue
        const value = Number(match[2])
        if (Number.isFinite(value)) parsed[match[1]] = value
      }
      this.metrics = parsed
    } catch {
      this.metrics = undefined
    }
  }

  /** A call starts before the first byte and ends when its stream closes. */
  beginCall() {
    this.stats.active += 1
    this.changed()
  }

  endCall(ttftMs, ok) {
    this.stats.active = Math.max(0, this.stats.active - 1)
    if (ok) {
      this.stats.completed += 1
      if (Number.isFinite(ttftMs) && ttftMs >= 0) {
        this.stats.ttftMsSum += ttftMs
        this.stats.ttftCount += 1
        this.stats.lastTtftMs = ttftMs
      }
    }
    this.changed()
  }

  /** Live counters for the panel, derived from the server document and our calls. */
  performanceSnapshot() {
    const metrics = this.metrics
    const promptTokens = Number(metrics?.prompt_tokens_total ?? 0)
    const predictedTokens = Number(metrics?.tokens_predicted_total ?? 0)
    const promptSeconds = Number(metrics?.prompt_seconds_total ?? 0)
    const predictedSeconds = Number(metrics?.tokens_predicted_seconds_total ?? 0)
    const averageTokensPerSecond =
      predictedSeconds > 0 ? Math.round((predictedTokens / predictedSeconds) * 100) / 100 : 0
    const averagePromptSeconds = promptTokens > 0 ? Math.round((promptSeconds / promptTokens) * 10000) / 10000 : 0
    return {
      ...this.systemMemory(),
      cpuPercent: this.systemCpuPercent,
      metricsAvailable: metrics !== undefined,
      totalTokens: promptTokens + predictedTokens,
      promptTokens,
      predictedTokens,
      averageTokensPerSecond,
      currentTokensPerSecond: Math.round(Number(metrics?.predicted_tokens_seconds ?? 0) * 100) / 100,
      averageSecondsPerPromptToken: averagePromptSeconds,
      requestsProcessing: Number(metrics?.requests_processing ?? 0),
      requestsDeferred: Number(metrics?.requests_deferred ?? 0),
      decodeTotal: Number(metrics?.n_decode_total ?? 0),
      cachedPromptTokens: Number(metrics?.prompt_tokens_cached_total ?? 0),
      lastOfferedTools: this.stats.offeredTools ?? 0,
      lastDroppedTools: this.stats.droppedTools ?? 0,
      activeCalls: this.stats.active,
      completedCalls: this.stats.completed,
      averageTtftMs: this.stats.ttftCount > 0 ? Math.round(this.stats.ttftMsSum / this.stats.ttftCount) : 0,
      lastTtftMs: this.stats.lastTtftMs,
    }
  }

  /**
   * Announce a change. Notifications coalesce over one short window because a
   * log burst or a download emits hundreds of mutations per second.
   */
  changed() {
    if (this.emitTimer !== undefined) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      if (this.listeners.size === 0) return
      const snapshot = this.snapshot()
      for (const listener of [...this.listeners]) {
        try {
          listener(snapshot)
        } catch {
          /* a broken subscriber must not stop the others */
        }
      }
    }, 120)
    if (typeof this.emitTimer.unref === 'function') this.emitTimer.unref()
  }

  get paths() {
    return pathsFor(this.settings)
  }

  log(line) {
    const text = String(line).replace(/\r$/u, '')
    if (text.trim() === '') return
    // llama.cpp prints the model's trained window at load; remember it so the
    // next launch never asks for more context than the model was built for.
    const trained = /n_ctx_train\s*=\s*(\d+)/u.exec(text)
    if (trained !== null) {
      const value = Number(trained[1])
      if (Number.isFinite(value) && value > 0) this.trainedContext = value
    }
    this.logs.push(text)
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT)
    this.changed()
  }

  /** Record download progress and announce it. */
  setDownload(info) {
    this.download = info
    this.changed()
  }

  /** The model's trained window, once the server has told us. */
  trainedContext = undefined

  /**
   * What the running server should be launched with, and what the Harness may
   * assume. Anything a CPU cannot prefill in a reasonable time is clamped.
   */
  resolveContext() {
    const requested = Number(this.settings.contextSize)
    const ceiling = Math.max(1024, Number(this.settings.maxContextSize) || CEILING_CONTEXT)
    const trained = Number.isFinite(this.trainedContext) && this.trainedContext > 0
      ? this.trainedContext
      : ceiling
    const limit = Math.max(1024, Math.min(ceiling, trained))
    const wanted = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_CONTEXT
    return {
      requested: wanted,
      limit,
      effective: Math.max(512, Math.min(wanted, limit)),
      clamped: wanted > limit,
    }
  }

  outputCap() {
    const configured = Number(this.settings.maxOutputTokens)
    const cap = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_OUTPUT
    // Never let generation eat the whole window before the prompt is even read.
    return Math.max(64, Math.min(cap, Math.floor(this.resolveContext().effective / 2)))
  }

  thinkingEnabled() {
    return this.settings.thinking === true
  }

  /** Tokens this request may spend on tool schemas. */
  toolBudget(window, historyTokens) {
    if (this.settings.limitTools === false) return Number.POSITIVE_INFINITY
    const room = Math.max(0, window - historyTokens - 256)
    const configured = Number(this.settings.maxToolTokens)
    return Number.isFinite(configured) && configured > 0 ? Math.min(configured, room) : room
  }

  /**
   * Choose the tool subset that fits, keeping the small schemas and dropping the
   * large ones, then restore the caller's order so the prefix stays stable for
   * KV-cache reuse. Names matching `excludeTools` prefixes are always dropped.
   */
  selectTools(tools, window, historyTokens) {
    const budget = this.toolBudget(window, historyTokens)
    const excluded = Array.isArray(this.settings.excludeTools) ? this.settings.excludeTools : []
    const blocked = (name) =>
      excluded.some((prefix) => typeof prefix === 'string' && prefix !== '' && name.startsWith(prefix))

    const sized = tools
      .filter((tool) => !blocked(tool.name))
      .map((tool) => ({
        tool,
        tokens: Math.ceil(
          JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 3.6,
        ),
      }))
      .sort((left, right) => left.tokens - right.tokens)

    const kept = new Set()
    let used = 0
    for (const entry of sized) {
      if (used + entry.tokens > budget) break
      kept.add(entry.tool)
      used += entry.tokens
    }
    const ordered = tools.filter((tool) => kept.has(tool))
    return { tools: ordered, dropped: tools.length - ordered.length, tokens: used }
  }

  cacheEnabled() {
    return this.settings.cacheToDisk !== false
  }

  /**
   * One state file per model build. llama.cpp's slot state is a snapshot of the
   * KV rows for the tokens it has processed, so it is only meaningful for the
   * exact weights that produced them — never share a name across models.
   */
  cacheFile() {
    const modelPath = this.modelPath()
    if (modelPath === undefined) return undefined
    let bytes = 0
    try {
      bytes = fsSync.statSync(modelPath).size
    } catch {
      bytes = 0
    }
    const stem = path.basename(modelPath).replace(/\.gguf$/iu, '').replace(/[^A-Za-z0-9._-]+/gu, '_')
    return { name: `${stem}-${bytes}.state`, path: path.join(this.paths.cacheDir, `${stem}-${bytes}.state`) }
  }

  async cacheInfo() {
    const file = this.cacheFile()
    if (file === undefined) return { enabled: this.cacheEnabled(), path: '', bytes: 0, restoredTokens: 0 }
    let bytes = 0
    try {
      bytes = (await fs.stat(file.path)).size
    } catch {
      bytes = 0
    }
    return {
      enabled: this.cacheEnabled(),
      path: file.path,
      bytes,
      restoredTokens: this.cacheRestoredTokens ?? 0,
    }
  }

  /** Drop a slot's state; a refused restore can leave a slot unusable. */
  async eraseSlot() {
    try {
      await fetch(`${this.baseURL()}/slots/0?action=erase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(4000),
      })
    } catch {
      /* the slot is unreachable, which is the same as unusable */
    }
  }

  /**
   * Restore the last saved prefix. This is what turns a repeated prefill into a
   * cache hit after the server or the Harness restarts.
   */
  async restoreCache() {
    if (!this.cacheEnabled()) return
    const file = this.cacheFile()
    if (file === undefined) return
    try {
      await fs.stat(file.path)
    } catch {
      return
    }
    try {
      const response = await fetch(`${this.baseURL()}/slots/0?action=restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ filename: file.name }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 160)
        // A state from another model, or a damaged file: clear the slot first,
        // otherwise later requests fail against the half-restored state.
        await this.eraseSlot()
        await fs.rm(file.path, { force: true })
        this.log(`discarded the saved cache (${detail}); it is rebuilt for this model`)
        return
      }
      const body = await response.json().catch(() => ({}))
      this.cacheRestoredTokens = Number(body.n_restored ?? 0)
      this.cacheBytes = (await fs.stat(file.path).catch(() => ({ size: 0 }))).size
      this.log(`restored ${this.cacheRestoredTokens} cached tokens from ${path.basename(file.path)}`)
    } catch (error) {
      this.log(`cache restore skipped: ${error?.message ?? error}`)
    }
  }

  /** Persist the slot's state; throttled because one save rewrites the KV rows. */
  async saveCache(force = false) {
    if (!this.cacheEnabled() || this.state !== 'ready') return
    const file = this.cacheFile()
    if (file === undefined) return
    const now = Date.now()
    if (!force && this.lastCacheSave !== undefined && now - this.lastCacheSave < 15_000) return
    this.lastCacheSave = now
    try {
      await fs.mkdir(this.paths.cacheDir, { recursive: true })
      const response = await fetch(`${this.baseURL()}/slots/0?action=save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ filename: file.name }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) {
        this.log(`cache save refused with HTTP ${response.status}`)
        return
      }
      const body = await response.json().catch(() => ({}))
      this.cacheBytes = (await fs.stat(file.path).catch(() => ({ size: 0 }))).size
      this.log(`saved ${Number(body.n_saved ?? 0)} tokens to ${path.basename(file.path)} (${Number(body.n_written ?? 0)} bytes)`)
    } catch (error) {
      this.log(`cache save skipped: ${error?.message ?? error}`)
    }
  }

  /** Keep only the most recent states; one per model build adds up quickly. */
  async pruneCache(keep = 4) {
    try {
      const entries = await fs.readdir(this.paths.cacheDir)
      const states = []
      for (const name of entries) {
        if (!name.endsWith('.state')) continue
        const full = path.join(this.paths.cacheDir, name)
        const info = await fs.stat(full).catch(() => undefined)
        if (info?.isFile() === true) states.push({ full, at: info.mtimeMs })
      }
      states.sort((left, right) => right.at - left.at)
      for (const stale of states.slice(keep)) await fs.rm(stale.full, { force: true })
    } catch {
      /* an unreadable cache directory only costs a rebuild */
    }
  }

  /** Install one published llama.cpp build and remember the binary. */
  async installRuntime(variant = 'cpu', overrideUrl) {
    const chosen = RUNTIME_VARIANTS[variant] ?? RUNTIME_VARIANTS.cpu
    const url = String(overrideUrl ?? (variant === 'cpu' ? this.settings.runtimeUrl : '') ?? chosen.url)
    const { downloadsDir, runtimeDir } = this.paths
    const archive = path.join(downloadsDir, path.basename(new URL(url).pathname))
    const destination = path.join(runtimeDir, variant)
    this.log(`downloading ${chosen.label} from ${url}`)
    this.setDownload({ label: `runtime · ${variant}`, received: 0, total: 0 })
    try {
      const bytes = await downloadToFile(url, archive, (received, total) => {
        this.setDownload({ label: `runtime · ${variant}`, received, total })
      })
      this.setDownload({ label: 'unpacking', received: 0, total: 0 })
      this.log(`downloaded ${bytes} bytes to ${archive}`)
      await extractZip(archive, destination)
    } finally {
      this.setDownload(undefined)
    }
    this.log(`extracted ${chosen.label} into ${destination}`)

    // Remember the binary that was just installed, and give a GPU build the
    // offload setting it was downloaded for.
    const installed = [
      path.join(destination, 'llama-server.exe'),
      path.join(destination, 'build', 'bin', 'llama-server.exe'),
      path.join(destination, 'llama-server'),
    ].find((candidate) => isFileSync(candidate))
    if (installed === undefined) {
      throw new Error(`The ${chosen.label} archive extracted, but no llama-server binary was found inside it.`)
    }
    await this.saveSettings(variant === 'vulkan' ? { binaryPath: installed, gpuLayers: 99 } : { binaryPath: installed })
    this.log(`runtime binary: ${installed}`)
    return this.snapshot()
  }

  /** Download one model group and select its first shard. */
  async installModel(args = {}) {
    const repo = assertSafeRepoPath(String(args.repo ?? 'LiquidAI/LFM3-1.7B-GGUF'))
    let group
    if (Array.isArray(args.files) && args.files.length > 0) {
      group = {
        files: args.files.map((entry, index) => ({
          path: assertSafeRepoPath(typeof entry === 'string' ? entry : entry?.path),
          index,
          bytes: typeof entry === 'object' && entry !== null ? Number(entry.bytes) || 0 : 0,
        })),
      }
    } else if (typeof args.file === 'string' && args.file.trim() !== '') {
      group = { files: [{ path: assertSafeRepoPath(args.file.trim()), index: 0, bytes: 0 }] }
    } else if (typeof args.group === 'string' && args.group.trim() !== '') {
      const listing = await listRepoFiles(repo)
      const match = listing.groups.find((candidate) => candidate.id === args.group)
      if (match === undefined) throw new Error(`That repository no longer offers "${args.group}".`)
      group = { files: match.files.map((file, index) => ({ ...file, index })) }
    } else {
      const listing = await listRepoFiles(repo)
      const fallback = listing.groups.find((candidate) => /q4_k_m/iu.test(candidate.label)) ?? listing.groups[0]
      if (fallback === undefined) throw new Error(`${repo} publishes no .gguf file.`)
      group = { files: fallback.files.map((file, index) => ({ ...file, index })) }
    }

    this.setDownload({ label: 'model', received: 0, total: 0 })
    try {
      return await downloadModelGroup(this, repo, group)
    } finally {
      this.setDownload(undefined)
    }
  }

  /**
   * First-activation setup: what makes installing the bundle the only step a
   * recipient performs. `autoModel` is `org/repo` or `org/repo#file.gguf`; an
   * empty value installs only the runtime and leaves the model to the panel.
   */
  async provision() {
    if (this.provisioning === true) return
    this.provisioning = true
    try {
      if (this.binaryPath() === undefined && this.settings.autoSetup !== false) {
        this.log('first run: installing the llama.cpp runtime')
        const variant = this.settings.autoRuntime === 'vulkan' ? 'vulkan' : 'cpu'
        await this.installRuntime(variant)
      }
      const spec = String(this.settings.autoModel ?? '').trim()
      if (spec !== '' && this.modelPath() === undefined) {
        const [repo, file] = spec.split('#')
        this.log(`first run: downloading ${spec}`)
        await this.installModel({ repo: repo.trim(), file: file === undefined ? undefined : file.trim() })
      }
      if (this.settings.autoStart === true && this.state !== 'ready') {
        await this.start()
      }
    } finally {
      this.provisioning = false
    }
  }

  async init() {
    const settingsFile = pathsFor(this.settings).settingsFile
    const stored = await readJson(settingsFile)
    this.settings = mergeSettings(this.config, stored)

    // Directories follow the stored settings, so they are created after loading.
    const paths = this.paths
    await fs.mkdir(paths.modelsDir, { recursive: true })
    await fs.mkdir(paths.runtimeDir, { recursive: true })
    await fs.mkdir(paths.cacheDir, { recursive: true })
    await this.pruneCache()
    const cacheFile = this.cacheFile()
    if (cacheFile !== undefined) {
      this.cacheBytes = (await fs.stat(cacheFile.path).catch(() => ({ size: 0 }))).size
    }

    // A stored window beyond the ceiling would make every request a many-minute
    // prefill that DSH never compacts around; reduce it once, and say so.
    const resolution = this.resolveContext()
    if (resolution.clamped) {
      // Fall back to the interactive default, not merely the ceiling: a window at
      // the ceiling still costs minutes of prompt prefill on this hardware.
      const migrated = Math.min(resolution.effective, DEFAULT_CONTEXT)
      this.contextClampedFrom = resolution.requested
      this.contextClampedTo = migrated
      await this.saveSettings({ contextSize: migrated })
      this.log(
        `context window reduced from ${resolution.requested} to ${migrated}: ` +
          `this machine prefills roughly 100 tokens a second, and the Harness keeps history up to the ` +
          `window it is told about before compacting, so a larger value makes every answer wait minutes`,
      )
    }
  }

  async saveSettings(patch) {
    const next = mergeSettings(this.config, { ...this.settings, ...patch })
    this.settings = next
    const { settingsFile } = this.paths
    const { dataDir, ...rest } = next
    await writeJson(settingsFile, rest)
    this.changed()
    return next
  }

  binaryPath() {
    const { runtimeDir } = this.paths
    const candidates = [
      this.settings.binaryPath,
      path.join(runtimeDir, 'vulkan', 'llama-server.exe'),
      path.join(runtimeDir, 'cpu', 'llama-server.exe'),
      path.join(runtimeDir, 'llama-server.exe'),
      path.join(runtimeDir, 'llama-server'),
      path.join(runtimeDir, 'vulkan', 'build', 'bin', 'llama-server.exe'),
      path.join(runtimeDir, 'cpu', 'build', 'bin', 'llama-server.exe'),
      path.join(runtimeDir, 'build', 'bin', 'llama-server.exe'),
      path.join(runtimeDir, 'build', 'bin', 'llama-server'),
    ].filter((value) => typeof value === 'string' && value.length > 0)
    for (const candidate of candidates) if (isFileSync(candidate)) return candidate
    return undefined
  }

  /** Which published build the detected binary came from, when it is decidable. */
  runtimeVariant() {
    const binary = this.binaryPath()
    if (binary === undefined) return ''
    const lowered = binary.toLowerCase()
    if (lowered.includes('vulkan')) return 'vulkan'
    if (lowered.includes('\\cpu\\') || lowered.includes('/cpu/')) return 'cpu'
    return 'cpu'
  }

  modelPath() {
    const configured = this.settings.modelPath
    if (typeof configured === 'string' && configured.length > 0 && isFileSync(configured)) return configured
    const { modelsDir } = this.paths
    try {
      const entries = fsSync
        .readdirSync(modelsDir)
        .filter((name) => name.toLowerCase().endsWith('.gguf'))
        .sort()
      if (entries.length > 0) return path.join(modelsDir, entries[0])
    } catch {
      /* no models directory yet */
    }
    return undefined
  }

  /** The model the next start would serve, independent of any running one. */
  configuredModelId() {
    if (typeof this.settings.modelId === 'string' && this.settings.modelId.trim() !== '') return this.settings.modelId.trim()
    const modelPath = this.modelPath()
    if (modelPath === undefined) return 'local-model'
    return path.basename(modelPath).replace(/\.gguf$/iu, '')
  }

  /**
   * The model the catalog advertises. While a server is up this is the model it
   * loaded, so downloading another file cannot silently rename a live route.
   */
  modelId() {
    return this.runningModelId ?? this.configuredModelId()
  }

  baseURL() {
    return `http://127.0.0.1:${this.settings.port}`
  }

  /**
   * Per-launch bearer token. llama-server otherwise accepts every origin, so a
   * page in the user's browser could drive the model directly; the token is
   * held in memory only and never reaches the page.
   */
  apiKey() {
    return this.launchKey
  }

  authHeaders() {
    return this.launchKey === undefined ? {} : { authorization: `Bearer ${this.launchKey}` }
  }

  /** Models the local server advertises, or the configured one while stopped. */
  async modelIds() {
    const id = this.modelId()
    if (this.state !== 'ready' && this.state !== 'starting') return [id]
    try {
      const response = await fetch(`${this.baseURL()}/v1/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) return [id]
      const body = await response.json()
      const ids = Array.isArray(body?.data)
        ? body.data.map((entry) => (typeof entry?.id === 'string' ? entry.id : undefined)).filter(Boolean)
        : []
      return ids.length > 0 ? ids : [id]
    } catch {
      return [id]
    }
  }

  async start() {
    if (this.state === 'ready') return this.snapshot()
    if (this.loading !== undefined) return this.loading
    const binary = this.binaryPath()
    if (binary === undefined) {
      this.state = 'unavailable'
      this.lastError = 'No llama-server binary found. Download the runtime from this panel, or set its path.'
      return this.snapshot()
    }
    const modelPath = this.modelPath()
    if (modelPath === undefined) {
      this.state = 'unavailable'
      this.lastError = 'No .gguf model file found. Download a model from this panel, or set its path.'
      return this.snapshot()
    }

    this.state = 'starting'
    this.lastError = ''
    this.logs = []
    this.changed()
    this.launchKey = randomBytes(24).toString('hex')
    this.runningModelPath = modelPath
    const context = this.resolveContext()
    const outputCap = this.outputCap()
    this.log(`launching ${binary}`)
    this.log(`context ${context.effective} (requested ${context.requested}, limit ${context.limit}), output cap ${outputCap}`)
    const args = [
      '-m',
      modelPath,
      '-a',
      this.modelId(),
      '--host',
      '127.0.0.1',
      '--port',
      String(this.settings.port),
      '-c',
      String(context.effective),
      // One slot: a CPU model answers serially anyway, and extra slots multiply
      // the KV cache this launch has to allocate.
      '-np',
      '1',
      // A generation cap keeps a runaway answer from holding a step open.
      '-n',
      String(outputCap),
      '-t',
      String(this.settings.threads),
      '-ngl',
      String(this.settings.gpuLayers),
      '--jinja',
      // Prometheus counters: the panel's token, throughput, and call figures.
      '--metrics',
      ...(this.cacheEnabled() ? ['--slot-save-path', this.paths.cacheDir] : []),
      ...(this.thinkingEnabled() ? [] : ['--reasoning-budget', '0']),
      '--api-key',
      this.launchKey,
      ...this.settings.extraArgs,
    ]
    this.log(`args ${args.map((value) => (value === this.launchKey ? '<generated key>' : value)).join(' ')}`)

    let child
    try {
      child = spawn(binary, args, {
        cwd: path.dirname(binary),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.state = 'error'
      this.lastError = `Could not launch llama-server: ${error?.message ?? error}`
      return this.snapshot()
    }
    this.child = child
    child.stdout?.on('data', (chunk) => this.log(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk) => this.log(chunk.toString('utf8')))
    child.on('exit', (code, signal) => {
      this.log(`llama-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      if (this.child === child) {
        this.child = undefined
        this.runningPort = undefined
        this.runningModelId = undefined
        this.runningModelPath = undefined
        if (this.state !== 'stopped') {
          this.state = code === 0 ? 'stopped' : 'error'
          if (code !== 0) this.lastError = `llama-server exited with code ${code ?? 'null'}.`
        }
        this.changed()
      }
    })

    this.loading = this.waitReady(child)
    try {
      return await this.loading
    } finally {
      this.loading = undefined
    }
  }

  async waitReady(child) {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (this.child !== child) {
        this.state = 'error'
        if (this.lastError === '') this.lastError = 'llama-server stopped before it became ready.'
        this.changed()
        return this.snapshot()
      }
      try {
        const response = await fetch(`${this.baseURL()}/health`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(3000),
        })
        if (response.ok) {
          const body = await response.json().catch(() => ({}))
          if (body?.status === undefined || body.status === 'ok') {
            this.state = 'ready'
            this.runningPort = this.settings.port
            this.startedAt = Date.now()
            this.changed()
            await this.restoreCache()
            return this.snapshot()
          }
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    this.lastError = 'Timed out waiting for llama-server to become ready. The log above shows how far it got.'
    await this.stop({ keepState: true })
    this.state = 'error'
    this.changed()
    return this.snapshot()
  }

  async stop(options = {}) {
    if (options.keepState !== true) await this.saveCache(true)
    const child = this.child
    this.child = undefined
    this.launchKey = undefined
    this.runningPort = undefined
    this.runningModelId = undefined
    this.runningModelPath = undefined
    if (child !== undefined) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (options.keepState !== true) this.state = 'stopped'
    this.startedAt = 0
    this.changed()
    return this.snapshot()
  }

  async test(prompt) {
    if (this.state !== 'ready') throw new Error('Start the local model first.')
    const response = await fetch(`${this.baseURL()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        model: this.modelId(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok) throw new Error(`Local model replied ${response.status}: ${(await response.text()).slice(0, 400)}`)
    const body = await response.json()
    return {
      text: body?.choices?.[0]?.message?.content ?? '',
      usage: body?.usage ?? {},
      finish: body?.choices?.[0]?.finish_reason ?? '',
    }
  }

  snapshot() {
    const modelPath = this.modelPath()
    const binary = this.binaryPath()
    return {
      state: this.state,
      providerId: this.settings.providerId,
      modelId: this.modelId(),
      configuredModelId: this.configuredModelId(),
      configuredModelPath: this.modelPath() ?? '',
      runningModelId: this.runningModelId ?? '',
      runningModelPath: this.runningModelPath ?? '',
      baseURL: this.baseURL(),
      port: this.settings.port,
      contextSize: this.resolveContext().effective,
      contextRequested: this.resolveContext().requested,
      contextLimit: this.resolveContext().limit,
      contextClampedFrom: this.contextClampedFrom ?? 0,
      trainedContext: this.trainedContext ?? 0,
      thinking: this.thinkingEnabled(),
      limitTools: this.settings.limitTools !== false,
      maxToolTokens: Number(this.settings.maxToolTokens) || 0,
      excludeTools: Array.isArray(this.settings.excludeTools) ? this.settings.excludeTools : [],
      maxOutputTokens: this.outputCap(),
      threads: this.settings.threads,
      gpuLayers: this.settings.gpuLayers,
      autoStart: this.settings.autoStart,
      binaryPath: binary ?? '',
      binaryConfigured: typeof this.settings.binaryPath === 'string' && this.settings.binaryPath.length > 0,
      autoSetup: this.settings.autoSetup !== false,
      autoRuntime: this.settings.autoRuntime === 'vulkan' ? 'vulkan' : 'cpu',
      autoModel: String(this.settings.autoModel ?? ''),
      provisioning: this.provisioning === true,
      runtimeVariant: this.runtimeVariant(),
      platform: `${process.platform}-${process.arch}`,
      // The pinned llama.cpp release publishes Windows binaries only.
      runtimeInstalls: process.platform === 'win32' && process.arch === 'x64',
      modelPath: modelPath ?? '',
      modelBytes: modelPath === undefined ? 0 : (fsSync.statSync(modelPath).size ?? 0),
      modelsDir: this.paths.modelsDir,
      runtimeDir: this.paths.runtimeDir,
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
      /** Epoch start, so the panel interpolates uptime between frames. */
      startedAtMs: this.startedAt === 0 ? 0 : this.startedAt,
      performance: this.performanceSnapshot(),
      cache: {
        enabled: this.cacheEnabled(),
        path: this.cacheFile()?.path ?? '',
        bytes: this.cacheBytes,
        restoredTokens: this.cacheRestoredTokens,
      },
      download: this.download,
      /** Needed to open the status stream; scoped to this activation. */
      streamToken: this.streamToken,
      lastError: this.lastError,
      logs: this.logs.slice(-160),
      extraArgs: this.settings.extraArgs,
    }
  }
}

/* ------------------------------------------------------------ model files */

async function listModels(modelsDir) {
  try {
    const entries = await fs.readdir(modelsDir)
    const rows = []
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.gguf')) continue
      const full = path.join(modelsDir, name)
      const info = await fs.stat(full).catch(() => undefined)
      if (info?.isFile() !== true) continue
      rows.push({ path: full, name, bytes: info.size })
    }
    rows.sort((left, right) => left.name.localeCompare(right.name))
    return rows
  } catch {
    return []
  }
}

/* --------------------------------------------------------------- download */

const HF_API = 'https://huggingface.co/api'
const HF_RESOLVE = 'https://huggingface.co'

/** Resumable download. Returns the final byte count of the destination. */
async function downloadToFile(url, destination, onProgress, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.part`

  let partial = 0
  try {
    partial = (await fs.stat(temporary)).size
  } catch {
    partial = 0
  }
  // A resumed download that already reached the advertised size needs no request.
  if (options.expected > 0 && partial === options.expected) {
    await fs.rename(temporary, destination)
    onProgress?.(partial, partial)
    return partial
  }
  if (partial > 0) headers.range = `bytes=${partial}-`

  const response = await fetch(url, { redirect: 'follow', headers })
  if (response.status === 416) {
    await fs.rename(temporary, destination)
    return partial
  }
  if (!response.ok || response.body === null) {
    const token = hfToken()
    const hint =
      (response.status === 401 || response.status === 403) && token === undefined
        ? ' This repository may be gated: set HF_TOKEN in the environment that launches the Harness.'
        : ''
    throw new Error(`Download failed with HTTP ${response.status} for ${url}.${hint}`)
  }

  const appending = response.status === 206 && partial > 0
  const startAt = appending ? partial : 0
  const length = Number(response.headers.get('content-length') ?? 0)
  onProgress?.(startAt, length > 0 ? startAt + length : options.expected ?? 0)

  let received = startAt
  const sink = createWriteStream(temporary, appending ? { flags: 'a' } : {})
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    onProgress?.(received, length > 0 ? startAt + length : options.expected ?? 0)
  })
  await pipeline(source, sink)
  await fs.rename(temporary, destination)
  return received
}

function hfToken() {
  const raw = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN
  const token = typeof raw === 'string' ? raw.trim() : ''
  return token === '' ? undefined : token
}

function hfHeaders(extra) {
  const headers = { 'user-agent': 'dsh-local-llm/1.0' }
  const token = hfToken()
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return { ...headers, ...(extra ?? {}) }
}

/** Size of one resolve URL, or undefined when the endpoint hides it. */
async function headSize(repo, file) {
  try {
    const response = await fetch(`${HF_RESOLVE}/${repo}/resolve/main/${encodeSegments(file)}`, {
      method: 'HEAD',
      redirect: 'follow',
      headers: hfHeaders(),
      signal: AbortSignal.timeout(8000),
    })
    const length = Number(response.headers.get('content-length') ?? 0)
    return response.ok && length > 0 ? length : undefined
  } catch {
    return undefined
  }
}

function encodeSegments(file) {
  return file.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function assertSafeRepoPath(value) {
  const text = String(value ?? '')
  if (text === '' || text.includes('..') || text.includes('\\') || text.startsWith('/')) {
    throw new Error(`Refusing an unexpected repository path: "${text}"`)
  }
  if (!/^[\w.\-/ ()+]+$/.test(text)) throw new Error(`Refusing an unexpected repository path: "${text}"`)
  return text
}

/**
 * Group a repository's `.gguf` files. A split model (`…-00001-of-00003.gguf`)
 * becomes one entry whose parts are downloaded in order, because llama.cpp
 * loads the first shard only when its siblings sit beside it.
 */
function groupGgufFiles(names) {
  const groups = new Map()
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.gguf')) continue
    const split = /^(?<stem>.+)-(?<index>\d{5})-of-(?<count>\d{5})\.gguf$/iu.exec(name)
    const key = split === null ? name : split.groups.stem
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        label: split === null ? name : `${split.groups.stem} · ${Number(split.groups.count)} parts`,
        split: split !== null,
        files: [],
      })
    }
    groups.get(key).files.push({ path: name, index: split === null ? 0 : Number(split.groups.index) })
  }
  const rows = [...groups.values()]
  for (const row of rows) row.files.sort((left, right) => left.index - right.index)
  rows.sort((left, right) => left.label.localeCompare(right.label))
  return rows
}

/**
 * One page of repositories. Hugging Face pages with an opaque cursor published
 * in the `Link` header, so the caller walks forward through `nextCursor` and
 * keeps the cursors it has already visited to walk back.
 */
async function searchRepos(query, limit, cursor) {
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const params = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(size) })
  const text = String(query ?? '').trim()
  if (text !== '') params.set('search', text)
  if (typeof cursor === 'string' && cursor !== '') params.set('cursor', cursor)

  const response = await fetch(`${HF_API}/models?${params.toString()}`, {
    headers: hfHeaders(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Hugging Face search failed with HTTP ${response.status}.`)
  const body = await response.json()
  const rows = Array.isArray(body) ? body : []
  const results = rows.map((entry) => ({
    id: String(entry.id ?? ''),
    downloads: Number(entry.downloads ?? 0),
    likes: Number(entry.likes ?? 0),
    gated: entry.gated !== undefined && entry.gated !== false,
    updated: typeof entry.lastModified === 'string' ? entry.lastModified : '',
  }))

  let nextCursor
  const link = response.headers.get('link')
  if (typeof link === 'string' && link !== '') {
    for (const part of link.split(',')) {
      if (!/rel="?next"?/iu.test(part)) continue
      const target = /<([^>]+)>/u.exec(part)
      if (target === null) continue
      try {
        nextCursor = new URL(target[1], HF_API).searchParams.get('cursor') ?? undefined
      } catch {
        /* a malformed link only costs the forward button */
      }
    }
  }
  return { results, nextCursor: nextCursor ?? null }
}

async function listRepoFiles(repo) {
  const cleaned = assertSafeRepoPath(repo)
  const response = await fetch(`${HF_API}/models/${cleaned}`, {
    headers: hfHeaders(),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401 || response.status === 403) {
    const token = hfToken()
    const suffix =
      token === undefined
        ? ' Set HF_TOKEN in the environment that launches the Harness, then try again.'
        : ' The HF_TOKEN in this environment was not accepted for that repository.'
    throw new Error(
      `Hugging Face refused ${cleaned} (HTTP ${response.status}). The repository may not exist, or it may be gated.${suffix}`,
    )
  }
  if (response.status === 404) throw new Error(`Hugging Face has no repository named ${cleaned}.`)
  if (!response.ok) throw new Error(`Hugging Face could not describe ${cleaned} (HTTP ${response.status}).`)
  const body = await response.json()
  const names = (body.siblings ?? [])
    .map((sibling) => sibling?.rfilename)
    .filter((name) => typeof name === 'string' && name.toLowerCase().endsWith('.gguf'))
  const groups = groupGgufFiles(names)

  // Sizes come from the resolve endpoint; a bounded number of HEADs keeps a
  // large repository from turning one listing into a hundred requests.
  let budget = 24
  const pending = []
  for (const group of groups) {
    for (const file of group.files) {
      if (budget <= 0) break
      budget -= 1
      pending.push(
        headSize(cleaned, file.path).then((bytes) => {
          file.bytes = bytes
        }),
      )
    }
    if (budget <= 0) break
  }
  await Promise.all(pending)

  return {
    repo: cleaned,
    gated: body.gated !== undefined && body.gated !== false,
    groups: groups.map((group) => ({
      id: group.id,
      label: group.label,
      split: group.split,
      // A 4-bit K-quant is the usual "runs on a laptop" pick; mark it for the browser.
      recommended: /q4_k_m/iu.test(group.label),
      bytes: group.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) || undefined,
      files: group.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    })),
  }
}

/** Delete one downloaded model, refusing anything outside the models folder. */
async function removeModelFile(manager, filePath) {
  const root = path.resolve(manager.paths.modelsDir)
  const resolved = path.resolve(String(filePath ?? ''))
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('That file is outside the models folder, so the panel will not delete it.')
  }
  if (!resolved.toLowerCase().endsWith('.gguf')) throw new Error('Only .gguf model files can be removed here.')
  if (manager.runningModelPath !== undefined && path.resolve(manager.runningModelPath) === resolved) {
    throw new Error('Stop the model before removing the file it is serving.')
  }
  await fs.rm(resolved, { force: true })
  await fs.rm(`${resolved}.part`, { force: true })
  if (manager.modelPath() !== undefined && path.resolve(manager.modelPath()) === resolved) {
    await manager.saveSettings({ modelPath: '' })
  }
  return { ...manager.snapshot(), models: await listModels(manager.paths.modelsDir) }
}

/** Download every part of one model, then point the plugin at its first shard. */
async function downloadModelGroup(manager, repo, group) {
  const files = group.files.map((file) => assertSafeRepoPath(file.path))
  if (files.length === 0) throw new Error('That repository entry has no .gguf file to download.')
  const total = group.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) || 0
  let completed = 0
  let firstPath

  for (const [index, relative] of files.entries()) {
    const url = `${HF_RESOLVE}/${repo}/resolve/main/${encodeSegments(relative)}`
    const destination = path.join(manager.paths.modelsDir, path.basename(relative))
    const expected = group.files[index]?.bytes ?? 0
    const known = group.files[index]?.bytes ?? 0
    manager.log(`downloading ${url}`)
    let finalBytes = 0
    const bytes = await downloadToFile(
      url,
      destination,
      (received) => {
        manager.setDownload({
          label: files.length > 1 ? `model ${index + 1}/${files.length}` : 'model',
          received: completed + received,
          total: total > 0 ? total : known,
        })
      },
      { headers: hfHeaders(), expected },
    )
    finalBytes = bytes
    completed += finalBytes || expected || 0
    manager.log(`saved ${destination} (${finalBytes} bytes)`)
    firstPath = firstPath ?? destination
  }

  await manager.saveSettings({ modelPath: firstPath })
  return manager.snapshot()
}

async function extractZip(archive, destination) {
  await fs.mkdir(destination, { recursive: true })
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`],
        { windowsHide: true, stdio: 'ignore' },
      )
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exited with code ${code}`))))
    })
    return
  }
  await new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-o', archive, '-d', destination], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited with code ${code}`))))
  })
}

/* ---------------------------------------------------------- LLM adapter */

function toOpenAiContent(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block == null) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: this local model is text-only]')
    else if (block.type === 'file') parts.push(`[file omitted: ${block.attachment?.name ?? 'attachment'}]`)
  }
  return parts.join('\n')
}

function toOpenAiMessages(options) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    if (message == null) continue
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: toOpenAiContent(message.content),
      })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = (message.content ?? [])
        .filter((block) => block?.type === 'tool-call')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments ?? '{}' },
        }))
      const entry = { role: 'assistant', content: toOpenAiContent(message.content) }
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls
        if (entry.content === '') entry.content = null
      }
      messages.push(entry)
      continue
    }
    if (message.role === 'system' || message.role === 'developer') {
      const text = toOpenAiContent(message.content)
      if (text.trim() !== '') messages.push({ role: 'system', content: text })
      continue
    }
    messages.push({ role: 'user', content: toOpenAiContent(message.content) })
  }
  return messages
}

async function* streamLocalInner(manager, options, onFirstToken) {
  const base = manager.baseURL()
  const model = options.model ?? manager.modelId()
  const callStartedAt = performance.now()
  let announced = false
  const noteFirstToken = () => {
    if (announced) return
    announced = true
    onFirstToken?.(performance.now() - callStartedAt)
  }
  const body = {
    model,
    messages: toOpenAiMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    temperature: options.temperature ?? 0.7,
  }
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens
  } else if (typeof manager.outputCap === 'function') {
    // Never leave the cap to the server's "infinite": an unbounded reasoning
    // dump is what makes a first token look like it never arrives.
    body.max_tokens = manager.outputCap()
  }
  if (typeof manager.thinkingEnabled === 'function' && manager.thinkingEnabled() === false) {
    // The template honours this directly, which skips the thinking phase
    // entirely for models that would otherwise reason before answering.
    body.chat_template_kwargs = { enable_thinking: false }
  }
  const window = typeof manager.resolveContext === 'function' ? manager.resolveContext().effective : 0
  const historyTokens = Math.ceil(JSON.stringify(body.messages).length / 3.6)

  // A catalog bigger than the window is useless: the server refuses the request
  // outright. Give the model the tools that fit the space left after the
  // conversation, smallest schemas first, so core tools survive and the largest
  // blocks fall out.
  let offeredTools = Array.isArray(options.tools) ? options.tools : []
  if (window > 0 && offeredTools.length > 0 && typeof manager.selectTools === 'function') {
    const selection = manager.selectTools(offeredTools, window, historyTokens)
    offeredTools = selection.tools
    if (manager.stats !== undefined) {
      manager.stats.offeredTools = offeredTools.length
      manager.stats.droppedTools = selection.dropped
    }
    if (selection.dropped > 0) {
      manager.log?.(
        `offered ${offeredTools.length} of ${offeredTools.length + selection.dropped} tools ` +
          `(about ${selection.tokens} tokens) to fit the ${window}-token window`,
      )
    }
  }
  if (offeredTools.length > 0) {
    body.tools = offeredTools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
  }
  // Names the model may legitimately call. Anything else — including a tool the
  // trim removed — would reach the Harness as `unknown tool <name>`.
  const offeredNames = new Set(offeredTools.map((tool) => tool.name))

  let response
  // Measure before sending: the server's own refusal is correct but arrives
  // without saying whether the tool catalog or the conversation is what does not
  // fit. The estimate is deliberately coarse (about 3.6 characters a token), so
  // it only pre-empts requests that cannot fit at any tokenization.
  if (window > 0) {
    const toolChars = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0
    const toolsTokens = Math.ceil(toolChars / 3.6)
    const estimated = toolsTokens + historyTokens
    if (estimated > window * 1.3) {
      const summary =
        `This request cannot fit the local model: it is served with ${window} tokens, while the conversation alone is ` +
        `about ${historyTokens} tokens and the tools that fit are about ${toolsTokens}. ` +
        'Compact this conversation first, or raise "Context window" in the Local model panel.'
      manager.log?.(summary)
      throw new Error(summary)
    }
  }

  try {
    response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof manager.authHeaders === 'function' ? manager.authHeaders() : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (error) {
    throw new Error(
      `The local model is not reachable at ${base}. Open the Local model panel and start it. (${error?.message ?? error})`,
    )
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // llama.cpp refuses an oversized prompt immediately; say what to change
    // instead of surfacing the server's raw JSON.
    if (/exceed|context|n_tokens/iu.test(detail)) {
      const served = typeof manager.resolveContext === 'function' ? manager.resolveContext() : undefined
      const window = served?.effective ?? 0
      throw new Error(
        `This prompt is larger than the ${window}-token window the local model is served with, so it was refused ` +
          `instead of run. Raise "Context window" in the Local model panel (up to ${served?.limit ?? 'the limit'}), ` +
          `start a session with fewer tools, or compact the conversation first. ` +
          `Server said: ${detail.replace(/\s+/gu, ' ').slice(0, 240)}`,
      )
    }
    throw new Error(`Local model request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`)
  }
  if (response.body === null) throw new Error('Local model returned an empty stream.')

  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex = -1
  let reasoningIndex = -1
  /** slot -> { index, id, name, arguments } for a streamed OpenAI tool call. */
  const toolCalls = new Map()
  let finishReason = 'stop'
  let usage

  for await (const chunk of Readable.fromWeb(response.body)) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      let event
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      if (event.usage != null) usage = event.usage
      const choice = event.choices?.[0]
      if (choice == null) continue
      const delta = choice.delta ?? {}

      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning !== '') {
        noteFirstToken()
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
      }

      if (typeof delta.content === 'string' && delta.content !== '') {
        noteFirstToken()
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }

      for (const call of delta.tool_calls ?? []) {
        const slot = call.index ?? 0
        let entry = toolCalls.get(slot)
        if (entry === undefined) {
          // The index is reserved now, but nothing is emitted yet: a tool call
          // without a name assembles as `name: ""` and the Harness would run
          // `unknown tool ""`. Hold it until the name arrives.
          entry = { index: nextIndex++, id: call.id ?? `call_${slot}`, name: '', arguments: '', emitted: 0 }
          toolCalls.set(slot, entry)
        }
        if (typeof call.id === 'string' && call.id !== '') entry.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name !== '') entry.name += call.function.name
        const argumentsDelta = call.function?.arguments
        if (typeof argumentsDelta === 'string' && argumentsDelta !== '') entry.arguments += argumentsDelta
        if (!offeredNames.has(entry.name)) continue

        if (entry.emitted === 0) {
          // First flush: open the block and send everything buffered so far, name included.
          noteFirstToken()
          yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: entry.index,
            id: entry.id,
            name: entry.name,
            argumentsDelta: entry.arguments,
          }
          entry.emitted = entry.arguments.length
        } else if (entry.arguments.length > entry.emitted) {
          const pending = entry.arguments.slice(entry.emitted)
          entry.emitted = entry.arguments.length
          yield {
            type: 'tool-call-delta',
            index: entry.index,
            id: entry.id,
            name: entry.name,
            argumentsDelta: pending,
          }
        }
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finishReason = choice.finish_reason
      }
    }
  }

  // Deltas alone are a complete protocol: the assembler rebuilds each block from
  // its accumulated text or tool-call argument stream, so a `block-end` carrying
  // a partial block would replace the assembled value and is intentionally omitted.
  // A call the model never named is dropped and reported instead of being offered
  // to the Harness as `unknown tool ""`.
  for (const [, entry] of toolCalls) {
    if (entry.emitted > 0) continue
    manager.log?.(
      entry.name === ''
        ? `ignored a tool call with no name (id ${entry.id}); the model's chat template may not support tool calling`
        : `ignored a call to "${entry.name}", which was not offered: it was trimmed to fit the window (id ${entry.id})`,
    )
  }
  const emittedCalls = [...toolCalls.values()].filter((entry) => entry.emitted > 0)
  if (typeof usage === 'object' && usage !== null) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
      },
    }
  }
  yield {
    type: 'finish',
    // Only an emitted call makes the Harness expect a tool result; a dropped
    // nameless one must end the turn as a plain stop instead.
    reason:
      emittedCalls.length > 0
        ? { kind: 'tool-calls' }
        : finishReason === 'length'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' },
  }
}

/**
 * One model call. The wrapper owns the panel's call accounting: a call counts
 * as active from its first byte until its stream closes, and its first-token
 * latency folds into the average the panel reports.
 */
async function* streamLocal(manager, options) {
  let firstTokenMs
  let finished = false
  manager.beginCall?.()
  try {
    for await (const chunk of streamLocalInner(manager, options, (ms) => {
      if (firstTokenMs === undefined) firstTokenMs = ms
    })) {
      if (chunk.type === 'finish') finished = true
      yield chunk
    }
  } finally {
    // Runs on completion, provider failure, and consumer cancellation alike.
    manager.endCall?.(firstTokenMs, finished)
    if (finished) void manager.saveCache?.()
  }
}

function createAdapter(manager) {
  const resolve = async (provider, model) => {
    // Advertise what this machine can actually prefill, never the raw stored
    // number: DSH keeps history up to this window before it compacts, so an
    // oversized value turns every step into a multi-minute prompt evaluation.
    const resolution = typeof manager.resolveContext === 'function' ? manager.resolveContext() : undefined
    const effective = resolution?.effective ?? manager.snapshot?.().contextSize ?? DEFAULT_CONTEXT
    const contextWindow = effective > 0 ? effective : DEFAULT_CONTEXT
    const cap =
      typeof manager.outputCap === 'function'
        ? manager.outputCap()
        : Math.max(256, Math.min(DEFAULT_MAX_OUTPUT, Math.floor(contextWindow / 2)))
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens: cap,
    }
  }
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'Local model (llama.cpp)' }
    },
    providerRetryPolicy() {
      return { mode: 'normal', maxRetries: 1, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0.2 }
    },
    async listModels(provider) {
      const ids = await manager.modelIds()
      return ids.map((id) => ({ provider, id, name: id, inputModalities: ['text'] }))
    },
    resolveModel(provider, model) {
      return resolve(provider, model)
    },
    async prepareCall(provider, model) {
      const resolvedModel = await resolve(provider, model)
      return {
        model: resolvedModel,
        context: resolvedModel.context,
        inputModalities: ['text'],
        adapterDefaults: {},
        stream: (options) => streamLocal(manager, options),
      }
    },
    stream(options) {
      return streamLocal(manager, options)
    },
  }
  return adapter
}

/* --------------------------------------------------------------- the RPC */

function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function originAllowed(req, origin) {
  const requestOrigin = req.headers.origin
  if (requestOrigin === undefined) return true
  return requestOrigin === origin
}

/**
 * Attach one text/event-stream response to the manager's change feed. Kept out
 * of the route handler so the framing can be exercised against a real socket.
 */
function attachStatusStream(req, res, manager) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (snapshot) => {
    if (res.writableEnded) return
    try {
      res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`)
    } catch {
      /* the peer went away between the check and the write */
    }
  }
  send(manager.snapshot())
  const unsubscribe = manager.subscribe(send)
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return
    try {
      res.write(': keep-alive\n\n')
    } catch {
      /* ignored; the close handler retires this interval */
    }
  }, 15_000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) res.end()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
  return cleanup
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const manager = new LocalModel(ctx, config)
  let ready = manager.init()

  const ensureReady = () => {
    ready = ready.then(() => undefined)
    return ready
  }

  ctx.effect(() => {
    let disposed = false
    const { webServer } = ctx

    const removeRoute = webServer.register({
      kind: 'prefix',
      path: RPC_PREFIX,
      async handler(req, res) {
        const origin = webServer.getOrigin()
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, error: 'Only POST is supported.' })
          return
        }
        if (!originAllowed(req, origin)) {
          jsonResponse(res, 403, { ok: false, error: 'Cross-origin request refused.' })
          return
        }
        if (req.headers['x-local-llm'] !== '1') {
          jsonResponse(res, 403, { ok: false, error: 'Missing the panel request header.' })
          return
        }
        let request
        try {
          request = await readJsonBody(req)
        } catch (error) {
          jsonResponse(res, 400, { ok: false, error: error?.message ?? 'Malformed request body.' })
          return
        }
        const method = String(request?.method ?? '')
        const args = request?.args && typeof request.args === 'object' ? request.args : {}
        try {
          await ensureReady()
          const value = await dispatch(method, args)
          jsonResponse(res, 200, { ok: true, value })
        } catch (error) {
          jsonResponse(res, 200, { ok: false, error: error?.message ?? String(error) })
        }
      },
    })

    /**
     * Status stream. The page subscribes once and receives a snapshot whenever
     * the manager changes, so no surface has to poll or ask for a refresh.
     */
    const removeEvents = webServer.register({
      kind: 'prefix',
      path: EVENTS_PREFIX,
      async handler(req, res) {
        const origin = webServer.getOrigin()
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        if (!originAllowed(req, origin)) {
          res.writeHead(403)
          res.end('Cross-origin request refused.')
          return
        }
        let token
        try {
          token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? ''
        } catch {
          token = ''
        }
        if (token !== manager.streamToken) {
          res.writeHead(403)
          res.end('Bad stream token.')
          return
        }

        await ensureReady()
        attachStatusStream(req, res, manager)
      },
    })

    async function dispatch(method, args) {
      switch (method) {
        case 'status':
          return manager.snapshot()
        case 'configure': {
          const patch = {}
          for (const key of ['binaryPath', 'modelPath', 'modelId', 'port', 'contextSize', 'maxContextSize', 'maxOutputTokens', 'cacheDir', 'threads', 'gpuLayers']) {
            if (args[key] !== undefined) patch[key] = args[key]
          }
          if (Array.isArray(args.extraArgs)) patch.extraArgs = args.extraArgs.map(String)
          if (args.port !== undefined) patch.port = Number(args.port)
          if (args.contextSize !== undefined) patch.contextSize = Number(args.contextSize)
          if (args.maxContextSize !== undefined) patch.maxContextSize = Number(args.maxContextSize)
          if (args.maxOutputTokens !== undefined) patch.maxOutputTokens = Number(args.maxOutputTokens)
          if (args.thinking !== undefined) patch.thinking = Boolean(args.thinking)
          if (args.cacheToDisk !== undefined) patch.cacheToDisk = Boolean(args.cacheToDisk)
          if (args.limitTools !== undefined) patch.limitTools = Boolean(args.limitTools)
          if (args.maxToolTokens !== undefined) patch.maxToolTokens = Number(args.maxToolTokens)
          if (args.excludeTools !== undefined) {
            patch.excludeTools = (Array.isArray(args.excludeTools) ? args.excludeTools : String(args.excludeTools).split(','))
              .map((entry) => String(entry).trim())
              .filter((entry) => entry !== '')
          }
          if (args.threads !== undefined) patch.threads = Number(args.threads)
          if (args.gpuLayers !== undefined) patch.gpuLayers = Number(args.gpuLayers)
          if (args.autoStart !== undefined) patch.autoStart = Boolean(args.autoStart)
          if (args.autoSetup !== undefined) patch.autoSetup = Boolean(args.autoSetup)
          if (args.autoRuntime !== undefined) patch.autoRuntime = args.autoRuntime === 'vulkan' ? 'vulkan' : 'cpu'
          if (args.autoModel !== undefined) patch.autoModel = String(args.autoModel).trim()
          if (args.runtimeUrl !== undefined) patch.runtimeUrl = String(args.runtimeUrl).trim()
          await manager.saveSettings(patch)
          return manager.snapshot()
        }
        case 'start':
          return manager.start()
        case 'stop':
          return manager.stop()
        case 'restart':
          await manager.stop()
          return manager.start()
        case 'models':
          return { models: await listModels(manager.paths.modelsDir), current: manager.modelPath() ?? '' }
        case 'logs':
          return { logs: manager.snapshot().logs }
        case 'test':
          return manager.test(String(args.prompt ?? 'Say hello in one short sentence.'))
        case 'verifyProvider': {
          // Run one call through the Harness LLM service, not the local HTTP
          // endpoint, so this proves the adapter route the agent loop uses.
          const llm = ctx.get('llm')
          if (llm === undefined) throw new Error('The llm service is unavailable, so no provider route is registered.')
          const provider = manager.settings.providerId
          const model = manager.modelId()
          const text = []
          let finish
          for await (const chunk of llm.stream({
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: String(args.prompt ?? 'Reply with: provider ok') }] }],
            maxTokens: Number(args.maxTokens ?? 256),
            temperature: 0,
          })) {
            if (chunk.type === 'text-delta') text.push(chunk.text)
            else if (chunk.type === 'finish') finish = chunk.reason
          }
          return { provider, model, text: text.join(''), finish: finish?.kind ?? 'unknown' }
        }
        case 'downloadRuntime': {
          return manager.installRuntime(args.variant === 'vulkan' ? 'vulkan' : 'cpu', args.url)
        }
        case 'searchHuggingFace': {
          const page = await searchRepos(String(args.query ?? ''), args.limit, args.cursor)
          return { ...page, tokenConfigured: hfToken() !== undefined }
        }
        case 'listHuggingFaceRepo':
          return listRepoFiles(String(args.repo ?? ''))
        case 'removeModel':
          return removeModelFile(manager, String(args.path ?? ''))
        case 'downloadModel':
          return manager.installModel(args)
        default:
          throw new Error(`Unknown method "${method}".`)
      }
    }

    manager.log('Local model plugin ready.')
    // First activation setup: after this, installing the bundle is the only step
    // a recipient performs. Failures are logged, never thrown into activation.
    void (async () => {
      try {
        if (disposed) return
        await manager.provision()
      } catch (error) {
        manager.log(`first-run setup failed: ${error?.message ?? error}`)
      }
    })()
    return () => {
      disposed = true
      removeRoute()
      removeEvents()
      void manager.stop()
      void disposed
    }
  })

  const llm = ctx.get('llm')
  if (llm !== undefined) {
    const providerId = manager.settings.providerId
    manager.adapterHandle = llm.registerAdapter([providerId], createAdapter(manager))
    ctx.effect(() => () => {
      manager.adapterHandle?.()
      manager.adapterHandle = undefined
    })
  } else {
    manager.log('The llm service is unavailable, so the local model cannot register as a provider.')
  }
}

/**
 * Internals exported for offline tests only; the Loader reads `apply`,
 * `inject`, and `Config` and ignores everything else on this module.
 */
export const __internals = {
  streamLocal,
  toOpenAiMessages,
  createAdapter,
  LocalModel,
  searchRepos,
  listRepoFiles,
  groupGgufFiles,
  downloadToFile,
  downloadModelGroup,
  removeModelFile,
  RUNTIME_VARIANTS,
  attachStatusStream,
  parseHuggingFaceTarget: (repo, file) => `${HF_RESOLVE}/${repo}/resolve/main/${encodeSegments(file)}`,
}
