import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexCandidates, resolveCodex } from '../index.js'

// Virtual filesystem: Windows tests never consult the host filesystem or spawn.
function fixture({ platform = 'win32', arch = 'x64', env = {}, home = 'C:\\Users\\fixture', files = [], dirs = {}, denied = [] } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const key = (v) => platform === 'win32' ? p.normalize(v).toLowerCase() : p.normalize(v)
  const entries = new Map(files.map((f) => [key(typeof f === 'string' ? f : f.path), typeof f === 'string' ? {} : f]))
  const listings = new Map(Object.entries(dirs).map(([name, values]) => [key(name), values]))
  const probes = [], reads = []
  const options = { platform, arch, env, home, fs: {
    statSync(file) {
      probes.push(file)
      const value = entries.get(key(file))
      if (!value) throw new Error('fixture missing')
      return { isFile: () => !value.directory, size: value.size ?? 10 }
    },
    accessSync(file) { if (denied.map(key).includes(key(file))) throw new Error('fixture denied') },
    readdirSync(root) {
      reads.push(root)
      if (!listings.has(key(root))) throw new Error('fixture directory missing')
      return listings.get(key(root)).map((name) => ({ name, isDirectory: () => true }))
    },
  } }
  return { options, probes, reads, resolve: () => resolveCodex(options) }
}

const winHome = 'C:\\Users\\fixture'
const daemon = winHome + '\\.codex\\packages\\app-server-daemon'
const vendor = 'node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'

test('explicit native override wins and shell metacharacters remain literal filename', () => {
  const override = 'C:\\tools & data\\codex.exe'
  const f = fixture({ env: { GPT_NIANG_CODEX_PATH: '"' + override + '"' }, files: [override, daemon + '\\current\\bin\\codex.exe'] })
  assert.equal(f.resolve(), override)
  assert.deepEqual(f.probes, [override])
})

test('explicit .cmd resolves fixed native vendor; shim is never returned', () => {
  const prefix = 'C:\\npm & harmless'
  const native = prefix + '\\' + vendor
  const f = fixture({ env: { GPT_NIANG_CODEX_PATH: prefix + '\\codex.cmd' }, files: [prefix + '\\codex.cmd', native] })
  assert.equal(f.resolve(), native)
  assert.ok(f.probes.every((file) => file.endsWith('.exe')))
})

test('unresolved .cmd/.bat/.ps1 overrides are skipped, never executed', () => {
  for (const ext of ['cmd', 'bat', 'ps1']) {
    const file = `C:\\only\\codex.${ext}`
    assert.equal(fixture({ env: { GPT_NIANG_CODEX_PATH: file }, files: [file] }).resolve(), null)
  }
})

test('Windows PATH is case-insensitive and supports quotes and spaces', () => {
  const native = 'D:\\Node Tools\\' + vendor
  const f = fixture({ env: { Path: '"D:\\Node Tools";.;relative;;' }, files: [native] })
  assert.equal(f.resolve(), native)
  assert.ok(codexCandidates(f.options).every((file) => path.win32.isAbsolute(file)))
})

test('Windows APPDATA and LOCALAPPDATA npm global layouts', () => {
  for (const variable of ['APPDATA', 'LOCALAPPDATA']) {
    const prefix = 'D:\\profile\\' + variable + '\\npm'
    const native = prefix + '\\' + vendor
    assert.equal(fixture({ env: { [variable]: 'D:\\profile\\' + variable }, files: [native] }).resolve(), native)
  }
})

test('new npm optional native package layouts, nested and hoisted, and arm64', () => {
  for (const base of ['node_modules\\@openai\\codex\\node_modules', 'node_modules']) {
    const native = `D:\\npm\\${base}\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\codex\\codex.exe`
    assert.equal(fixture({ arch: 'arm64', env: { npm_config_prefix: 'D:\\npm' }, files: [native] }).resolve(), native)
  }
})

test('daemon current then numerically newest compatible release, root or bin layout', () => {
  const releaseRoot = daemon + '\\releases'
  const newest = releaseRoot + '\\0.100.0-x86_64-pc-windows-msvc\\codex.exe'
  const older = releaseRoot + '\\0.99.0-x86_64-pc-windows-msvc\\bin\\codex.exe'
  const dirs = { [releaseRoot]: ['0.99.0-x86_64-pc-windows-msvc', '0.100.0-x86_64-pc-windows-msvc', '9.0.0-aarch64-apple-darwin'] }
  assert.equal(fixture({ files: [older, newest], dirs }).resolve(), newest)
  const current = daemon + '\\current\\bin\\codex.exe'
  assert.equal(fixture({ files: [older, newest, current], dirs }).resolve(), current)
})

