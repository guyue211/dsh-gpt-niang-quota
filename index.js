/**
 * dsh-gpt-niang-quota —— Host 半区
 *
 * 职责：
 *   ① 定位 Codex CLI 可执行文件（多候选路径，覆盖官方桌面端 / 用户级安装 / PATH）
 *   ② 通过 `codex app-server --stdio` 只读地读取账户与额度（三个只读方法，不建对话、不调模型）
 *   ③ 通过 webServer 向 Client 提供只读额度与可保存的本机程序路径设置
 *   ④ 注册桌面端（Electron）结构化注入行，让 Client 半区在桌面壳里也能被加载
 *
 * 设计取舍（沿用 GPTNiangMac 与 dsh-whale-widget 已验证的做法）：
 *   · **只读**：仅发送 initialize / account/read / account/rateLimits/read，绝不发 thread 或模型调用。
 *   · **不落盘**：账户邮箱、账户 id、凭据一律不写入任何文件，也不出现在 HTTP 响应里。
 *     只把套餐标识（plus / pro / …）与额度窗口数字交给前端。
 *   · **单飞 + 缓存**：一次 in-flight，结果缓存 60 秒；客户端可带 ?refresh=1 强制刷新，但同样受单飞约束。
 *   · **fail-closed 校验**：沿用 whale 的三层栅栏思路，先做插件自带校验（回环 Host / 同源），
 *     再委托宿主 connection.requestRejection（若存在）。路径设置写接口额外严格校验 Origin。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.')
// 版本号以 package.json 为单一来源，避免两处写死漂移
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
const ROUTE_PREFIX = '/dsh-gpt-niang'
const CLIENT_SCRIPT_PATH = ROUTE_PREFIX + '/widget.js'

/**
 * 静态资源白名单。键是公开 URL，值是包内相对路径。
 * 只允许这张表里的文件经 HTTP 送出 —— 不做目录拼接，天然免疫路径穿越。
 * 公开包仅分发另行制作并明确授权的原创资源；原应用资产不随包分发。
 */
const STATIC_ASSETS = new Map([
  [ROUTE_PREFIX + '/niang.png', 'assets/niang.png'],
  [ROUTE_PREFIX + '/press.wav', 'assets/press.wav'],
  [ROUTE_PREFIX + '/release.wav', 'assets/release.wav'],
  [ROUTE_PREFIX + '/quotes.json', 'assets/quotes.json'],
])

const MIME = {
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
}

// ── 额度缓存 ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000
let cache = null          // { at, payload }
let inFlight = null       // Promise
let lastError = null

// ── Codex CLI 定位 ──────────────────────────────────────────────────────────
/**
 * Discovery only: no subprocesses, shell, shim evaluation, or account access.
 * Inject dependencies for platform fixtures; use the target OS's path semantics.
 * Only immediate daemon releases / Store package directories are enumerated;
 * at most 64 matching directories per root have their fixed layouts probed.
 */
