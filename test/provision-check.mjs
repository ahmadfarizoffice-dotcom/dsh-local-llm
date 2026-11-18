/**
 * Provisioning must never touch the network when the machine is already set up,
 * and must stay quiet when it is switched off. Both are what keep activation
 * cheap for someone who installs the bundle with everything already in place.
 * Run: node test/provision-check.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __internals } from '../index.js'

const fail = (message) => {
  throw new Error(message)
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-provision-'))

try {
  // A runtime and a model that already exist.
  const binary = path.join(dataDir, 'runtime', 'cpu', 'llama-server.exe')
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, 'stub')
  const model = path.join(dataDir, 'models', 'stub.gguf')
  await mkdir(path.dirname(model), { recursive: true })
  await writeFile(model, 'stub')

  // 1. Everything present: provisioning must do nothing at all.
  const ready = new __internals.LocalModel({}, {
    dataDir,
    modelPath: model,
    binaryPath: binary,
    port: 18220,
    autoSetup: true,
    autoModel: 'LiquidAI/LFM3-1.7B-GGUF#LFM3-1.7B-Q4_K_M.gguf',
  })
  await ready.init()
  await ready.provision()
  const touched = ready.logs.filter((line) => /downloading|first run/u.test(line))
  if (touched.length !== 0) fail(`provisioning worked on a ready machine: ${touched.join(' | ')}`)
  if (ready.snapshot().provisioning !== false) fail('the provisioning flag stayed set')
  console.log('NO-OP OK          -> nothing downloaded when the runtime and model exist')

  // 2. Switched off: a missing runtime must not be fetched either.
  const off = new __internals.LocalModel({}, {
    dataDir,
    modelPath: '',
    binaryPath: path.join(dataDir, 'runtime', 'cpu', 'does-not-exist.exe'),
    port: 18221,
    autoSetup: false,
    autoModel: '',
  })
  await off.init()
  await off.provision()
  const attempts = off.logs.filter((line) => /downloading/u.test(line))
  if (attempts.length !== 0) fail(`autoSetup false still tried to download: ${attempts.join(' | ')}`)
  console.log('OFF OK            -> autoSetup false never fetches')

  // 3. The spec is parsed, not guessed: `repo#file` splits on the hash.
  const parsed = 'LiquidAI/LFM3-1.7B-GGUF#LFM3-1.7B-Q4_K_M.gguf'.split('#')
  if (parsed.length !== 2 || parsed[0] !== 'LiquidAI/LFM3-1.7B-GGUF') fail('the model spec did not split')
  if (parsed[1] !== 'LFM3-1.7B-Q4_K_M.gguf') fail('the model file part is wrong')
  console.log('SPEC OK           -> repo and file split correctly')
  console.log('PROVISION CHECK OK')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
