import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply, validateCodexPath, readDetectionBody, sameOriginWrite } from '../index.js'

const request = (body, headers = {}) => Object.assign(Readable.from([body]), {
  headers: { 'content-type': 'application/json', ...headers },
})

test('manual paths are exclusive and Windows shims resolve native binaries', () => {
  const native = 'C:\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'
  const options = { platform: 'win32', arch: 'x64', home: 'C:\\home', env: { PATH: 'C:\\auto' }, fs: {
    statSync(file) { if (file !== native && file !== 'C:\\auto\\codex.exe') throw new Error('missing'); return { isFile: () => true, size: 1 } },
    readdirSync() { throw new Error('manual resolution must not enumerate') },
  } }
  assert.equal(validateCodexPath('C:\\npm\\codex.cmd', options).cli, native)
  for (const value of ['relative', 'C:\\missing.exe', 'C:\\missing\\codex.cmd', '\0']) {
    assert.equal(validateCodexPath(value, options).ok, false)
  }
  assert.equal(validateCodexPath('', options).ok, true)
})

test('body parser enforces JSON, shape and byte limit', async () => {
  assert.equal(await readDetectionBody(request('{"path":""}')), '')
  for (const body of ['[]', '{}', '{"path":4}', '{']) {
    await assert.rejects(readDetectionBody(request(body)), { status: 400 })
  }
  await assert.rejects(readDetectionBody(request('{}', { 'content-type': 'text/plain' })), { status: 415 })
  await assert.rejects(readDetectionBody(request(' '.repeat(16385))), { status: 413 })
  await assert.rejects(readDetectionBody(request('{}', { 'content-length': '16385' })), { status: 413 })
})

test('writes enforce exact origin including scheme and null rejection', () => {
  const check = (origin) => sameOriginWrite({ headers: { host: 'localhost:51371', ...(origin === undefined ? {} : { origin }) } })
  assert.equal(check(undefined), true)
  assert.equal(check('http://localhost:51371'), true)
  for (const origin of ['null', '', 'https://localhost:51371', 'http://localhost:1234', 'http://localhost:51371/']) assert.equal(check(origin), false)
})

test('route lazily persists validated config, keeps invalid saved overrides exclusive, and resets', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-niang-manual-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  const routes = []
  const root = {
    effect() {}, on() { return () => {} },
    inject(_, callback) { callback({ webServer: { register(route) { routes.push(route); return () => {} }, tapIndex() { return () => {} } }, effect() { return () => {} } }) },
  }
  apply(root)
  const route = routes.find((r) => r.path.endsWith('/detection.json'))
  const invoke = async (method, body = '', headers = {}) => {
    const req = request(body, { host: 'localhost:51371', ...headers })
    req.method = method
    let text = ''
    const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status }, end(value = '') { text += value } }
    await route.handler(req, res)
    return { status: res.statusCode, data: text ? JSON.parse(text) : null }
  }
  try {
    const config = path.join(profile, 'plugin-state', 'gpt-niang', 'codex.json')
    assert.equal((await invoke('GET')).status, 200)
    assert.equal(fs.existsSync(config), false)
    assert.equal((await invoke('POST', '{"path":"/missing/native/codex"}')).status, 400)
    assert.equal(fs.existsSync(config), false)
    assert.equal((await invoke('POST', '{"path":""}', { origin: 'null' })).status, 403)
    assert.equal((await invoke('POST', '{"path":""}', { 'sec-fetch-site': 'cross-site' })).status, 403)
    const executable = path.join(profile, 'codex')
    fs.writeFileSync(executable, 'native fixture', { mode: 0o700 })
    const saved = await invoke('POST', JSON.stringify({ path: executable }))
    assert.equal(saved.data.detected, true)
    assert.equal(saved.data.source, 'manual')
    assert.equal(saved.data.configuredPath, executable)
    assert.equal(saved.data.binaryName, 'codex')
    assert.equal(fs.statSync(config).mode & 0o777, 0o600)
    fs.chmodSync(executable, 0o600)
    assert.equal((await invoke('GET')).data.detected, false)
    assert.equal((await invoke('GET')).data.status, 'MANUAL_PATH_INVALID')
    const reset = await invoke('POST', '{"path":""}')
    assert.equal(reset.data.configuredPath, '')
    assert.equal(reset.data.source, 'auto')
    assert.equal((await invoke('DELETE')).status, 405)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    // Fixture retained in the OS temporary directory for failure inspection.
  }
})