export function codexCandidates({
  platform = process.platform, arch = process.arch, env = process.env,
  home = os.homedir(), fs: io = fs, manualPath,
} = {}) {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const out = [], seen = new Set()
  const envValue = (name) => {
    const key = Object.keys(env).find((k) => win ? k.toLowerCase() === name.toLowerCase() : k === name)
    return key ? String(env[key] || '') : ''
  }
  const clean = (value) => String(value || '').trim().replace(/^"(.*)"$/, '$1')
  const push = (value) => {
    const file = clean(value)
    // Relative PATH entries and overrides depend on the daemon's unrelated cwd.
    if (!file || file.includes('\0') || !p.isAbsolute(file)) return
    const normalized = p.normalize(file)
    const key = win ? normalized.toLowerCase() : normalized
    if (!seen.has(key)) { seen.add(key); out.push(normalized) }
  }
  const newest = (a, b) => b.localeCompare(a, 'en', { numeric: true })
  const directories = (root, matches = () => true) => {
    try {
      return io.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && matches(e.name))
        .map((e) => e.name).sort(newest).slice(0, 64)
    } catch { return [] }
  }
  const exe = win ? 'codex.exe' : 'codex'
  const nativeArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const target = nativeArch && (win ? `${nativeArch}-pc-windows-msvc`
    : platform === 'darwin' ? `${nativeArch}-apple-darwin` : `${nativeArch}-unknown-linux-musl`)
  const npmPackage = `codex-${win ? 'win32' : platform}-${arch}`
  const npmNative = (root) => {
    if (!target) return
    // Old monolithic package and current optional platform package layouts.
    for (const base of [root, p.join(root, 'node_modules', '@openai', npmPackage)]) {
      push(p.join(base, 'vendor', target, 'codex', exe))
    }
  }
  const npmPrefix = (prefix) => {
    if (!prefix || !p.isAbsolute(prefix)) return
    npmNative(p.join(prefix, 'node_modules', '@openai', 'codex'))
    npmNative(p.join(prefix, 'lib', 'node_modules', '@openai', 'codex'))
    // Some package managers hoist the optional platform package.
    if (target) {
      for (const modules of ['node_modules', p.join('lib', 'node_modules')]) {
        push(p.join(prefix, modules, '@openai', npmPackage, 'vendor', target, 'codex', exe))
      }
    }
  }
  const executableOrShim = (file) => {
    if (!file) return
    if (win && /\.(?:cmd|bat|ps1)$/i.test(file)) {
      // Never run cmd.exe or parse a user-editable shim. Resolve fixed npm layouts.
      npmPrefix(p.dirname(file))
      return
    }
    push(file)
  }

  // An explicit override is an exclusive candidate set, including npm shim resolution.
  if (manualPath !== undefined) {
    if (typeof manualPath === 'string' && !manualPath.includes('\0') && p.isAbsolute(manualPath)) {
      executableOrShim(manualPath)
    }
    return out
  }
  executableOrShim(clean(envValue('GPT_NIANG_CODEX_PATH')))
  const daemon = p.join(home, '.codex', 'packages', 'app-server-daemon')
  const daemonFiles = (root) => {
    push(p.join(root, 'bin', exe))
    push(p.join(root, exe))
  }
  daemonFiles(p.join(daemon, 'current'))
  for (const release of directories(p.join(daemon, 'releases'), (name) => {
    // Ignore known foreign architectures/OS targets, retain legacy hash names.
    return !/(?:apple-darwin|pc-windows-msvc|unknown-linux)/.test(name) || (target && name.includes(target))
  })) daemonFiles(p.join(daemon, 'releases', release))

  // The running daemon often has a reduced PATH; retain normal package-manager roots.
  for (const dir of envValue('PATH').split(win ? ';' : ':')) {
    const base = clean(dir)
    if (!p.isAbsolute(base)) continue
    // App-execution aliases can launch the GUI rather than the CLI protocol.
    if (!win || !/[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(base)) push(p.join(base, exe))
    if (win) npmPrefix(base)
  }
  if (win) {
    const local = clean(envValue('LOCALAPPDATA'))
    const roaming = clean(envValue('APPDATA'))
    for (const prefix of [roaming && p.join(roaming, 'npm'), local && p.join(local, 'npm'),
      local && p.join(local, 'Programs', 'nodejs'), clean(envValue('npm_config_prefix'))]) {
      npmPrefix(prefix)
    }
    // Store aliases may be zero-byte reparse stubs: prefer the package's native CLI.
    const storeRoots = [local && p.join(local, 'Microsoft', 'WindowsApps'),
      p.join(clean(envValue('ProgramFiles')) || 'C:\\Program Files', 'WindowsApps')]
    for (const root of storeRoots.filter(Boolean)) {
      for (const name of directories(root, (n) => /^OpenAI\.Codex_/i.test(n)
        && (!/_(?:x64|arm64|x86)_/i.test(n) || n.toLowerCase().includes(`_${arch}_`)))) {
        const pkg = p.join(root, name)
        for (const rel of ['app/resources/codex.exe', 'resources/codex.exe',
          'app/resources/codex-cli/bin/codex.exe', 'codex.exe']) push(p.join(pkg, rel))
      }
    }
  } else {
    for (const dir of [p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin'),
      p.join(home, '.npm', 'bin'), p.join(home, '.local', 'share', 'npm', 'bin'),
      p.join(home, '.volta', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
      push(p.join(dir, exe))
    }
    if (platform === 'darwin') {
      for (const app of ['/Applications/Codex.app', p.join(home, 'Applications', 'Codex.app')]) {
        for (const rel of ['codex-cli/bin/codex', 'codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex']) {
          push(p.join(app, 'Contents', 'Resources', rel))
        }
      }
    }
  }
  return out
}

export function resolveCodex(options = {}) {
  const io = options.fs || fs
  const win = (options.platform || process.platform) === 'win32'
  for (const file of codexCandidates(options)) {
    // spawn(..., { shell: false }) accepts native Windows executables, not npm shims.
    if (win && !/\.exe$/i.test(file)) continue
    try {
      const stat = io.statSync(file)
      if (!stat.isFile() || stat.size === 0) continue
      if (!win) io.accessSync(file, fs.constants.X_OK)
      return file
    } catch { /* missing, inaccessible, or non-executable: try the next fixed candidate */ }
  }
  return null
}

// ── 用户指定路径：仅显式保存时落盘，绝不保存账户数据 ──────────────────────────
const CONFIG_BODY_LIMIT = 16 * 1024
let settings = null
let configRevision = 0
const configFile = () => path.join(process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh'),
  'plugin-state', 'gpt-niang', 'codex.json')

function loadSettings() {
  if (settings) return settings
  let fd
  try {
    fd = fs.openSync(configFile(), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > CONFIG_BODY_LIMIT) throw new Error('Invalid config')
    const bytes = Buffer.alloc(CONFIG_BODY_LIMIT + 1)
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (count > CONFIG_BODY_LIMIT) throw new Error('Invalid config')
    const data = JSON.parse(bytes.subarray(0, count).toString('utf8'))
    if (!data || typeof data.path !== 'string' || data.path.includes('\0')) throw new Error('Invalid config')
    settings = { path: data.path, invalid: false }
  } catch (err) {
    // Corrupt/inaccessible configuration fails closed instead of selecting another executable.
    settings = { path: '', invalid: err?.code !== 'ENOENT' }
  } finally { if (fd !== undefined) fs.closeSync(fd) }
  return settings
}

export function validateCodexPath(value, options = {}) {
  if (typeof value !== 'string') return { ok: false, errorCode: 'INVALID_PATH' }
  const configuredPath = value.trim()
  if (!configuredPath) return { ok: true, configuredPath: '', cli: null }
  const p = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix
  if (configuredPath.includes('\0') || !p.isAbsolute(configuredPath)) return { ok: false, errorCode: 'INVALID_PATH' }
  const cli = resolveCodex({ ...options, manualPath: configuredPath })
  return cli ? { ok: true, configuredPath, cli } : { ok: false, errorCode: 'INVALID_PATH' }
}

function configuredCodex() {
  const config = loadSettings()
  return config.invalid ? null : resolveCodex(config.path ? { manualPath: config.path } : {})
}

function detectionStatus() {
  const config = loadSettings()
  const cli = configuredCodex()
  const manual = config.invalid || !!config.path
  return {
    platform: process.platform, arch: process.arch, detected: !!cli,
    configuredPath: config.path, source: manual ? 'manual' : 'auto',
    binaryName: cli ? path.basename(cli) : null,
    status: config.invalid ? 'CONFIG_ERROR' : cli ? 'FOUND' : manual ? 'MANUAL_PATH_INVALID' : 'NOT_FOUND',
  }
}

function saveSettings(configuredPath) {
  const file = configFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify({ path: configuredPath }) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* already renamed or never created */ }
  }
  settings = { path: configuredPath, invalid: false }
  configRevision++
  cache = null
  lastError = null
  inFlight = null
}