test('Store scans only immediate matching package names and fixed layouts', () => {
  const root = 'D:\\Program Files\\WindowsApps'
  const newest = root + '\\OpenAI.Codex_26.10.0.0_x64__fixture\\app\\resources\\codex.exe'
  const old = root + '\\OpenAI.Codex_26.9.0.0_x64__fixture\\app\\resources\\codex.exe'
  const f = fixture({ env: { ProgramFiles: 'D:\\Program Files' }, files: [old, newest], dirs: {
    [root]: ['Other.App_99', 'OpenAI.Codex_26.9.0.0_x64__fixture', 'OpenAI.Codex_26.10.0.0_x64__fixture'],
  } })
  assert.equal(f.resolve(), newest)
  assert.ok(f.probes.every((file) => !file.includes('Other.App')))
  assert.ok(f.reads.every((dir) => dir === daemon + '\\releases' || dir === root))
})

test('Store aliases are skipped and foreign package architectures are excluded', () => {
  const root = 'D:\\profile\\Microsoft\\WindowsApps'
  const alias = root + '\\codex.exe'
  const native = root + '\\OpenAI.Codex_2_x64__fixture\\app\\resources\\codex.exe'
  const foreign = root + '\\OpenAI.Codex_3_arm64__fixture\\app\\resources\\codex.exe'
  const f = fixture({ env: { PATH: root, LOCALAPPDATA: 'D:\\profile' }, files: [alias, native, foreign], dirs: {
    [root]: ['OpenAI.Codex_2_x64__fixture', 'OpenAI.Codex_3_arm64__fixture'],
  } })
  assert.equal(f.resolve(), native)
  assert.ok(!f.probes.includes(alias))
  assert.ok(!f.probes.includes(foreign))
})

test('bounded Store and daemon probing, missing and inaccessible directories are harmless', () => {
  const root = 'D:\\Program Files\\WindowsApps'
  const f = fixture({ env: { ProgramFiles: 'D:\\Program Files' }, dirs: {
    [root]: Array.from({ length: 200 }, (_, i) => `OpenAI.Codex_${i}_x64__fixture`),
    [daemon + '\\releases']: Array.from({ length: 200 }, (_, i) => `${i}.0.0-x86_64-pc-windows-msvc`),
  } })
  assert.equal(f.resolve(), null)
  assert.equal(new Set(f.probes.filter((v) => v.startsWith(root)).map((v) => v.slice(root.length + 1).split('\\')[0])).size, 64)
  assert.equal(new Set(f.probes.filter((v) => v.includes('\\releases\\')).map((v) => v.split('\\releases\\')[1].split('\\')[0])).size, 64)
})

test('Windows rejects zero-length Store aliases and directories', () => {
  const f = fixture({ env: { PATH: 'D:\\aliases;D:\\directory;D:\\native' }, files: [
    { path: 'D:\\aliases\\codex.exe', size: 0 },
    { path: 'D:\\directory\\codex.exe', directory: true }, 'D:\\native\\codex.exe',
  ] })
  assert.equal(f.resolve(), 'D:\\native\\codex.exe')
})

test('macOS daemon, PATH, Homebrew and both application roots', () => {
  const home = '/Users/fixture'
  const candidates = ['/Users/fixture/.codex/packages/app-server-daemon/current/bin/codex', '/tools/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/Resources/codex', home + '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']
  for (const native of candidates) {
    assert.equal(fixture({ platform: 'darwin', home, env: { PATH: '/tools' }, files: [native] }).resolve(), native)
  }
})

test('POSIX skips non-executable candidates and resolves Linux user native paths', () => {
  const f = fixture({ platform: 'linux', home: '/home/fixture', env: { GPT_NIANG_CODEX_PATH: '/bad/codex' }, files: ['/bad/codex', '/home/fixture/.local/bin/codex'], denied: ['/bad/codex'] })
  assert.equal(f.resolve(), '/home/fixture/.local/bin/codex')
})

test('relative overrides, cwd PATH entries and duplicate paths are excluded', () => {
  const f = fixture({ env: { GPT_NIANG_CODEX_PATH: 'codex.exe', PATH: '.;tools;C:\\tools;c:\\TOOLS;' } })
  const candidates = codexCandidates(f.options)
  assert.equal(candidates.filter((v) => v.toLowerCase() === 'c:\\tools\\codex.exe').length, 1)
  assert.ok(candidates.every((v) => path.win32.isAbsolute(v)))
})

test('real temp POSIX fixture validates file mode without launching any executable', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'))
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-discovery-')))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exe = path.join(root, 'codex')
  fs.writeFileSync(exe, 'fixture only; never execute\n', { mode: 0o600 })
  const options = { platform: 'linux', home: root, env: { GPT_NIANG_CODEX_PATH: exe } }
  // Avoid any host fallback: inject stat/access for this exact temporary file only.
  options.fs = {
    statSync(file) { if (file !== exe) throw new Error('outside fixture'); return fs.statSync(file) },
    accessSync: fs.accessSync,
    readdirSync() { return [] },
  }
  assert.equal(resolveCodex(options), null)
  fs.chmodSync(exe, 0o700)
  assert.equal(resolveCodex(options), exe)
})
