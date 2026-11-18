/**
 * Offline check of the Hugging Face browse and download paths.
 * Uses the public API for search and listing, and a loopback server for the
 * resumable-download mechanics so no large file is fetched.
 * Run: node test/hf-check.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const fail = (message) => {
  throw new Error(message)
}

/* ---------------------------------------------------- split-file grouping */

const grouped = __internals.groupGgufFiles([
  'model-Q4_K_M.gguf',
  'big-00002-of-00003.gguf',
  'README.md',
  'big-00001-of-00003.gguf',
  'big-00003-of-00003.gguf',
])
const single = grouped.find((group) => group.id === 'model-Q4_K_M.gguf')
const split = grouped.find((group) => group.id === 'big')
if (single === undefined) fail('a plain .gguf file must become its own entry')
if (single.split) fail('a plain .gguf file must not be marked as split')
if (split === undefined) fail('split shards must collapse into one entry')
if (split.files.length !== 3) fail(`expected 3 shards, got ${split.files.length}`)
if (split.files.map((file) => file.index).join(',') !== '1,2,3') fail('shards must be ordered by index')
if (grouped.some((group) => group.label.includes('README'))) fail('non-GGUF files must be ignored')
console.log('GROUPING CHECK OK  ->', grouped.map((group) => group.label).join(' | '))

/* ------------------------------------------------------- resumable download */

const payload = Buffer.alloc(256 * 1024)
for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251

let rangeRequests = 0
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-$/u.exec(req.headers.range ?? '')
  if (range === null) {
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
    return
  }
  const start = Number(range[1])
  if (start >= payload.length) {
    res.writeHead(416, { 'content-range': `bytes */${payload.length}` })
    res.end()
    return
  }
  rangeRequests += 1
  res.writeHead(206, {
    'content-length': String(payload.length - start),
    'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
  })
  res.end(payload.subarray(start))
})

const scratch = await mkdtemp(path.join(os.tmpdir(), 'dsh-hf-check-'))
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  // Fresh download.
  const whole = path.join(scratch, 'whole.bin')
  const wholeBytes = await __internals.downloadToFile(`${base}/file`, whole, undefined, { expected: payload.length })
  if (wholeBytes !== payload.length) fail(`fresh download wrote ${wholeBytes} of ${payload.length}`)
  if (!(await readFile(whole)).equals(payload)) fail('fresh download corrupted the payload')
  console.log('DOWNLOAD CHECK OK  ->', wholeBytes, 'bytes')

  // Interrupted download resumes from the partial file.
  const resumed = path.join(scratch, 'resumed.bin')
  await writeFile(`${resumed}.part`, payload.subarray(0, 100_000))
  const resumedBytes = await __internals.downloadToFile(`${base}/file`, resumed, undefined, {
    expected: payload.length,
  })
  if (rangeRequests !== 1) fail(`expected one range request, saw ${rangeRequests}`)
  if (resumedBytes !== payload.length) fail(`resume wrote ${resumedBytes} of ${payload.length}`)
  if (!(await readFile(resumed)).equals(payload)) fail('resume corrupted the payload')
  console.log('RESUME CHECK OK    ->', rangeRequests, 'range request,', resumedBytes, 'bytes')

  // A complete partial file needs no request at all.
  const done = path.join(scratch, 'done.bin')
  await writeFile(`${done}.part`, payload)
  rangeRequests = 0
  const doneBytes = await __internals.downloadToFile(`${base}/file`, done, undefined, { expected: payload.length })
  if (rangeRequests !== 0) fail('a complete partial file must not issue a request')
  if (doneBytes !== payload.length) fail('a complete partial file must be finalized in place')
  console.log('FINALIZE CHECK OK  -> no request issued')
} finally {
  server.close()
  await rm(scratch, { recursive: true, force: true })
}

/* ------------------------------------------------------------- live lookups */

const firstPage = await __internals.searchRepos('LFM3', 5)
if (firstPage.results.length === 0) fail('search returned nothing for LFM3')
if (!firstPage.results.every((entry) => entry.id.includes('/'))) fail('search results must be org/repo ids')
console.log('SEARCH CHECK OK    ->', firstPage.results.map((entry) => entry.id).join(', '))

if (typeof firstPage.nextCursor !== 'string' || firstPage.nextCursor === '') {
  fail('a full first page must publish a forward cursor')
}
const secondPage = await __internals.searchRepos('LFM3', 5, firstPage.nextCursor)
if (secondPage.results.length === 0) fail('the second page came back empty')
const overlap = secondPage.results.filter((entry) => firstPage.results.some((first) => first.id === entry.id))
if (overlap.length > 0) fail(`the second page repeated ${overlap.map((entry) => entry.id).join(', ')}`)
console.log('CURSOR CHECK OK    -> page 2 starts at', secondPage.results[0].id)

const listing = await __internals.listRepoFiles('LiquidAI/LFM3-1.7B-GGUF')
if (listing.groups.length === 0) fail('the LFM3 GGUF repository listed no models')
const q4 = listing.groups.find((group) => /q4_k_m/iu.test(group.label))
if (q4 === undefined) fail('the Q4_K_M build is missing from the listing')
if (!(q4.bytes > 100 * 1024 * 1024)) fail(`expected a plausible Q4_K_M size, got ${q4.bytes}`)
console.log('LISTING CHECK OK   ->', listing.groups.map((group) => `${group.label} (${Math.round(group.bytes / 1e6)}MB)`).join(', '))

let refused = ''
try {
  await __internals.listRepoFiles('LiquidAI/this-repository-does-not-exist-xyz')
} catch (error) {
  refused = error.message
}
if (refused === '') fail('a missing repository must fail loudly')
console.log('MISSING REPO OK    ->', refused)