export async function readDetectionBody(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(String(req.headers?.['content-type'] || ''))) {
    throw Object.assign(new Error('JSON content required'), { status: 415, errorCode: 'CONTENT_TYPE' })
  }
  const length = req.headers?.['content-length']
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > CONFIG_BODY_LIMIT)) {
    throw Object.assign(new Error('Request body too large'), { status: 413, errorCode: 'BODY_TOO_LARGE' })
  }
  const chunks = await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAbort)
    }
    const onError = () => { cleanup(); reject(Object.assign(new Error('Invalid request stream'), { status: 400, errorCode: 'INVALID_REQUEST' })) }
    const onAbort = () => onError()
    const onEnd = () => { cleanup(); resolve(chunks) }
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > CONFIG_BODY_LIMIT) {
        cleanup()
        // Drain without retaining bytes or destroying the response socket.
        req.resume()
        reject(Object.assign(new Error('Request body too large'), { status: 413, errorCode: 'BODY_TOO_LARGE' }))
      } else chunks.push(bytes)
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAbort)
  })
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400, errorCode: 'INVALID_JSON' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.path !== 'string') {
    throw Object.assign(new Error('Path string required'), { status: 400, errorCode: 'INVALID_PATH' })
  }
  return body.path
}

export function sameOriginWrite(req) {
  const origin = req.headers?.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || !origin || origin === 'null') return false
  try {
    const protocol = req.socket?.encrypted ? 'https:' : 'http:'
    const expected = new URL(protocol + '//' + String(req.headers?.host || '')).origin
    return new URL(origin).origin === expected && origin === expected
  } catch { return false }
}

