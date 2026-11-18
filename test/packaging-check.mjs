/**
 * A byte-order mark makes package.json invalid JSON for the DSH installer, and it
 * is easy to add by accident from Windows tooling. This checks the files the
 * package actually ships, the way the installer reads them.
 * Run: node test/packaging-check.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fail = (message) => {
  throw new Error(message)
}

const BOM = '\uFEFF'

/** Files named by `files`, plus everything the manifest references. */
const shipped = () => {
  const listed = [
    'package.json',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'NOTICE.md',
    'LICENSE',
    'locale/en.json',
    'locale/id.json',
    'docs/DETAIL.md',
    'docs/preview.svg',
  ]
  if (listed.some((file) => !existsSync(path.join(root, file)))) {
    fail('a shipped file is missing from the repository')
  }
  return listed
}

// 1. No shipped file may start with a BOM.
const withBom = []
for (const file of shipped()) {
  const bytes = readFileSync(path.join(root, file))
  if (bytes.slice(0, 3).toString('hex') === 'efbbbf') withBom.push(file)
}
if (withBom.length > 0) fail(`byte-order mark found in: ${withBom.join(', ')}`)
console.log(`BOM OK            -> ${shipped().length} shipped files start with plain text`)

// 2. package.json must parse exactly as the installer parses it.
const manifestText = readFileSync(path.join(root, 'package.json'), 'utf8')
let manifest
try {
  manifest = JSON.parse(manifestText)
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`)
}
if (typeof manifest.name !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/u.test(manifest.name)) {
  fail(`package name "${manifest.name}" is not a valid package name`)
}
console.log(`MANIFEST OK       -> ${manifest.name}@${manifest.version}`)

// 3. Every path the manifest promises must exist.
const promised = [
  manifest.dsh?.bundle?.patch,
  manifest.exports?.['.'],
  manifest.exports?.['./client'],
  manifest.exports?.['./icon'],
  ...Object.keys(manifest.exports ?? {})
    .filter((key) => key.includes('*'))
    .map((key) => (key === './locale/*.json' ? './locale/en.json' : undefined))
    .filter(Boolean),
]
for (const entry of promised) {
  if (typeof entry !== 'string') continue
  if (!existsSync(path.join(root, entry))) fail(`the manifest references a missing file: ${entry}`)
}
console.log(`EXPORTS OK        -> ${promised.filter(Boolean).length} referenced paths exist`)

// 4. Locales must parse, because the panel's detail page reads them.
for (const locale of ['en', 'id']) {
  const text = readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8')
  if (text.startsWith(BOM)) fail(`locale/${locale}.json starts with a BOM`)
  const parsed = JSON.parse(text)
  if (typeof parsed.meta?.description !== 'string' || parsed.meta.description === '') {
    fail(`locale/${locale}.json has no meta.description`)
  }
}
console.log('LOCALES OK        -> both parse and carry a description')

// 5. The packed tarball must contain exactly what the repository ships.
let packed
try {
  // execSync, not execFileSync: Windows resolves npm through the shell only.
  const output = execSync('npm pack --dry-run --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  packed = JSON.parse(output)[0]
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.message}`)
}
const packedPaths = packed.files.map((entry) => entry.path).sort()
for (const file of shipped()) {
  if (!packedPaths.includes(file)) fail(`npm pack would omit ${file}`)
}
if (packedPaths.some((file) => file.startsWith('test/'))) fail('the tarball must not ship tests')
console.log(`PACK OK           -> ${packedPaths.length} files, no tests`)
console.log('PACKAGING CHECK OK')