const resolved = __internals.parseHuggingFaceTarget('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q4_K_M.gguf')
if (!resolved.startsWith('https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/main/')) {
  fail(`unexpected resolve address: ${resolved}`)
}
const head = await fetch(resolved, { method: 'HEAD', redirect: 'follow' })
if (!head.ok) fail(`the resolve address answered HTTP ${head.status}`)
console.log('RESOLVE OK         ->', resolved, '·', Math.round(Number(head.headers.get('content-length') ?? 0) / 1e6), 'MB')

/* --------------------------------------------- real download of a split set */

// A tiny split model so the whole browse-to-file path runs for real, offline of
// any large transfer: three shards that must land together and become the model.
const tinyRepo = 'ggml-org/models'
const scratchDownload = await mkdtemp(path.join(os.tmpdir(), 'dsh-hf-dl-'))
try {
  const tinyListing = await __internals.listRepoFiles(tinyRepo)
  const split = tinyListing.groups.find((group) => /^tinyllamas\/split\/stories15M$/u.test(group.id))
  if (split === undefined) fail('the tiny split fixture is missing from ggml-org/models')
  if (split.files.length !== 3) fail(`expected a 3-part split fixture, got ${split.files.length}`)

  const saved = []
  const fakeManager = {
    paths: { modelsDir: scratchDownload },
    log: () => {},
    setDownload: () => {},
    saveSettings: async (patch) => {
      saved.push(patch)
      return patch
    },
    snapshot: () => ({ state: 'stopped' }),
  }
  await __internals.downloadModelGroup(fakeManager, tinyRepo, split)

  const landed = []
  for (const file of split.files) landed.push(path.basename(file.path))
  const present = []
  for (const name of landed) present.push(await readFile(path.join(scratchDownload, name)).then(() => name).catch(() => fail(`missing shard ${name}`)))
  if (present.length !== 3) fail('a split download must write every shard')
  if (saved.length !== 1) fail('a finished download must record exactly one model selection')
  if (path.basename(saved[0].modelPath) !== landed[0]) fail('the recorded model must be the first shard')
  console.log('SPLIT DOWNLOAD OK  ->', present.join(', '), '-> selected', path.basename(saved[0].modelPath))
} finally {
  await rm(scratchDownload, { recursive: true, force: true })
}

/* ------------------------------------------------ removal and the landing */

const scratchRemove = await mkdtemp(path.join(os.tmpdir(), 'dsh-hf-remove-'))
try {
  const keep = path.join(scratchRemove, 'keep.gguf')
  const drop = path.join(scratchRemove, 'drop.gguf')
  const partial = `${drop}.part`
  await writeFile(keep, 'keep')
  await writeFile(drop, 'drop')
  await writeFile(partial, 'partial')

  const removals = []
  const fakeManager = {
    paths: { modelsDir: scratchRemove },
    runningModelPath: undefined,
    modelPath: () => drop,
    saveSettings: async (patch) => {
      removals.push(patch)
      return patch
    },
    snapshot: () => ({ state: 'stopped' }),
  }

  const outcome = await __internals.removeModelFile(fakeManager, drop)
  if (outcome.models.some((entry) => entry.name === 'drop.gguf')) fail('the removed model is still listed')
  if (!outcome.models.some((entry) => entry.name === 'keep.gguf')) fail('removal took an unrelated model with it')
  if (removals.length !== 1 || removals[0].modelPath !== '') fail('removing the selected model must clear the selection')
  if (await readFile(partial).then(() => true).catch(() => false)) fail('the partial file must be removed with its model')
  console.log('REMOVE CHECK OK    -> removed drop.gguf and its .part, kept keep.gguf')

  let escaped = ''
  try {
    await __internals.removeModelFile(fakeManager, path.join(scratchRemove, '..', 'outside.gguf'))
  } catch (error) {
    escaped = error.message
  }
  if (escaped === '') fail('removal must refuse a path outside the models folder')
  console.log('REMOVE GUARD OK    ->', escaped)

  fakeManager.runningModelPath = keep
  let locked = ''
  try {
    await __internals.removeModelFile(fakeManager, keep)
  } catch (error) {
    locked = error.message
  }
  if (locked === '') fail('removal must refuse the file the running server serves')
  console.log('REMOVE LOCK OK     ->', locked)
} finally {
  await rm(scratchRemove, { recursive: true, force: true })
}

const popular = await __internals.searchRepos('', 3)
if (popular.results.length !== 3) fail('an empty query must still list popular GGUF repositories')
console.log('LANDING CHECK OK   ->', popular.results.map((entry) => entry.id).join(', '))

if (!listing.groups.some((group) => group.recommended)) fail('a Q4_K_M build must be marked as the recommended pick')
console.log(
  'RECOMMEND OK       ->',
  listing.groups.filter((group) => group.recommended).map((group) => group.label).join(', '),
)

/* ------------------------------------------------------- runtime builds */

for (const [variant, build] of Object.entries(__internals.RUNTIME_VARIANTS)) {
  const head = await fetch(build.url, { method: 'HEAD', redirect: 'follow' })
  if (!head.ok) fail(`the ${variant} runtime asset answered HTTP ${head.status}`)
  const bytes = Number(head.headers.get('content-length') ?? 0)
  if (!(bytes > 1_000_000)) fail(`the ${variant} runtime asset reported ${bytes} bytes`)
  console.log(`RUNTIME OK (${variant}) ->`, build.label, '·', Math.round(bytes / 1e6), 'MB')
}

console.log('HF CHECK OK')