// ── 套餐标识 ────────────────────────────────────────────────────────────────
const PLAN_LABELS = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
}

function normalizePlan(value) {
  if (typeof value !== 'string') return null
  const plan = value.trim().toLowerCase()
  return plan && plan.length <= 80 && !/[\x00-\x1f\x7f]/.test(plan) ? plan : null
}

function planLabelOf(plan) {
  if (!plan) return '未知套餐'
  return PLAN_LABELS[plan] || plan
}

/** 把窗口分钟数转成人话，与 GPTNiangMac 的 quotaWindowLabel 保持一致。 */
function quotaWindowLabel(minutes) {
  if (minutes === 300) return '5 小时'
  if (minutes === 10080) return '每周'
  if (minutes % 1440 === 0) return (minutes / 1440) + ' 天'
  if (minutes % 60 === 0) return (minutes / 60) + ' 小时'
  return minutes + ' 分钟'
}

function beijing(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(seconds * 1000))
  } catch { return null }
}

/** 归一化 rateLimits 响应为窗口数组。字段与 GPTNiangMac 的 normalizeLimits 对齐。 */
function normalizeLimits(result) {
  const hasBuckets = result && Object.hasOwn(result, 'rateLimitsByLimitId') && result.rateLimitsByLimitId !== null
  const limit = hasBuckets ? result.rateLimitsByLimitId?.codex : result?.rateLimits
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return { windows: [], plan: null }
  const windows = []
  for (const key of ['primary', 'secondary']) {
    const raw = limit[key]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'object' || Array.isArray(raw)) continue
    const mins = raw.windowDurationMins
    const used = raw.usedPercent
    if (!Number.isSafeInteger(mins) || mins <= 0) continue
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    if (windows.some((w) => w.minutes === mins)) continue
    const reset = typeof raw.resetsAt === 'number' && raw.resetsAt > 0 ? raw.resetsAt : null
    windows.push({
      label: quotaWindowLabel(mins),
      minutes: mins,
      used,
      remaining: Math.round((100 - used) * 10) / 10,
      resetsAt: reset,
      resetBeijing: beijing(reset),
    })
  }
  windows.sort((a, b) => a.minutes - b.minutes)
  return { windows, plan: normalizePlan(limit.planType) }
}

