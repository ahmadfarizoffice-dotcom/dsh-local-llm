/**
 * Client half of the Local model bundle.
 *
 * Two registrations that the shell pairs by id: the icon in the left rail
 * (`sidebar.panellist`) and the management page in the main column (`main`).
 *
 * One card owns every model the user can run — the ones already on disk and the
 * ones the Hugging Face navigator pulls — so a downloaded model, the shipped
 * LFM3 example, and a hand-picked file all appear in the same grid. The local
 * library pages four models at a time; the Hugging Face results page twenty at
 * a time, walking the cursor Hugging Face publishes.
 *
 * Everything comes from this package's Host half over `/local-llm/rpc`, so no
 * Harness Client package is imported here.
 */
window.__ModuleLoader__.load({
  id: '@local/local-llm',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'local-llm'
    const INSTALLED_PER_PAGE = 4
    const REMOTE_PER_PAGE = 20

    /* ------------------------------------------------------------ locale */

    const EN = {
      'panel.title': 'Local model',
      'panel.subtitle': 'Run a model on this computer and pick it in the composer.',
      'state.stopped': 'Stopped',
      'state.starting': 'Loading',
      'state.ready': 'Running',
      'state.idle': 'Idle',
      'state.error': 'Failed',
      'state.unavailable': 'Needs setup',
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.restart': 'Restart',
      'action.save': 'Apply changes',
      'action.test': 'Send test prompt',
      'action.verify': 'Verify in Harness',
      'action.use': 'Use',
      'action.selected': 'Selected',
      'action.remove': 'Remove',
      'action.download': 'Download',
      'pager.prev': 'Previous',
      'pager.next': 'Next',
      'pager.none': 'Nothing to page through',
      'section.status': 'Status',
      'section.usage': 'Live usage',
      'section.library': 'Models',
      'section.performance': 'Runtime settings',
      'section.test': 'Try the model',
      'section.logs': 'Server log',
      'metric.cpu': 'CPU',
      'metric.ram': 'RAM',
      'metric.tokens': 'Tokens processed',
      'metric.ttft': 'Avg first token',
      'metric.tps': 'Avg tokens/s',
      'metric.active': 'Active calls',
      'metric.deferred': 'Queued',
      'metric.pending': 'Waiting for the server',
      'field.port': 'Port',
      'field.context': 'Context window',
      'field.thinking': 'Let the model think before answering',
      'field.outputCap': 'Max output tokens',
      'field.autoStart': 'Start the server when the Harness starts',
      'field.binaryPath': 'llama-server path (empty = auto-detect)',
      'field.limitTools': 'Trim tools to fit the window',
      'hint.manualRuntime':
        'This build only ships Windows x64 binaries. Install llama.cpp yourself, then paste the full path to llama-server in the field above.',
      'field.toolBudget': 'Tool budget (0 = fill what is left)',
      'field.excludeTools': 'Never offer tools starting with (comma separated)',
      'hint.limitTools':
        'A large tool catalog can be bigger than the whole window. The plugin offers only the tools that fit the space left after the conversation, keeping small schemas and dropping the largest first.',
      'metric.tools': 'Tools offered',
      'field.cache': 'Keep the prompt cache on disk',
      'hint.cache':
        'Saves the processed prompt state after each turn so a restart reuses it instead of re-reading the same tokens. One file per model build — another model, or another engine version, cannot reuse it.',
      'hint.cacheFile': 'Cache file: {name} ({size})',
      'metric.cached': 'Cached prompt tokens',
      'hint.contextNow': 'Serving {context} tokens of context, {cap} tokens of output per answer; the Harness keeps history up to that window before it compacts.',
      'hint.contextClamped':
        'Reduced from {from} to {to}. This machine prefills about 100 tokens a second, so a larger window would make every answer wait minutes for the prompt alone.',
      'hint.thinking':
        'Off is faster: the model answers without a reasoning phase. Turn it on for harder questions and expect a longer wait before the first word.',
      'field.threads': 'CPU threads',
      'field.gpuLayers': 'GPU layers',
      'field.endpoint': 'Endpoint',
      'field.uptime': 'Uptime',
      'field.provider': 'Provider',
      'field.runtime': 'Runtime',
      'badge.inUse': 'In use',
      'badge.selected': 'Selected',
      'badge.recommended': 'Recommended',
      'badge.gated': 'Gated',
      'badge.split': '{count} parts',
      'badge.live': 'Live',
      'badge.reconnecting': 'Reconnecting',
      'badge.offline': 'Offline',
      'badge.connecting': 'Connecting',
      'library.browseHint': 'Search a repository above to list its GGUF builds.',
      'library.installed': 'On this computer',
      'library.empty': 'No model yet. Pull one from Hugging Face below, or point at a file you already have.',
      'library.manual': 'Use a file from this computer',
      'library.manualPlaceholder': 'Absolute path to a .gguf file',
      'library.remote': 'From Hugging Face',
      'library.searchPlaceholder': 'Search GGUF repositories, e.g. LFM3, Qwen3, Gemma',
      'library.search': 'Search',
      'library.searching': 'Searching…',
      'library.noResults': 'No GGUF repository matched that search.',
      'library.files': 'Files',
      'library.close': 'Close files',
      'library.direct': 'Or paste a repository or file address',
      'library.directPlaceholder': 'org/repo or org/repo/file.gguf',
      'library.noToken': 'HF_TOKEN is not set, so gated repositories cannot download.',
      'library.downloads': 'downloads',
      'library.likes': 'likes',
      'library.builds': 'Builds in {repo}',
      'hint.use':
        'Ready. In a chat, open the model selector in the composer and choose the “Local model (llama.cpp)” group — the agent then answers from this machine.',
      'hint.useIdle':
        'When it is running, open the model selector in the composer and choose the “Local model (llama.cpp)” group.',
      'hint.noRuntime': 'No llama.cpp runtime found yet. Install one of the two builds, then start the model.',
      'hint.vulkan': 'The Vulkan build can offload to the GPU: it sets GPU layers to 99 and needs a Vulkan driver. A model this small runs just as fast on the CPU build, so pick Vulkan for larger models.',
      'hint.saved': 'Saved. Changes take effect the next time you start the model.',
      'hint.verify':
        '“Verify in Harness” sends one prompt through the Harness provider route the agent uses, not through this panel’s own connection.',
      'hint.context':
        'The agent’s system prompt and tool schemas use context. 8192 or more is comfortable for chatting with the agent; a smaller window may reject a long request.',
      'hint.switch': 'Another model is selected than the one running. Restart to switch.',
      'hint.number': 'Enter a whole number for each setting.',
      'hint.direct': 'Use org/repo, org/repo/file.gguf, or a huggingface.co address.',
      'empty.logs': 'No output yet.',
      'runtime.cpu': 'Install llama.cpp (CPU)',
      'runtime.vulkan': 'Install llama.cpp (Vulkan)',
      'download.running': 'Downloading',
      'download.unpacking': 'Unpacking',
      'busy.loading': 'Working…',
      'prompt.default': 'In one sentence, what is a local language model?',
    }

    function makeTranslator(ctx) {
      let t = (key, params) => {
        const template = EN[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/gu, (whole, name) => (name in params ? String(params[name]) : whole))
      }
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          try {
            locale.register('local-llm', { en: EN })
          } catch {
            /* an unknown locale id only costs the dictionary */
          }
          const bound = locale.bind('local-llm')
          if (typeof bound === 'function') {
            t = (key, params) => {
              const template = bound(key) ?? ''
              const text = typeof template === 'string' && template !== '' ? template : (EN[key] ?? key)
              if (params === undefined) return text
              return text.replace(/\{(\w+)\}/gu, (whole, name) => (name in params ? String(params[name]) : whole))
            }
          }
        }
      } catch {
        /* keep the English fallback */
      }
      return t
    }

    /* -------------------------------------------------------------- styles */

    const CSS = `
.llm-page { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.llm-inner { max-width: 880px; margin: 0 auto; padding: 28px 24px 64px; display: flex; flex-direction: column; gap: 18px; }
.llm-head { display: flex; align-items: flex-start; gap: 12px; }
.llm-head-text { flex: 1 1 auto; min-width: 0; }
.llm-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.35; }
.llm-subtitle { margin: 4px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.llm-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.llm-card-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.llm-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.llm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.llm-dot.ready { background: var(--dsw-alias-state-success-primary); }
.llm-dot.starting { background: var(--dsw-alias-state-warn-primary); }
.llm-dot.error, .llm-dot.unavailable { background: var(--dsw-alias-state-error-primary); }
.llm-rows { display: grid; grid-template-columns: minmax(120px, 172px) 1fr; gap: 8px 16px; align-items: baseline; }
.llm-key { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.llm-value { font-size: 13px; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.llm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.llm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.llm-btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; cursor: pointer; white-space: nowrap; }
.llm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.llm-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.llm-btn:disabled { opacity: .5; cursor: default; }
.llm-btn.primary { background: transparent; border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.llm-btn.ghost { background: transparent; }
.llm-btn.danger { background: transparent; color: var(--dsw-alias-label-secondary); }
.llm-btn.danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.llm-btn.small { height: 26px; padding: 0 9px; font-size: 12px; }
.llm-btn.icon { width: 26px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.llm-link.live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.llm-link.reconnecting { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.llm-link.offline { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.llm-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; }
.llm-metric { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.llm-metric-label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.llm-metric-value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.llm-check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.llm-check input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); }
.llm-metric-detail { font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.llm-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.llm-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.llm-input { height: 30px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; min-width: 0; width: 100%; box-sizing: border-box; }
.llm-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.llm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.llm-note { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); margin: 0; }
.llm-banner { font-size: 12px; line-height: 1.55; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.llm-banner.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.llm-banner.ok { border-color: var(--dsw-alias-state-success-primary); }
.llm-logs { margin: 0; max-height: 210px; overflow: auto; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.llm-test-out { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.llm-test-out.error { border-color: var(--dsw-alias-state-error-primary); }
.llm-subhead { display: flex; align-items: baseline; gap: 8px; }
.llm-subhead-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.llm-search { display: flex; gap: 8px; align-items: center; }
.llm-search .llm-input { flex: 1 1 auto; }
.llm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(186px, 1fr)); gap: 10px; }
.llm-tile { display: flex; flex-direction: column; gap: 7px; padding: 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); min-width: 0; }
.llm-tile.picked { border-color: var(--dsw-alias-brand-primary); }
.llm-tile.live { border-color: var(--dsw-alias-state-success-primary); }
.llm-tile-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; min-height: 34px; }
.llm-tile-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.llm-tile-foot { display: flex; gap: 6px; align-items: center; margin-top: auto; }
.llm-tile-foot .llm-btn { flex: 1 1 auto; }
.llm-badges { display: flex; gap: 5px; flex-wrap: wrap; }
.llm-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.llm-badge.on { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.llm-badge.pick { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.llm-pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.llm-pager-text { font-variant-numeric: tabular-nums; }
.llm-builds { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.llm-builds-head { padding: 9px 11px; background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.llm-build { display: flex; align-items: center; gap: 10px; padding: 8px 11px; background: var(--dsw-alias-bg-base); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.llm-build:last-child { border-bottom: none; }
.llm-build-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`

    /* ----------------------------------------------------------------- rpc */

    async function rpc(method, args) {
      const response = await fetch('/local-llm/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-local-llm': '1' },
        body: JSON.stringify({ method, args: args ?? {} }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`The local model service answered HTTP ${response.status}.`)
      }
      if (body?.ok !== true) throw new Error(body?.error ?? `The local model service answered HTTP ${response.status}.`)
      return body.value
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
    }

    /**
     * Accept `org/repo`, `org/repo/file.gguf`, or a huggingface.co address and
     * return the repository plus the optional exact file.
     */
    function parseHuggingFaceInput(raw) {
      const text = String(raw ?? '').trim()
      if (text === '') return undefined
      const url = /^https?:\/\/huggingface\.co\/([^/?#]+)\/([^/?#]+)(?:\/(?:resolve|blob)\/[^/]+\/(.+))?/iu.exec(text)
      if (url !== null) {
        return { repo: `${url[1]}/${url[2]}`, file: url[3] === undefined ? undefined : decodeURIComponent(url[3]) }
      }
      const segments = text.split('/').filter((segment) => segment !== '')
      if (segments.length === 2) return { repo: `${segments[0]}/${segments[1]}` }
      if (segments.length >= 3) return { repo: `${segments[0]}/${segments[1]}`, file: segments.slice(2).join('/') }
      return undefined
    }

    function formatUptime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const seconds = Math.floor(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`
      return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    }

    function formatCount(value) {
      if (!Number.isFinite(value)) return '—'
      return Math.round(value).toLocaleString()
    }

    function formatPercent(value) {
      if (!Number.isFinite(value)) return '—'
      return `${value.toFixed(1)}%`
    }

    function formatMilliseconds(value) {
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1000) return `${Math.round(value)} ms`
      return `${(value / 1000).toFixed(1)} s`
    }

    function formatRate(value) {
      if (!Number.isFinite(value) || value <= 0) return '—'
      return `${value.toFixed(value >= 10 ? 1 : 2)}/s`
    }

    const KNOWN_STATES = new Set(['stopped', 'starting', 'ready', 'error', 'unavailable'])
    const LIST_REFRESH_METHODS = new Set(['downloadModel', 'downloadRuntime', 'removeModel'])
    const LINK_LABELS = {
      live: 'badge.live',
      reconnecting: 'badge.reconnecting',
      offline: 'badge.offline',
      idle: 'badge.connecting',
    }

    /* ------------------------------------------------------------ the icon */

    function LocalModelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', opacity: active ? 1 : 0.86 },
        },
        h('rect', { x: 3.5, y: 6.5, width: 17, height: 11, rx: 2.4 }),
        h('path', { d: 'M7.5 10.5h3.2M7.5 13.6h6.4' }),
        h('path', { d: 'M14.2 10.5h2.3' }),
        h('path', { d: 'M9.2 3.6v2.9M14.8 3.6v2.9M9.2 17.5v2.9M14.8 17.5v2.9' }),
      )
    }

    /* --------------------------------------------------------------- icons */

    /** One stroke set, drawn on a 24-unit grid, so card content reads at a glance. */
    const ICON_PATHS = {
      check: ['M4 12.6l5 5L20 6.6'],
      play: ['M8.4 5.4 18 12 8.4 18.6z'],
      trash: ['M4.5 7h15', 'M9.5 7V4.2h5V7', 'M6.2 7l1 13h9.6l1-13', 'M10.4 11.2v5.4', 'M13.6 11.2v5.4'],
      download: ['M12 3.4v11.2', 'M7.4 10 12 14.6 16.6 10', 'M4.6 20.4h14.8'],
      folder: ['M3.4 7.4h5.8l2 2.2h9.4v9.4H3.4z'],
      chevronLeft: ['M14.6 6.2 8.8 12l5.8 5.8'],
      chevronRight: ['M9.4 6.2 15.2 12l-5.8 5.8'],
      star: ['M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17.1l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z'],
      lock: ['M6.2 11h11.6v9.2H6.2z', 'M9 11V8.2a3 3 0 0 1 6 0V11'],
      layers: ['M12 3.6l8.6 4.8L12 13.2 3.4 8.4z', 'M3.4 13.4 12 18.2l8.6-4.8'],
      close: ['M6.4 6.4 17.6 17.6', 'M17.6 6.4 6.4 17.6'],
      dot: ['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z'],
      refresh: ['M19.6 12a7.6 7.6 0 1 1-2.2-5.3', 'M19.6 4.6v4.2h-4.2'],
      pulse: ['M3.4 12h4l2.4-5.2 3.6 10.4 2.4-5.2h4.8'],
      cpu: [
        'M8.6 8.6h6.8v6.8H8.6z',
        'M4 10.2h4.6M4 13.8h4.6M15.4 10.2H20M15.4 13.8H20',
        'M10.2 4v4.6M13.8 4v4.6M10.2 15.4V20M13.8 15.4V20',
      ],
      memory: ['M4.4 8h15.2v8H4.4z', 'M7.8 16v3.2M12 16v3.2M16.2 16v3.2', 'M8 11.4h2.2M12.4 11.4h3.4'],
      tokens: ['M9.6 4.6 8.2 19.4', 'M16 4.6l-1.4 14.8', 'M4.6 9.6h14.8', 'M4 14.4h14.8'],
      timer: ['M12 7.6V12l3 1.9', 'M12 4.2a8.3 8.3 0 1 1-5.9 2.4', 'M9.6 2.8h4.8'],
    }

    function Icon(props) {
      const name = props.name
      const paths = ICON_PATHS[name]
      if (paths === undefined) throw new Error(`unknown icon "${name}"`)
      const size = typeof props.size === 'number' ? props.size : 14
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.filled === true ? 0 : 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: '0 0 auto' },
        },
        ...paths.map((d, index) =>
          h('path', {
            key: index,
            d,
            fill: props.filled === true ? 'currentColor' : 'none',
          }),
        ),
      )
    }

    function iconButton(props) {
      const { name, label, className, disabled, onClick, title } = props
      return h(
        'button',
        {
          type: 'button',
          className: className ?? 'llm-btn small icon',
          disabled,
          title: title ?? label,
          'aria-label': label,
          onClick,
        },
        h(Icon, { name, size: 14 }),
      )
    }

    function iconBadge(name, text, className) {
      return h(
        'span',
        { className: `llm-badge${className ? ` ${className}` : ''}` },
        h(Icon, { name, size: 11 }),
        h('span', null, text),
      )
    }

    /* ---------------------------------------------------------- pagination */

    function Pager(props) {
      const { page, perPage, total, hasMore, label, onChange, disabled } = props
      const known = Math.max(total, (page + 1) * perPage)
      const pages = Math.max(1, Math.ceil(known / perPage) + (hasMore ? 1 : 0))
      if (pages <= 1) return null
      const start = page * perPage + 1
      const end = Math.min(known, (page + 1) * perPage)
      const text = hasMore ? `${start}–${end}` : `${start}–${end} / ${known}`
      return h(
        'div',
        { className: 'llm-pager' },
        iconButton({
          name: 'chevronLeft',
          label: label('pager.prev'),
          className: 'llm-btn small icon',
          disabled: disabled || page <= 0,
          onClick: () => onChange(Math.max(0, page - 1)),
        }),
        h('span', { className: 'llm-pager-text', role: 'status' }, `${text} · ${page + 1}/${pages}`),
        iconButton({
          name: 'chevronRight',
          label: label('pager.next'),
          className: 'llm-btn small icon',
          disabled: disabled || (page >= pages - 1 && !hasMore),
          onClick: () => onChange(page + 1),
        }),
      )
    }

    /* ----------------------------------------------------------- the panel */

    function LocalModelPanel() {
      const ctx = usePanelContext()
      const t = useMemo(() => makeTranslator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [installed, setInstalled] = useState([])
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [testPrompt, setTestPrompt] = useState(EN['prompt.default'])
      const [testResult, setTestResult] = useState(undefined)
      const [draft, setDraft] = useState(undefined)
      const [manualPath, setManualPath] = useState('')
      const [hfQuery, setHfQuery] = useState('')
      const [hfTokenConfigured, setHfTokenConfigured] = useState(true)
      const [hfOpenRepo, setHfOpenRepo] = useState('')
      const [hfListing, setHfListing] = useState(undefined)
      const [hfBusy, setHfBusy] = useState('')
      const [hfError, setHfError] = useState('')
      const [hfDirect, setHfDirect] = useState('')
      const [installedPage, setInstalledPage] = useState(0)
      const [hfPages, setHfPages] = useState([])
      const [hfPage, setHfPage] = useState(0)
      // Appended last so the earlier hook order stays stable; see the smoke test.
      const [link, setLink] = useState('idle')
      // A local clock so uptime advances every second even between frames.
      const [now, setNow] = useState(() => Date.now())
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const seedOf = (next) => ({
        port: String(next.port ?? ''),
        contextSize: String(next.contextSize ?? ''),
        threads: String(next.threads ?? ''),
        gpuLayers: String(next.gpuLayers ?? ''),
        thinking: next.thinking === true,
        cacheToDisk: next.cache?.enabled !== false,
        limitTools: next.limitTools !== false,
        binaryPath: String(next.binaryPathConfigured === true ? next.binaryPath ?? '' : ''),
        autoStart: next.autoStart === true,
        maxToolTokens: String(next.maxToolTokens ?? 0),
        excludeTools: Array.isArray(next.excludeTools) ? next.excludeTools.join(', ') : '',
      })

      const applyStatus = useCallback((next, reseed = false) => {
        if (next === undefined || next === null) return
        setStatus(next)
        setDraft((current) => (reseed || current === undefined ? seedOf(next) : current))
      }, [])

      /** Poll-only refresh: it must never erase a message the user has to read. */
      const refresh = useCallback(async () => {
        const next = await rpc('status')
        if (!alive.current) return
        applyStatus(next)
      }, [applyStatus])

      const loadInstalled = useCallback(async () => {
        try {
          const next = await rpc('models')
          if (!alive.current) return
          setInstalled(Array.isArray(next?.models) ? next.models : [])
        } catch {
          /* the list is advisory */
        }
      }, [])

      useEffect(() => {
        void refresh().catch((caught) => {
          if (alive.current) setError(caught?.message ?? String(caught))
        })
        void loadInstalled()
      }, [refresh, loadInstalled])

      const state = status?.state ?? 'idle'
      // A start is in flight from the click until the stream reports a state.
      const starting = busy === 'start' || state === 'starting'

      // Uptime is interpolated locally: a frame can be a whole second apart, and
      // a frozen clock is exactly what made the panel feel stale.
      const startedAtMs = status?.startedAtMs ?? 0
      useEffect(() => {
        if (!(startedAtMs > 0)) return undefined
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [startedAtMs])

      // Status is pushed, never polled: one stream carries every state, log and
      // download change, so no surface has to refresh by hand.
      useEffect(() => {
        let closed = false
        let source
        let retry
        let fallback

        const connect = async () => {
          try {
            const snapshot = await rpc('status')
            if (closed) return
            applyStatus(snapshot)
            if (typeof EventSource !== 'function' || typeof snapshot?.streamToken !== 'string') {
              setLink('offline')
              return
            }
            if (source !== undefined) source.close()
            source = new EventSource(`/local-llm/events?token=${encodeURIComponent(snapshot.streamToken)}`)
            source.addEventListener('status', (event) => {
              try {
                applyStatus(JSON.parse(event.data))
              } catch {
                /* one malformed frame must not end the subscription */
              }
            })
            source.onopen = () => {
              setLink('live')
              if (fallback !== undefined) {
                clearInterval(fallback)
                fallback = undefined
              }
            }
            source.onerror = () => {
              setLink('reconnecting')
              if (source !== undefined) source.close()
              source = undefined
              if (fallback === undefined) {
                fallback = setInterval(() => {
                  void refresh().catch(() => {})
                }, 4000)
              }
              retry = setTimeout(() => {
                void connect()
              }, 3000)
            }
          } catch {
            if (closed) return
            setLink('offline')
            retry = setTimeout(() => {
              void connect()
            }, 4000)
          }
        }

        void connect()
        return () => {
          closed = true
          clearTimeout(retry)
          if (fallback !== undefined) clearInterval(fallback)
          if (source !== undefined) source.close()
        }
      }, [applyStatus, refresh])

      const run = useCallback(
        async (label, method, args, done) => {
          setBusy(label)
          setError('')
          setNotice('')
          try {
            const value = await rpc(method, args)
            if (!alive.current) return
            const snapshotMethods = method !== 'test' && method !== 'verifyProvider'
            if (snapshotMethods) {
              applyStatus(value, method === 'configure' || LIST_REFRESH_METHODS.has(method))
            }
            if (LIST_REFRESH_METHODS.has(method)) await loadInstalled()
            if (!alive.current) return
            if (typeof done === 'function') done(value)
            if (snapshotMethods && value?.lastError) setError(value.lastError)
          } catch (caught) {
            if (alive.current) setError(caught?.message ?? String(caught))
          } finally {
            if (alive.current) setBusy('')
          }
        },
        [applyStatus, loadInstalled],
      )

      /* ------------------------------------------------- model library */

      const useModel = useCallback(
        (modelPath) => {
          void run('use', 'configure', { modelPath }, () => setNotice(t('hint.saved')))
        },
        [run, t],
      )

      const removeModel = useCallback(
        (modelPath) => {
          void run(`remove:${modelPath}`, 'removeModel', { path: modelPath })
        },
        [run],
      )

      const useManualPath = useCallback(() => {
        const text = manualPath.trim()
        if (text === '') return
        void run('use', 'configure', { modelPath: text }, () => {
          setManualPath('')
          setNotice(t('hint.saved'))
        })
      }, [manualPath, run, t])

      /* ------------------------------------------- Hugging Face browsing */

      const fetchRemotePage = useCallback(async (query, cursor) => {
        const value = await rpc('searchHuggingFace', {
          query,
          limit: REMOTE_PER_PAGE,
          cursor: cursor === '' ? undefined : cursor,
        })
        return {
          cursor,
          results: Array.isArray(value?.results) ? value.results : [],
          nextCursor: typeof value?.nextCursor === 'string' ? value.nextCursor : null,
          tokenConfigured: value?.tokenConfigured !== false,
        }
      }, [])

      const startSearch = useCallback(async () => {
        setHfBusy('search')
        setHfError('')
        setHfOpenRepo('')
        setHfListing(undefined)
        try {
          const page = await fetchRemotePage(hfQuery, '')
          if (!alive.current) return
          setHfPages([page])
          setHfPage(0)
          setHfTokenConfigured(page.tokenConfigured)
        } catch (caught) {
          if (alive.current) setHfError(caught?.message ?? String(caught))
        } finally {
          if (alive.current) setHfBusy('')
        }
      }, [fetchRemotePage, hfQuery])

      // No default query: the panel opens on an empty browser and waits for the
      // user to name a repository.

      const goToRemotePage = useCallback(
        async (target) => {
          if (target < 0) return
          if (target < hfPages.length) {
            setHfPage(target)
            return
          }
          if (target > hfPages.length) return
          const last = hfPages[hfPages.length - 1]
          if (last === undefined || last.nextCursor === null || last.nextCursor === undefined) return
          setHfBusy('page')
          setHfError('')
          try {
            const page = await fetchRemotePage(hfQuery, last.nextCursor)
            if (!alive.current) return
            setHfPages((current) => [...current, page])
            setHfPage(target)
          } catch (caught) {
            if (alive.current) setHfError(caught?.message ?? String(caught))
          } finally {
            if (alive.current) setHfBusy('')
          }
        },
        [fetchRemotePage, hfPages, hfQuery],
      )

      const openRepoRef = useRef('')
      const openRepo = useCallback(async (repo) => {
        if (openRepoRef.current === repo) {
          openRepoRef.current = ''
          setHfOpenRepo('')
          setHfListing(undefined)
          return
        }
        openRepoRef.current = repo
        setHfOpenRepo(repo)
        setHfListing(undefined)
        setHfError('')
        setHfBusy(`list:${repo}`)
        try {
          const value = await rpc('listHuggingFaceRepo', { repo })
          if (!alive.current || openRepoRef.current !== repo) return
          setHfListing(value)
        } catch (caught) {
          if (alive.current && openRepoRef.current === repo) setHfError(caught?.message ?? String(caught))
        } finally {
          if (alive.current) setHfBusy('')
        }
      }, [])

      const downloadGroup = useCallback(
        (repo, group) => {
          void run(`download:${group.id}`, 'downloadModel', { repo, group: group.id })
        },
        [run],
      )

      const downloadDirect = useCallback(() => {
        const target = parseHuggingFaceInput(hfDirect)
        if (target === undefined) {
          setHfError(t('hint.direct'))
          return
        }
        if (target.file === undefined) {
          void openRepo(target.repo)
          return
        }
        void run(`download:${target.file}`, 'downloadModel', { repo: target.repo, file: target.file })
      }, [hfDirect, openRepo, run, t])

      const save = useCallback(() => {
        if (draft === undefined) return
        const numeric = { port: draft.port, contextSize: draft.contextSize, threads: draft.threads, gpuLayers: draft.gpuLayers }
        const patch = {
          thinking: draft.thinking === true,
          cacheToDisk: draft.cacheToDisk !== false,
          limitTools: draft.limitTools !== false,
          binaryPath: String(draft.binaryPath ?? '').trim(),
          autoStart: draft.autoStart === true,
          maxToolTokens: Number(draft.maxToolTokens) || 0,
          excludeTools: String(draft.excludeTools ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ''),
        }
        for (const [key, raw] of Object.entries(numeric)) {
          const text = String(raw ?? '').trim()
          const value = Number(text)
          if (text === '' || !Number.isFinite(value) || value < 0) {
            setError(t('hint.number'))
            return
          }
          patch[key] = Math.floor(value)
        }
        void run('save', 'configure', patch, () => setNotice(t('hint.saved')))
      }, [draft, run, t])

      /* -------------------------------------------------------- derived */

      const ready = state === 'ready'
      const perf = status?.performance
      const missingRuntime = status !== undefined && (status.binaryPath === '' || status.binaryPath === undefined)
      const selectedPath = status?.configuredModelPath ?? ''
      const runningPath = status?.runningModelPath ?? ''

      const installedPages = Math.max(1, Math.ceil(installed.length / INSTALLED_PER_PAGE))
      const safeInstalledPage = Math.min(installedPage, installedPages - 1)
      const installedSlice = installed.slice(
        safeInstalledPage * INSTALLED_PER_PAGE,
        safeInstalledPage * INSTALLED_PER_PAGE + INSTALLED_PER_PAGE,
      )

      const remotePage = hfPages[hfPage]
      const remoteRows = remotePage?.results ?? []
      const canGoNext = remotePage !== undefined && remotePage.nextCursor !== null

      return h(
        'div',
        { className: 'llm-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'llm-inner' },
          h(
            'div',
            { className: 'llm-head' },
            h(
              'div',
              { className: 'llm-head-text' },
              h('h1', { className: 'llm-title' }, t('panel.title')),
              h('p', { className: 'llm-subtitle' }, ready ? t('hint.use') : t('panel.subtitle')),
            ),
            h(
              'span',
              { className: 'llm-pill', role: 'status', title: status?.lastError ?? '' },
              h('span', { className: `llm-dot ${state}` }),
              t(`state.${KNOWN_STATES.has(state) ? state : 'idle'}`),
            ),
            h(
              'span',
              {
                className: `llm-pill llm-link ${link}`,
                role: 'status',
                title: t(LINK_LABELS[link] ?? 'badge.connecting'),
              },
              h(Icon, { name: link === 'live' ? 'pulse' : 'refresh', size: 12 }),
              t(LINK_LABELS[link] ?? 'badge.connecting'),
            ),
          ),

          error !== '' ? h('div', { className: 'llm-banner error', role: 'alert' }, error) : null,
          notice !== '' ? h('div', { className: 'llm-banner ok', role: 'status' }, notice) : null,
          ready && runningPath !== '' && selectedPath !== '' && runningPath !== selectedPath
            ? h('div', { className: 'llm-banner', role: 'status' }, t('hint.switch'))
            : null,
          downloadBanner(status?.download, t),

          /* ------------------------------------------------------- status */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.status')),
            h(
              'div',
              { className: 'llm-rows' },
              row(t('field.endpoint'), h('span', { className: 'llm-mono' }, status?.baseURL ?? '—')),
              row(
                t('field.provider'),
                h('span', { className: 'llm-mono' }, `${status?.providerId ?? '—'} / ${status?.modelId ?? '—'}`),
              ),
              row(
                t('field.uptime'),
                h('span', null, ready ? formatUptime(startedAtMs > 0 ? now - startedAtMs : status?.uptimeMs) : '—'),
              ),
              row(
                t('field.runtime'),
                h(
                  'span',
                  { className: 'llm-mono' },
                  status?.binaryPath === '' || status?.binaryPath === undefined
                    ? '—'
                    : `${status.binaryPath}${status.runtimeVariant ? ` · ${status.runtimeVariant}` : ''}`,
                ),
              ),
            ),
            h(
              'div',
              { className: 'llm-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn primary',
                  disabled: busy !== '' || ready || starting || missingRuntime || selectedPath === '',
                  onClick: () => void run('start', 'start'),
                },
                busy === 'start' || state === 'starting' ? t('state.starting') : t('action.start'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: busy !== '' || state === 'stopped' || state === 'idle',
                  onClick: () => void run('stop', 'stop'),
                },
                t('action.stop'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: busy !== '' || starting || missingRuntime || selectedPath === '',
                  onClick: () => void run('restart', 'restart'),
                },
                t('action.restart'),
              ),
            ),
            missingRuntime
              ? h(
                  React.Fragment,
                  null,
                  status?.runtimeInstalls === false
                    ? h('p', { className: 'llm-note' }, t('hint.manualRuntime'))
                    : h(
                        'div',
                        { className: 'llm-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'llm-btn',
                            disabled: busy !== '',
                            onClick: () => void run('runtime', 'downloadRuntime', { variant: 'cpu' }),
                          },
                          busy === 'runtime' ? t('download.running') : t('runtime.cpu'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'llm-btn',
                            disabled: busy !== '',
                            onClick: () => void run('runtime', 'downloadRuntime', { variant: 'vulkan' }),
                          },
                          busy === 'runtime' ? t('download.running') : t('runtime.vulkan'),
                        ),
                      ),
                  status?.runtimeInstalls === false ? null : h('p', { className: 'llm-note' }, t('hint.noRuntime')),
                  status?.runtimeInstalls === false ? null : h('p', { className: 'llm-note' }, t('hint.vulkan')),
                )
              : null,
            draft === undefined
              ? null
              : h(
                  'label',
                  { className: 'llm-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.autoStart === true,
                    onChange: (event) => setDraft({ ...draft, autoStart: event.target.checked }),
                  }),
                  h('span', { className: 'llm-value' }, t('field.autoStart')),
                ),
            draft === undefined
              ? null
              : h(
                  'label',
                  { className: 'llm-field' },
                  h('span', { className: 'llm-label' }, t('field.binaryPath')),
                  h('input', {
                    className: 'llm-input',
                    type: 'text',
                    spellCheck: false,
                    value: draft.binaryPath,
                    placeholder: status?.binaryPath ?? 'C:\\path\\to\\llama-server.exe',
                    onChange: (event) => setDraft({ ...draft, binaryPath: event.target.value }),
                  }),
                ),
          ),

          /* ------------------------------------------------ live usage */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.usage')),
            perf === undefined || status?.state !== 'ready'
              ? h('p', { className: 'llm-note' }, ready ? t('metric.pending') : t('panel.subtitle'))
              : h(
                  'div',
                  { className: 'llm-metrics' },
                  metric('cpu', t('metric.cpu'), formatPercent(perf.cpuPercent)),
                  metric(
                    'memory',
                    t('metric.ram'),
                    `${formatBytes(perf.ramUsedBytes)} / ${formatBytes(perf.ramTotalBytes)}`,
                    formatPercent(perf.ramPercent),
                  ),
                  metric(
                    'tokens',
                    t('metric.tokens'),
                    perf.metricsAvailable ? formatCount(perf.totalTokens) : '—',
                    perf.metricsAvailable
                      ? `${formatCount(perf.promptTokens)} in · ${formatCount(perf.predictedTokens)} out`
                      : undefined,
                  ),
                  metric(
                    'timer',
                    t('metric.ttft'),
                    perf.averageTtftMs > 0 ? formatMilliseconds(perf.averageTtftMs) : '—',
                    perf.lastTtftMs > 0 ? `${formatMilliseconds(perf.lastTtftMs)} last` : undefined,
                  ),
                  metric(
                    'pulse',
                    t('metric.tps'),
                    perf.metricsAvailable ? formatRate(perf.averageTokensPerSecond) : '—',
                    perf.metricsAvailable && perf.currentTokensPerSecond > 0
                      ? `${formatRate(perf.currentTokensPerSecond)} now`
                      : undefined,
                  ),
                  metric(
                    'cpu',
                    t('metric.tools'),
                    perf.lastOfferedTools > 0 ? formatCount(perf.lastOfferedTools) : '—',
                    perf.lastDroppedTools > 0 ? `${formatCount(perf.lastDroppedTools)} trimmed` : undefined,
                  ),
                  metric(
                    'layers',
                    t('metric.cached'),
                    perf.metricsAvailable ? formatCount(perf.cachedPromptTokens) : '—',
                    perf.metricsAvailable && perf.cachedPromptTokens > 0 ? 'reused, not re-read' : undefined,
                  ),
                  metric(
                    'dot',
                    t('metric.active'),
                    formatCount(perf.activeCalls),
                    perf.requestsDeferred > 0
                      ? `${formatCount(perf.requestsDeferred)} ${t('metric.deferred').toLowerCase()}`
                      : perf.completedCalls > 0
                        ? `${formatCount(perf.completedCalls)} done`
                        : undefined,
                  ),
                ),
          ),

          /* ------------------------------------------------------ library */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.library')),

            h('div', { className: 'llm-subhead' }, h('span', { className: 'llm-subhead-title' }, t('library.installed'))),
            installed.length === 0
              ? h('p', { className: 'llm-note' }, t('library.empty'))
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'llm-cards' },
                    ...installedSlice.map((entry) => {
                      const live = runningPath === entry.path
                      const picked = !live && selectedPath === entry.path
                      return h(
                        'div',
                        { className: `llm-tile${live ? ' live' : picked ? ' picked' : ''}`, key: entry.path },
                        h('span', { className: 'llm-tile-name', title: entry.path }, entry.name),
                        h(
                          'span',
                          { className: 'llm-tile-meta' },
                          h(
                            'span',
                            { className: 'llm-badges' },
                            live ? iconBadge('dot', t('badge.inUse'), 'on') : null,
                            picked ? iconBadge('check', t('badge.selected'), 'pick') : null,
                            iconBadge('layers', formatBytes(entry.bytes)),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'llm-tile-foot' },
                          iconButton({
                            name: picked || live ? 'check' : 'play',
                            label: picked || live ? t('action.selected') : t('action.use'),
                            className: 'llm-btn small icon',
                            disabled: busy !== '' || picked || live,
                            onClick: () => useModel(entry.path),
                          }),
                          iconButton({
                            name: 'trash',
                            label: `${t('action.remove')} ${entry.name}`,
                            title: live ? t('hint.switch') : `${t('action.remove')} ${entry.name}`,
                            className: 'llm-btn small icon danger',
                            disabled: busy !== '' || live,
                            onClick: () => removeModel(entry.path),
                          }),
                        ),
                      )
                    }),
                  ),
                  h(Pager, {
                    page: safeInstalledPage,
                    perPage: INSTALLED_PER_PAGE,
                    total: installed.length,
                    label: t,
                    disabled: busy !== '',
                    onChange: setInstalledPage,
                  }),
                ),

            h('div', { className: 'llm-subhead' }, h('span', { className: 'llm-subhead-title' }, t('library.manual'))),
            h(
              'div',
              { className: 'llm-search' },
              h('input', {
                className: 'llm-input',
                type: 'text',
                spellCheck: false,
                value: manualPath,
                placeholder: t('library.manualPlaceholder'),
                'aria-label': t('library.manual'),
                onChange: (event) => setManualPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') useManualPath()
                },
              }),
              iconButton({
                name: 'check',
                label: t('action.use'),
                className: 'llm-btn icon',
                disabled: busy !== '' || manualPath.trim() === '',
                onClick: useManualPath,
              }),
            ),

            h('div', { className: 'llm-subhead' }, h('span', { className: 'llm-subhead-title' }, t('library.remote'))),
            h(
              'div',
              { className: 'llm-search' },
              h('input', {
                className: 'llm-input',
                type: 'search',
                spellCheck: false,
                value: hfQuery,
                placeholder: t('library.searchPlaceholder'),
                'aria-label': t('library.searchPlaceholder'),
                onChange: (event) => setHfQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void startSearch()
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: hfBusy !== '' || busy !== '',
                  onClick: () => void startSearch(),
                },
                hfBusy === 'search' ? t('library.searching') : t('library.search'),
              ),
            ),
            hfError !== '' ? h('div', { className: 'llm-banner error', role: 'alert' }, hfError) : null,
            hfTokenConfigured ? null : h('p', { className: 'llm-note' }, t('library.noToken')),

            remotePage === undefined
              ? h('p', { className: 'llm-note' }, t('library.browseHint'))
              : remoteRows.length === 0
                ? h('p', { className: 'llm-note' }, t('library.noResults'))
                : h(
                    'div',
                    { className: 'llm-cards' },
                    ...remoteRows.map((repo) =>
                      h(
                        'div',
                        { className: 'llm-tile', key: repo.id },
                        h('span', { className: 'llm-tile-name', title: repo.id }, repo.id),
                        h(
                          'span',
                          { className: 'llm-tile-meta' },
                          h(
                            'span',
                            { className: 'llm-badges' },
                            repo.gated ? iconBadge('lock', t('badge.gated')) : null,
                            iconBadge('download', `${repo.downloads.toLocaleString()} ${t('library.downloads')}`),
                            iconBadge('star', `${repo.likes.toLocaleString()} ${t('library.likes')}`),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'llm-tile-foot' },
                          iconButton({
                            name: hfOpenRepo === repo.id ? 'close' : 'folder',
                            label: hfOpenRepo === repo.id ? t('library.close') : t('library.files'),
                            className: 'llm-btn small icon',
                            disabled: hfBusy !== '' || busy !== '',
                            onClick: () => void openRepo(repo.id),
                          }),
                        ),
                      ),
                    ),
                  ),
            remotePage === undefined
              ? null
              : h(
                  React.Fragment,
                  null,
                  h(Pager, {
                    page: hfPage,
                    perPage: REMOTE_PER_PAGE,
                    total: hfPage * REMOTE_PER_PAGE + remoteRows.length,
                    hasMore: canGoNext,
                    label: t,
                    disabled: hfBusy !== '' || busy !== '',
                    onChange: (next) => void goToRemotePage(next),
                  }),
                  hfOpenRepo !== '' && hfListing !== undefined && hfListing.repo === hfOpenRepo
                    ? h(
                        'div',
                        { className: 'llm-builds' },
                        h(
                          'div',
                          { className: 'llm-builds-head' },
                          t('library.builds', { repo: hfListing.repo }),
                        ),
                        ...(hfListing.groups ?? []).map((group) =>
                          h(
                            'div',
                            { className: 'llm-build', key: group.id },
                            h('span', { className: 'llm-build-name' }, group.label),
                            group.recommended ? iconBadge('star', t('badge.recommended'), 'pick') : null,
                            group.split ? iconBadge('layers', t('badge.split', { count: group.files.length })) : null,
                            h('span', { className: 'llm-tile-meta' }, formatBytes(group.bytes)),
                            iconButton({
                              name: 'download',
                              label: `${t('action.download')} ${group.label}`,
                              className: 'llm-btn small icon',
                              disabled: busy !== '',
                              onClick: () => downloadGroup(hfListing.repo, group),
                            }),
                          ),
                        ),
                        hfListing.groups.length === 0
                          ? h('div', { className: 'llm-build' }, h('span', { className: 'llm-note' }, t('library.noResults')))
                          : null,
                      )
                    : null,
                ),

            h(
              'div',
              { className: 'llm-search' },
              h('input', {
                className: 'llm-input',
                type: 'text',
                spellCheck: false,
                value: hfDirect,
                placeholder: t('library.directPlaceholder'),
                'aria-label': t('library.direct'),
                onChange: (event) => setHfDirect(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') downloadDirect()
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: busy !== '' || hfBusy !== '' || hfDirect.trim() === '',
                  onClick: downloadDirect,
                },
                t('action.download'),
              ),
            ),
            h('p', { className: 'llm-note' }, t('library.direct')),
          ),

          /* -------------------------------------------------- performance */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.performance')),
            draft === undefined
              ? null
              : h(
                  'div',
                  { className: 'llm-grid' },
                  numberField(t('field.port'), draft.port, (value) => setDraft({ ...draft, port: value })),
                  numberField(t('field.context'), draft.contextSize, (value) => setDraft({ ...draft, contextSize: value })),
                  numberField(t('field.threads'), draft.threads, (value) => setDraft({ ...draft, threads: value })),
                  numberField(t('field.gpuLayers'), draft.gpuLayers, (value) => setDraft({ ...draft, gpuLayers: value })),
                ),
            draft === undefined
              ? null
              : h(
                  'label',
                  { className: 'llm-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.thinking === true,
                    onChange: (event) => setDraft({ ...draft, thinking: event.target.checked }),
                  }),
                  h('span', { className: 'llm-value' }, t('field.thinking')),
                ),
            h('p', { className: 'llm-note' }, t('hint.thinking')),
            draft === undefined
              ? null
              : h(
                  'div',
                  { className: 'llm-grid' },
                  h(
                    'label',
                    { className: 'llm-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.limitTools !== false,
                      onChange: (event) => setDraft({ ...draft, limitTools: event.target.checked }),
                    }),
                    h('span', { className: 'llm-value' }, t('field.limitTools')),
                  ),
                  numberField(t('field.toolBudget'), draft.maxToolTokens, (value) =>
                    setDraft({ ...draft, maxToolTokens: value }),
                  ),
                ),
            h('p', { className: 'llm-note' }, t('hint.limitTools')),
            draft === undefined
              ? null
              : h(
                  'label',
                  { className: 'llm-field' },
                  h('span', { className: 'llm-label' }, t('field.excludeTools')),
                  h('input', {
                    className: 'llm-input',
                    type: 'text',
                    spellCheck: false,
                    value: draft.excludeTools,
                    placeholder: 'mcp__rea__, mcp__',
                    onChange: (event) => setDraft({ ...draft, excludeTools: event.target.value }),
                  }),
                ),
            draft === undefined
              ? null
              : h(
                  'label',
                  { className: 'llm-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.cacheToDisk !== false,
                    onChange: (event) => setDraft({ ...draft, cacheToDisk: event.target.checked }),
                  }),
                  h('span', { className: 'llm-value' }, t('field.cache')),
                ),
            h('p', { className: 'llm-note' }, t('hint.cache')),
            status?.cache?.path !== undefined && status.cache.path !== ''
              ? h(
                  'p',
                  { className: 'llm-note' },
                  t('hint.cacheFile', {
                    name: status.cache.path.split(/[\\/]/u).pop(),
                    size: status.cache.bytes > 0 ? formatBytes(status.cache.bytes) : '—',
                  }),
                )
              : null,
            h(
              'div',
              { className: 'llm-actions' },
              h('button', { type: 'button', className: 'llm-btn', disabled: busy !== '', onClick: save }, t('action.save')),
            ),
            h('p', { className: 'llm-note' }, t('hint.saved')),
            status?.contextClampedFrom > 0
              ? h(
                  'p',
                  { className: 'llm-banner', role: 'status' },
                  t('hint.contextClamped', { from: status.contextClampedFrom, to: status.contextClampedTo }),
                )
              : null,
            status?.contextSize > 0
              ? h(
                  'p',
                  { className: 'llm-note' },
                  t('hint.contextNow', {
                    context: status.contextSize,
                    cap: status.maxOutputTokens,
                  }),
                )
              : null,
            draft !== undefined && Number(draft.contextSize) < 8192
              ? h('p', { className: 'llm-note' }, t('hint.context'))
              : null,
          ),

          /* --------------------------------------------------------- test */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.test')),
            h('input', {
              className: 'llm-input',
              type: 'text',
              value: testPrompt,
              'aria-label': t('section.test'),
              onChange: (event) => setTestPrompt(event.target.value),
              placeholder: EN['prompt.default'],
            }),
            h(
              'div',
              { className: 'llm-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: busy !== '' || !ready,
                  onClick: () =>
                    void run('test', 'test', { prompt: testPrompt }, (value) => {
                      const text = String(value?.text ?? '')
                      setTestResult({ text, failed: value?.finish !== 'stop' || text.trim() === '' })
                    }),
                },
                busy === 'test' ? t('busy.loading') : t('action.test'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'llm-btn',
                  disabled: busy !== '' || !ready,
                  onClick: () =>
                    void run('verify', 'verifyProvider', { prompt: testPrompt }, (value) => {
                      const text = String(value?.text ?? '')
                      setTestResult({
                        text: `${value?.provider ?? '—'} / ${value?.model ?? '—'} · ${value?.finish ?? 'unknown'}\n${text}`,
                        failed: value?.finish !== 'stop' || text.trim() === '',
                      })
                    }),
                },
                busy === 'verify' ? t('busy.loading') : t('action.verify'),
              ),
            ),
            testResult !== undefined
              ? h('p', { className: `llm-test-out${testResult.failed ? ' error' : ''}`, role: 'status' }, testResult.text)
              : null,
            h('p', { className: 'llm-note' }, t('hint.verify')),
          ),

          /* --------------------------------------------------------- logs */
          h(
            'section',
            { className: 'llm-card' },
            h('h2', { className: 'llm-card-title' }, t('section.logs')),
            h(
              'pre',
              { className: 'llm-logs', role: 'log' },
              Array.isArray(status?.logs) && status.logs.length > 0 ? status.logs.join('\n') : t('empty.logs'),
            ),
          ),
        ),
      )
    }

    function downloadBanner(download, t) {
      if (download === undefined || download === null) return null
      const received = Number(download.received ?? 0)
      const total = Number(download.total ?? 0)
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined
      const label =
        download.label === 'unpacking'
          ? t('download.unpacking')
          : `${t('download.running')}${download.label === 'model' || download.label === 'runtime' ? '' : ` ${download.label}`} · ${
              percent === undefined ? formatBytes(received) : `${percent}%`
            }`
      return h('div', { className: 'llm-banner', role: 'status' }, label)
    }

    function row(key, value) {
      return h(
        React.Fragment,
        { key },
        h('span', { className: 'llm-key' }, key),
        h('span', { className: 'llm-value' }, value),
      )
    }

    /** One live counter: icon, name, value, and an optional second line. */
    function metric(icon, label, value, detail) {
      return h(
        'div',
        { className: 'llm-metric', key: label },
        h('span', { className: 'llm-metric-label' }, h(Icon, { name: icon, size: 13 }), h('span', null, label)),
        h('span', { className: 'llm-metric-value' }, value),
        detail === undefined || detail === '' ? null : h('span', { className: 'llm-metric-detail' }, detail),
      )
    }

    function numberField(label, value, onChange) {
      return h(
        'label',
        { className: 'llm-field', key: label },
        h('span', { className: 'llm-label' }, label),
        h('input', {
          className: 'llm-input',
          type: 'number',
          inputMode: 'numeric',
          min: 0,
          value,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    /* The panel is root-scoped, so the package Context is the only source of
       host services; keep a module-level handle so the component can bind locale. */
    let panelContext
    function usePanelContext() {
      return panelContext
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        panelContext = ctx
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => makeTranslator(ctx)('panel.title') },
            LocalModelIcon,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LocalModelPanel))
      },
    }
  },
})
