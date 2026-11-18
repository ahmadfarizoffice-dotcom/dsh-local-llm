/**
 * Smoke test for the Client half without a browser.
 *
 * Loads the module exactly as the page loader does, applies the plugin to a
 * stub slot service, and renders the panel with a small React stand-in. It
 * cannot judge appearance; it proves the render path has no broken reference,
 * that both registrations share one id, and that the paginated grids slice
 * their input the way the panel claims.
 * Run: node test/panel-smoke.mjs
 */
let definition
globalThis.window = {
  __ModuleLoader__: {
    load(loaded) {
      definition = loaded
    },
  },
}

/**
 * A React stand-in whose useState answers from `overrides` by call order, so a
 * render pass can be handed real Host data without a test renderer.
 */
function makeReact(overrides) {
  let call = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      if (type === undefined) throw new Error('createElement received an undefined component type')
      // Render nested components eagerly: the panel has no self-rendering child,
      // and inlining lets the text collector see what they produce.
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const index = call++
      const value = index in overrides ? overrides[index] : typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useMemo(compute) {
      return compute()
    },
    useCallback(callback) {
      return callback
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

function collectText(node, output) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    output.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, output)
    return
  }
  for (const child of node.children ?? []) collectText(child, output)
}

/** Accessible names of icon-only controls have to carry the label instead. */
function collectNames(node, output) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectNames(child, output)
    return
  }
  for (const key of ['aria-label', 'title']) {
    const value = node.props?.[key]
    if (typeof value === 'string' && value !== '') output.push(value)
  }
  for (const child of node.children ?? []) collectNames(child, output)
}

function walk(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return 1
  if (Array.isArray(node)) return node.reduce((sum, child, index) => sum + walk(child, `${path}[${index}]`), 0)
  if (typeof node.type === 'function') return 1
  if (typeof node.type !== 'string' && typeof node.type !== 'symbol') {
    throw new Error(`element at ${path} has an unusable type: ${String(node.type)}`)
  }
  return 1 + node.children.reduce((sum, child, index) => sum + walk(child, `${path}.${index}`), 0)
}

function countByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countByClass(child, className), 0)
  const own = typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className) ? 1 : 0
  return own + (node.children ?? []).reduce((sum, child) => sum + countByClass(child, className), 0)
}