// ── Codex app-server 只读查询 ───────────────────────────────────────────────
/**
 * 走 `codex app-server --stdio` 的 JSONL 协议，只发三个只读方法。
 * 任何一步失败都返回结构化结果，绝不抛给调用方。
 */
export function readQuota({ cli, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let done = false, proc = null, rl = null
    let account = null, plan = null, authType = null, stage = 'spawn'

    const failure = (error, errorCode) => ({
      ok: false, queryOk: false, source: 'Codex 官方订阅额度接口',
      plan: null, planLabel: '未知套餐', planKnown: false, planSource: null,
      authType: null, windows: [], error, errorCode: errorCode || null,
      observedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    })

    const stopChild = () => { try { proc?.stdin?.end(); proc?.kill() } catch { /* ignore */ } }
    const finish = (data) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { rl?.close() } catch { /* ignore */ }
      process.removeListener('exit', stopChild)
      stopChild()
      resolve(data)
    }

    const timer = setTimeout(() => finish(failure('查询超时，稍后重试', 'TIMEOUT')), timeoutMs)

    if (!cli) { finish(failure('未找到 Codex 程序，请检查客户端安装', 'ENOENT')); return }

    try {
      proc = spawn(cli, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    } catch {
      finish(failure('Codex 额度服务暂不可用', 'SPAWN_FAILED')); return
    }
    process.once('exit', stopChild)
    proc.stderr.on('data', () => {}).on('error', () => {})
    proc.on('error', (err) => finish(failure(
      err?.code === 'ENOENT' ? '未找到 Codex 程序，请检查客户端安装' : '无法启动 Codex 额度服务',
      err?.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED')))
    proc.on('close', () => finish(failure(stage === 'spawn' ? 'Codex 额度服务已结束' : 'Codex 额度服务已结束', 'CLOSED')))

    const send = (data) => { try { proc.stdin.write(JSON.stringify(data) + '\n') } catch { finish(failure('额度连接不可用', 'WRITE_FAILED')) } }

    let expected = 1
    rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (done) return
      if (line.length > 2 * 1024 * 1024) return
      let m
      try { m = JSON.parse(line) } catch { return }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return
      if (m.id !== expected) return

      if (m.id === 1) {
        stage = 'initialized'
        if (m.error) { finish(failure('Codex 额度接口未就绪', 'INIT_FAILED')); return }
        expected = null
        send({ method: 'initialized', params: {} })
        expected = 2
        send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        return
      }

      if (m.id === 2) {
        stage = 'account'
        if (m.error) { finish(failure('暂时无法读取登录状态', 'ACCOUNT_READ_FAILED')); return }
        account = m.result?.account ?? null
        authType = account?.type ?? null
        plan = normalizePlan(account?.planType)
        if (authType !== 'chatgpt' && authType !== 'chatgptAuthTokens') {
          finish(failure('请在 Codex 中使用 ChatGPT 账号登录（API Key 不提供订阅额度）', 'AUTH_MODE_UNSUPPORTED'))
          return
        }
        expected = 3
        send({ id: 3, method: 'account/rateLimits/read', params: {} })
        return
      }

      if (m.id === 3) {
        stage = 'limits'
        if (m.error) { finish(failure('暂时无法读取额度，请检查登录状态或稍后重试', 'RATE_LIMITS_READ_FAILED')); return }
        const data = m.result ?? {}
        const norm = normalizeLimits(data)
        const finalPlan = norm.plan || plan
        finish({
          ok: norm.windows.length > 0,
          queryOk: true,
          source: 'Codex 官方订阅额度接口',
          plan: finalPlan,
          planLabel: planLabelOf(finalPlan),
          planKnown: finalPlan !== null && Object.hasOwn(PLAN_LABELS, finalPlan),
          planSource: norm.plan ? 'rateLimits' : 'account',
          authType,
          windows: norm.windows,
          ordinaryUsageAllowed: data.ordinaryUsageAllowed ?? null,
          error: norm.windows.length === 0 ? '当前账户未提供可显示的额度窗口' : null,
          errorCode: norm.windows.length === 0 ? 'NO_WINDOWS' : null,
          observedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
        })
      }
    })

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'dsh_gpt_niang_quota', title: 'GPT娘额度挂件', version: PLUGIN_VERSION } },
    })
  })
}

/** 单飞 + 缓存地取额度。refresh=true 时绕过缓存，但仍与在途请求合并。 */
function getQuota(force) {
  const now = Date.now()
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.payload)
  if (inFlight) return inFlight
  const cli = configuredCodex()
  const revision = configRevision
  const pending = readQuota({ cli })
    .then((payload) => {
      // A query started before a settings update must never repopulate the cache.
      if (revision !== configRevision) return payload
      // 只缓存成功或"查询成功但无窗口"的结果；启动失败不缓存，下次立刻重试。
      if (payload.queryOk) cache = { at: Date.now(), payload }
      if (!payload.ok) lastError = { at: Date.now(), error: payload.error, errorCode: payload.errorCode }
      else lastError = null
      return payload
    })
    .catch(() => ({
      ok: false, queryOk: false, windows: [], plan: null, planLabel: '未知套餐',
      error: '额度查询异常，请稍后重试', errorCode: 'UNEXPECTED',
      observedAt: new Date().toISOString(),
    }))
    .finally(() => { if (inFlight === pending) inFlight = null })
  inFlight = pending
  return pending
}

// ── 信任栅栏（沿用 whale 的三层思路，fail-closed）────────────────────────────
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function selfRejection(req, { trusted = [], fenceAvailable = false } = {}) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch { return 403 }
    const hostname = hostUrl.hostname
    const authority = hostUrl.host
    if (!isLoopbackHostname(hostname) && !fenceAvailable) {
      const listed = trusted.some((e) => (e.includes(':') ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
      if (!listed) return 403
    }
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let ou = null
      try { ou = new URL(origin) } catch { return 403 }
      if (ou.host.toLowerCase() !== authority.toLowerCase()) return 403
    }
    return null
  } catch { return 403 }
}