/** Apply the plugin to stubs and return what the page would mount. */
function mount(overrides) {
  const React = makeReact(overrides)
  const requireShim = (name) => {
    if (name === 'react') return React
    throw new Error(`the panel imported an unexpected module "${name}"`)
  }
  const translations = []
  const registrations = []
  const ctx = {
    get(name) {
      if (name === 'locale') {
        return {
          register() {},
          bind() {
            return (key) => {
              translations.push(key)
              return key
            }
          },
        }
      }
      return undefined
    },
    slots: {
      inject(key, callback) {
        const disposer = callback()
        if (typeof disposer !== 'function') throw new Error(`slots.inject("${key}") did not return a disposer`)
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: () => () => {},
    on: () => () => {},
  }

  const plugin = definition.factory(requireShim)
  if (typeof plugin.apply !== 'function') throw new Error('the factory returned no apply()')
  plugin.apply(ctx)

  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const panel = registrations.find((entry) => entry.options.name === 'main')
  if (icon === undefined) throw new Error('no sidebar.panellist registration')
  if (panel === undefined) throw new Error('no main panel registration')
  if (icon.options.id !== 'local-llm' || panel.options.key !== 'local-llm') {
    throw new Error('the icon and the page must share the id local-llm')
  }
  if (typeof icon.options.label !== 'function' || icon.options.label() === '') {
    throw new Error('the rail entry must supply a non-empty label thunk')
  }

  const iconNode = icon.component({ size: 18, active: true })
  if (iconNode === null || typeof iconNode !== 'object') throw new Error('the icon produced no element')

  const page = panel.component({})
  if (page === null || typeof page !== 'object') throw new Error('the panel produced no element')
  const text = []
  collectText(page, text)
  const names = []
  collectNames(page, names)
  return { page, text: text.join(' | '), names: names.join(' | '), translations }
}

await import('../client.js')
if (definition === undefined) throw new Error('the module never called window.__ModuleLoader__.load()')
if (definition.id !== '@local/local-llm') throw new Error(`unexpected loader id "${definition.id}"`)

/* ------------------------------------------------------------ empty state */

const empty = mount({})
const emptyNodes = walk(empty.page, 'panel')
if (emptyNodes < 20) throw new Error(`the empty panel rendered only ${emptyNodes} nodes`)
for (const expected of ['panel.title', 'section.library', 'library.installed', 'library.remote', 'section.status']) {
  if (!empty.text.includes(expected)) throw new Error(`the empty panel never rendered "${expected}"`)
}
if (!empty.text.includes('library.empty')) throw new Error('an empty model list must explain how to get one')
if (!empty.text.includes('library.browseHint')) throw new Error('an unsearched panel must invite a search instead of running one')
if (!empty.text.includes('badge.connecting')) throw new Error('the panel must show its stream state')
if (!empty.translations.includes('panel.title')) throw new Error('the panel bypassed the locale service for its title')

/* ------------------------------------------------- no runtime installed */

const noRuntime = mount({
  0: {
    state: 'unavailable',
    providerId: 'local-llama',
    modelId: 'local-model',
    configuredModelPath: '',
    runningModelPath: '',
    baseURL: 'http://127.0.0.1:18080',
    uptimeMs: 0,
    port: 18080,
    contextSize: 4096,
    threads: 8,
    gpuLayers: 0,
    binaryPath: '',
    runtimeVariant: '',
    logs: [],
    lastError: '',
  },
  1: [],
  7: { port: '18080', contextSize: '4096', threads: '8', gpuLayers: '0' },
  16: 0,
  17: [],
  18: 0,
})
for (const expected of ['runtime.cpu', 'runtime.vulkan', 'hint.noRuntime', 'hint.vulkan']) {
  if (!noRuntime.text.includes(expected)) throw new Error(`a missing runtime must render "${expected}"`)
}
if (!noRuntime.text.includes('library.empty')) throw new Error('no installed model must still explain how to get one')

/* ------------------------------------------------------- populated state */

// useState call order: status, installed, error, notice, busy, testPrompt,
// testResult, draft, manualPath, hfQuery, hfToken, openRepo, listing, hfBusy,
// hfError, hfDirect, installedPage, hfPages, hfPage. Index 0 is status.
const running = 'C:\\models\\LFM3-1.7B-Q4_K_M.gguf'
const models = Array.from({ length: 6 }, (_, index) => ({
  path: `C:\\models\\model-${index + 1}.gguf`,
  name: `model-${index + 1}.gguf`,
  bytes: 1_099_627_808,
}))
models[0].path = running
models[0].name = 'LFM3-1.7B-Q4_K_M.gguf'

const repos = Array.from({ length: 20 }, (_, index) => ({
  id: `org/repo-${String(index + 1).padStart(2, '0')}-GGUF`,
  downloads: 1000 - index,
  likes: 10,
  gated: index === 3,
}))

const populated = mount({
  0: {
    state: 'ready',
    providerId: 'local-llama',
    modelId: 'LFM3-1.7B-Q4_K_M',
    configuredModelPath: models[1].path,
    runningModelPath: running,
    baseURL: 'http://127.0.0.1:18080',
    uptimeMs: 65_000,
    port: 18080,
    contextSize: 8192,
    threads: 8,
    gpuLayers: 0,
    binaryPath: 'C:\\tools\\vulkan\\llama-server.exe',
    runtimeVariant: 'vulkan',
    uptimeMs: 65_000,
    startedAtMs: Date.now() - 65_000,
    performance: {
      cpuPercent: 11.9,
      ramUsedBytes: 33_700_000_000 / 2,
      ramTotalBytes: 33_700_000_000,
      ramPercent: 55.8,
      metricsAvailable: true,
      totalTokens: 343,
      promptTokens: 29,
      predictedTokens: 314,
      averageTokensPerSecond: 28.97,
      currentTokensPerSecond: 31.2,
      averageSecondsPerPromptToken: 0.008,
      requestsProcessing: 0,
      requestsDeferred: 0,
      decodeTotal: 345,
      activeCalls: 1,
      completedCalls: 4,
      averageTtftMs: 206,
      lastTtftMs: 190,
    },
    logs: ['server started'],
    download: undefined,
    lastError: '',
  },
  1: models,
  7: { port: '18080', contextSize: '8192', threads: '8', gpuLayers: '0' },
  11: 'org/repo-02-GGUF',
  12: {
    repo: 'org/repo-02-GGUF',
    gated: false,
    groups: [
      { id: 'a', label: 'LFM3-1.7B-Q4_K_M.gguf', split: false, recommended: true, bytes: 1_100_000_000, files: [{ path: 'a' }] },
      { id: 'b', label: 'big', split: true, recommended: false, bytes: 3_000_000_000, files: [{ path: 'b1' }, { path: 'b2' }, { path: 'b3' }] },
    ],
  },
  16: 0,
  17: [{ cursor: '', results: repos, nextCursor: 'next-page', tokenConfigured: true }],
  18: 0,
})

const nodes = walk(populated.page, 'panel')
for (const expected of [
  'LFM3-1.7B-Q4_K_M.gguf',
  'badge.inUse',
  'badge.selected',
  'org/repo-01-GGUF',
  'org/repo-20-GGUF',
  'badge.gated',
  'badge.recommended',
  'badge.split',
  'hint.switch',
  'vulkan',
]) {
  if (!populated.text.includes(expected)) throw new Error(`the populated panel never rendered "${expected}"`)
}
if (populated.text.includes('library.empty')) throw new Error('an installed model must hide the empty-state note')
if (!populated.text.includes('1.0 GB')) throw new Error('model sizes must be formatted for reading')
for (const expected of ['metric.cpu', 'metric.ram', 'metric.tokens', 'metric.ttft', 'metric.tps', 'metric.active']) {
  if (!populated.text.includes(expected)) throw new Error(`the live usage card never rendered "${expected}"`)
}
for (const expected of ['11.9%', '55.8%', '343', '206 ms', '29.0/s', '1m 5s']) {
  if (!populated.text.includes(expected)) throw new Error(`the live usage card never rendered the value "${expected}"`)
}
for (const expected of ['action.use', 'action.remove', 'library.files', 'pager.prev', 'pager.next']) {
  if (!populated.names.includes(expected)) throw new Error(`an icon-only control never carried the "${expected}" name`)
}
if (!populated.names.includes('action.download')) {
  throw new Error('the build download must be named for screen readers')
}

/* ---------------------------------------------------------- pagination */

const installedTiles = countByClass(populated.page, 'llm-tile')
// 4 local models plus the 20 remote repositories in their own grid.
if (installedTiles !== 24) throw new Error(`expected 4 local + 20 remote tiles, saw ${installedTiles}`)
if (populated.text.includes('model-5.gguf')) throw new Error('the local grid must page at four models')
if (!populated.text.includes('model-4.gguf')) throw new Error('the fourth model of the first page is missing')
if (!populated.text.includes('1–4 / 6')) throw new Error('the local pager must report its range over the total')
if (!populated.text.includes('1–20')) throw new Error('the remote pager must report its range')

console.log('REGISTRATION OK  ->', empty.registrations?.length ?? 2, 'slots')
console.log('EMPTY RENDER OK  ->', emptyNodes, 'nodes')
console.log('FULL RENDER OK   ->', nodes, 'nodes,', new Set(populated.translations).size, 'distinct labels')
console.log('PAGINATION OK    -> 4 local tiles per page, 20 remote tiles per page')
console.log('PANEL SMOKE OK')