// ── 注入行（桌面端 Electron 通道）────────────────────────────────────────────
// 桌面壳的 index.html 从安装包静态 dist 直出，tapIndex 永远过不去；唯一通道是
// webserver/index-inject 的结构化行。且解释器对 script-src 行是「加载失败即 reject 整个 boot」，
// 所以这里用内联 script 行，自己建 <script> 并吞掉 onerror —— 路由不在时静默失败，绝不拖垮宿主。
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + CLIENT_SCRIPT_PATH + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export function apply(root) {
  const disposers = []
  root.effect(() => () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })

  // ① 桌面端注入行：不依赖任何服务，必须最早进表。
  disposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script-src' && row.src === CLIENT_SCRIPT_PATH) return
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(CLIENT_SCRIPT_PATH)) return
      }
      table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
    } catch { /* ignore */ }
  }))

  // ② 其余逻辑等齐 webServer 后再跑。
  root.inject(['webServer'], (ctx) => {
    const TRUSTED = String(process.env.DSH_GPT_NIANG_TRUSTED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

    const connectionFence = () => {
      try {
        const conn = ctx.get?.('connection') || ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch { return null }
    }

    const rejected = (req, res) => {
      const deny = (code) => { try { res.statusCode = code || 403; res.end() } catch { /* ignore */ } ; return true }
      const conn = connectionFence()
      const self = selfRejection(req, { trusted: TRUSTED, fenceAvailable: !!conn })
      if (self !== null) return deny(self)
      if (!conn) return false
      let code
      try { code = conn.requestRejection(req) } catch { return deny(403) }
      if (code === undefined || code === null || code === false) return false
      return deny(typeof code === 'number' ? code : 403)
    }

    const registerRoute = (route) => {
      const inner = route && route.handler
      return ctx.webServer.register(Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return
          return inner(req, res)
        },
      }))
    }

    const sendJson = (res, body, status = 200) => {
      const text = JSON.stringify(body, null, 2)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(text)),
      })
      res.end(text)
    }

    // Detection is filesystem-only; executable health is checked by quota reads.
    disposers.push(registerRoute({
      kind: 'exact',
      path: ROUTE_PREFIX + '/detection.json',
      handler: async (req, res) => {
        if (req.method === 'GET') { sendJson(res, detectionStatus()); return }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          sendJson(res, { error: 'Method unsupported', errorCode: 'METHOD' }, 405)
          return
        }
        if (!sameOriginWrite(req)) {
          sendJson(res, { error: 'Origin rejected', errorCode: 'ORIGIN' }, 403)
          return
        }
        let configuredPath
        try {
          const validation = validateCodexPath(await readDetectionBody(req))
          if (!validation.ok) {
            sendJson(res, { error: 'Choose an existing absolute Codex executable path', errorCode: 'INVALID_PATH' }, 400)
            return
          }
          configuredPath = validation.configuredPath
        } catch (err) {
          sendJson(res, { error: 'Invalid configuration request', errorCode: err?.errorCode || 'INVALID_REQUEST' }, err?.status || 400)
          return
        }
        try {
          saveSettings(configuredPath)
          sendJson(res, detectionStatus())
        } catch {
          sendJson(res, { error: 'Configuration save failed', errorCode: 'SAVE_FAILED' }, 500)
        }
      },
    }))

    // 额度只读接口。绝不返回邮箱、账户 id、凭据。
    disposers.push(registerRoute({
      kind: 'exact',
      path: ROUTE_PREFIX + '/quota.json',
      handler: async (req, res) => {
        try {
          const force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
          const payload = await getQuota(force)
          sendJson(res, {
            ...payload,
            lastError,
            cli: detectionStatus().binaryName,
            pluginVersion: PLUGIN_VERSION,
          })
        } catch (err) {
          sendJson(res, {
            ok: false, queryOk: false, windows: [], planLabel: '未知套餐',
            error: '额度接口异常，请稍后重试', errorCode: 'ROUTE_FAILED',
            observedAt: new Date().toISOString(),
          }, 200)
        }
      },
    }))

    // Client 半区脚本。脚本内容在 register 时读盘，插件更新后重启即生效。
    disposers.push(registerRoute({
      kind: 'exact',
      path: CLIENT_SCRIPT_PATH,
      handler: (req, res) => {
        try {
          const file = path.join(PACKAGE_ROOT, 'widget.js')
          const bytes = fs.readFileSync(file)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('widget.js unavailable')
        }
      },
    }))

    // 立绘 / 音效 / 语录。ETag = 大小-修改时间，命中 If-None-Match 走 304，
    // 既不会每次重传 1.7MB 立绘，换图后又立刻生效。
    for (const [url, rel] of STATIC_ASSETS) {
      disposers.push(registerRoute({
        kind: 'exact',
        path: url,
        handler: (req, res) => {
          try {
            const file = path.join(PACKAGE_ROOT, rel)
            const st = fs.statSync(file)
            const etag = '"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"'
            if (req.headers && req.headers['if-none-match'] === etag) {
              res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
              res.end()
              return
            }
            const bytes = fs.readFileSync(file)
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
              'Cache-Control': 'no-cache',
              ETag: etag,
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('asset unavailable')
          }
        },
      }))
    }

    // 非桌面形态（浏览器直连 dsh web）走 tapIndex。
    disposers.push(ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string' || html.includes(CLIENT_SCRIPT_PATH)) return html
      const tag = '<script defer src="' + CLIENT_SCRIPT_PATH + '"></script>'
      if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    disposers.push(ctx.effect(() => () => {
      try { cache = null; lastError = null } catch { /* ignore */ }
    }))
  })
}

export default { name: 'gpt-niang-quota', apply }
export const inject = ['webServer']
