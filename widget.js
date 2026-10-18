/**
 * dsh-gpt-niang-quota —— 前端挂件（纯 DOM，同 dsh-whale-widget 架构）
 *
 * 显示内容：原创角色立绘（由公开发行包另行提供）。
 *   · 立绘常驻显示，默认站在输入框左侧、与输入框同底
 *   · 拖动可移动，位置按「锚点 + 离边距离」持久化（照抄 whale 的 dshw-pos v2 方案）
 *   · 工具条调缩放；修饰键 + 滚轮也可缩放
 *   · 点击立绘 → 头顶气泡，交替显示「语录」与「额度卡片」
 *   · 气泡额度页含：套餐名、两个窗口的进度条、剩余、北京时间重置点、刷新按钮
 *   · 按下 / 抬起播 press.wav / release.wav，缺失时使用合成提示音
 *
 * 架构约束（与 dsh-whale-widget 一致）：
 *   · 不用 __ModuleLoader__、不用 ctx.slots、不依赖任何前端模块表与 React
 *   · 自己注入 <style>、自己 createElement、自己 appendChild 到 body
 *   · position:fixed + z-index 高层级；根节点 pointer-events:none，只有立绘与气泡接指针
 *   · 等 [data-composer-input] 出现才挂载；检测到之前一行 DOM 都不碰
 *   · 立绘透明像素不吞点击（canvas 采样 alpha，透明处把事件转交下层）
 */

(function () {
  if (window.__dshGptNiang) return
  window.__dshGptNiang = true

  var PREFIX = '/dsh-gpt-niang'
  var API = PREFIX + '/quota.json'
  var IMG = PREFIX + '/niang.png'
  var SND_PRESS = PREFIX + '/press.wav'
  var SND_RELEASE = PREFIX + '/release.wav'
  var QUOTES_URL = PREFIX + '/quotes.json'

  var POLL_MS = 60000
  var POS_KEY = 'dgn-pos'
  var CFG_KEY = 'dgn-cfg'

  // 通用公开发行默认值；不包含个人偏好。
  var DEFAULTS = {
    scale: 0.65,
    volume: 0.4,
    muted: false,
    bubbleTapAdvance: true,
    specialQuotes: '休息一下，再继续吧。',
    customQuotes: '',
    customQuotesOnly: false,
    repliesEdited: false,
    quotaEnabled: true,
    quotaBadge: true,
    quotaInterval: 60,
  }

  // ── 只在主聊天界面挂载 ────────────────────────────────────────────────
  function isChatRoot(r) {
    if (!r || !r.querySelector) return false
    return !!(
      r.querySelector('[data-composer-input]') ||
      r.querySelector('[data-composer-seat],[data-composer-card]') ||
      r.querySelector('[role="textbox"][aria-multiline="true"]')
    )
  }

  // ── 配置 ──────────────────────────────────────────────────────────────
  var cfg = {}
  for (var dk in DEFAULTS) cfg[dk] = DEFAULTS[dk]
  try {
    var savedCfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null')
    if (savedCfg && typeof savedCfg === 'object') {
      for (var sk in savedCfg) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, sk) &&
            typeof savedCfg[sk] === typeof DEFAULTS[sk]) {
          cfg[sk] = savedCfg[sk]
        }
      }
    }
  } catch (e) { /* ignore */ }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) } catch (e) { /* ignore */ }
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

  // ── 样式 ──────────────────────────────────────────────────────────────
  function buildCss() {
    return [
      '.dgn-root{position:fixed;left:0;top:0;z-index:9998;pointer-events:none;' +
        'user-select:none;-webkit-user-select:none;font-family:inherit;' +
        'transition:opacity .15s ease}',

      /* 立绘：只有它接指针；尺寸由 --dgn-base 控制 */
      '.dgn-char{position:relative;pointer-events:auto;cursor:grab;' +
        'touch-action:none;-webkit-user-drag:none}',

      '.dgn-char.dgn-dragging{cursor:grabbing}',
      // 镜像单独放一层，避免被呼吸/点击动画的 transform 覆盖。
      '.dgn-art{position:absolute;inset:0;pointer-events:none}',
      '.dgn-root[data-facing="right"] .dgn-art{transform:scaleX(-1)}',

      '.dgn-img{display:block;width:100%;height:100%;object-fit:contain;' +
        'pointer-events:none;-webkit-user-drag:none;' +
        'filter:drop-shadow(0 4px 14px rgba(90,70,130,.3));' +
        'transform-origin:50% 100%;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}',

      '.dgn-char:hover .dgn-img{transform:translateY(-2px) scale(1.02)}',

      /* 呼吸：极轻微，避免打扰 */
      '@keyframes dgn-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
      '.dgn-char.dgn-idle .dgn-img{animation:dgn-breathe 4.2s ease-in-out infinite}',
      '.dgn-char.dgn-idle:hover .dgn-img{animation-play-state:paused}',

      /* 点击反馈：蹦一下 + 挤压，肉眼可见的"她动了" */
      '@keyframes dgn-hop{0%{transform:translateY(0) scale(1,1)}' +
        '28%{transform:translateY(-7px) scale(.95,1.06)}' +
        '58%{transform:translateY(0) scale(1.07,.93)}' +
        '100%{transform:translateY(0) scale(1,1)}}',
      '.dgn-char.dgn-react .dgn-img{animation:dgn-hop .36s cubic-bezier(.34,1.56,.64,1)}',

      /* 悬停工具条：拖动 / 缩放 / 静音 / 复位 摆在明面上 */
      '.dgn-tools{position:absolute;left:50%;bottom:100%;margin-bottom:7px;' +
        'transform:translateX(-50%);display:flex;gap:2px;padding:3px;' +
        'border-radius:10px;pointer-events:none;opacity:0;' +
        'background:var(--dsw-alias-bg-layer-1,#fff);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));' +
        'box-shadow:0 6px 20px rgba(0,0,0,.18);' +
        'transition:opacity .14s ease;white-space:nowrap;z-index:3}',

      '.dgn-root.dgn-hover .dgn-tools,.dgn-root:focus-within .dgn-tools{opacity:1;pointer-events:auto}',
      // 互斥规则高于 hover/focus：气泡打开时工具条不参与显示和命中。
      '.dgn-root.dgn-bubble-open .dgn-tools{display:none!important}',
      '.dgn-root.dgn-bubble-open .dgn-toast{display:none!important}',
      // 填平立绘与工具条之间的 7px 空隙，鼠标移向按钮时保持命中。
      '.dgn-tools::after{content:"";position:absolute;left:0;right:0;top:100%;height:10px}',

      '.dgn-tbtn{font:inherit;font-size:12px;line-height:1;width:24px;height:24px;' +
        'display:flex;align-items:center;justify-content:center;' +
        'border:0;border-radius:7px;cursor:pointer;background:transparent;' +
        'color:var(--dsw-alias-label-secondary,#555);padding:0}',

      '.dgn-tbtn-w{width:auto;padding:0 8px;font-size:11px;font-weight:600}',

      '.dgn-tbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08))}',
      '.dgn-tbtn.dgn-on{background:rgba(155,134,193,.24);color:#6d559b}',
      '.dgn-tbtn:disabled{opacity:.4;cursor:default}',

      /* 缩放百分比提示，点一下 +/− 时闪一下 */
      '.dgn-toast{position:absolute;left:50%;top:100%;margin-top:7px;' +
        'transform:translateX(-50%);padding:3px 9px;border-radius:8px;' +
        'font-size:11px;font-weight:600;pointer-events:none;opacity:0;' +
        'background:rgba(30,26,40,.9);color:#fff;white-space:nowrap;z-index:4;' +
        'transition:opacity .18s ease}',
      '.dgn-toast.dgn-show{opacity:1}',

      /* 额度角标：贴在立绘胸口位置，不挡脸 */
      '.dgn-badge{position:absolute;right:4%;bottom:3%;pointer-events:none;' +
        'min-width:34px;padding:2px 7px;border-radius:999px;' +
        'font-size:11px;font-weight:700;line-height:1.5;text-align:center;' +
        'color:#fff;background:rgba(109,85,155,.92);' +
        'box-shadow:0 2px 8px rgba(0,0,0,.28);white-space:nowrap}',

      '.dgn-badge.dgn-low{background:rgba(217,74,74,.94)}',
      '.dgn-badge.dgn-mid{background:rgba(207,140,48,.94)}',

      /* 语录 / 额度气泡 */
      '.dgn-bubble{position:absolute;pointer-events:auto;' +
        'width:max-content;max-width:262px;min-width:150px;' +
        'background:var(--dsw-alias-bg-layer-1,#fff);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));' +
        'border-radius:14px;padding:9px 12px;' +
        'box-shadow:0 10px 32px rgba(0,0,0,.22);' +
        'color:var(--dsw-alias-label-primary,#1a1a1a);' +
        'animation:dgn-pop .16s ease-out;cursor:pointer}',

      '@keyframes dgn-pop{from{opacity:0;transform:translateY(7px) scale(.96)}' +
        'to{opacity:1;transform:none}}',

      /* 气泡尾巴：指向立绘。水平位置由 --dgn-tail-x 动态给出，
         这样气泡被视口夹住时尾巴依然指着角色，而不是固定在气泡的某个角。 */
      '.dgn-bubble::after{content:"";position:absolute;width:11px;height:11px;' +
        'background:inherit;' +
        'left:var(--dgn-tail-x,24px);' +
        'transform:translateX(-50%) rotate(45deg);' +
        'border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));' +
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',

      '.dgn-bubble.dgn-tail-up::after{bottom:-6px}',
      '.dgn-bubble.dgn-tail-down::after{top:-6px;' +
        'transform:translateX(-50%) rotate(225deg)}',

      '.dgn-quote{font-size:12.5px;line-height:1.65;word-break:break-word}',

      '.dgn-qhead{display:flex;align-items:center;gap:7px;margin-bottom:7px}',
      '.dgn-qname{font-size:11.5px;font-weight:600;flex:1;' +
        'color:var(--dsw-alias-label-secondary,#666)}',

      '.dgn-plan{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px;' +
        'background:rgba(155,134,193,.22);white-space:nowrap}',

      '.dgn-row{margin-bottom:9px}',
      '.dgn-row:last-of-type{margin-bottom:0}',

      '.dgn-rowtop{display:flex;justify-content:space-between;align-items:baseline;' +
        'font-size:11px;margin-bottom:4px;color:var(--dsw-alias-label-secondary,#666)}',

      '.dgn-pct{font-weight:700;font-size:11.5px;' +
        'color:var(--dsw-alias-label-primary,#222)}',

      '.dgn-track{height:5px;border-radius:999px;' +
        'background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08));overflow:hidden}',

      '.dgn-fill{height:100%;border-radius:999px;transition:width .35s ease}',

      '.dgn-meta{margin-top:3px;font-size:10px;' +
        'color:var(--dsw-alias-label-tertiary,#8a8a8a)}',

      '.dgn-err{font-size:11.5px;line-height:1.6;word-break:break-word;' +
        'color:var(--dsw-alias-label-secondary,#666)}',

      '.dgn-foot{display:flex;justify-content:space-between;align-items:center;' +
        'margin-top:9px;padding-top:7px;' +
        'border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));' +
        'font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}',

      '.dgn-btn{font:inherit;font-size:10px;padding:2px 8px;border-radius:5px;' +
        'cursor:pointer;' +
        'background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.05));' +
        'color:var(--dsw-alias-label-secondary,#555);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',

      '.dgn-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.09))}',
      '.dgn-btn:disabled{opacity:.5;cursor:default}',
      '.dgn-settings-mask{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}',
      '.dgn-settings{box-sizing:border-box;width:440px;max-width:100%;max-height:85vh;overflow:auto;padding:22px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:0 20px 70px #0005;font:13px/1.6 system-ui,sans-serif}',
      '.dgn-settings h3{margin:0 0 14px;font-size:17px}',
      '.dgn-settings textarea{box-sizing:border-box;width:100%;height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#bbb);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-2,#fafafa);color:inherit;font:inherit;user-select:text}',
      '.dgn-settings label{display:block;margin:12px 0}',
      '.dgn-settings p{color:var(--dsw-alias-label-secondary,#666);margin:8px 0}',
      '.dgn-settings-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}',
      '.dgn-settings button{font:inherit;padding:8px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;cursor:pointer;transition:background .15s,box-shadow .15s}',
      '.dgn-settings-mask{background:rgba(20,16,35,.38);backdrop-filter:blur(7px)}',
      '.dgn-settings{width:560px;padding:28px;border:1px solid var(--dsw-alias-border-l2,#e6e1ed);border-radius:22px;box-shadow:0 24px 90px #17102940;font-family:inherit}',
      '.dgn-settings h3{font-size:21px;letter-spacing:-.4px;margin:0;font-weight:650}',
      '.dgn-settings-subtitle{font-size:12px;margin:4px 0 22px!important}',
      '.dgn-settings-tabs{display:flex;gap:4px;background:var(--dsw-alias-bg-layer-3,#f0edf5);padding:4px;border-radius:12px;margin-bottom:22px}',
      '.dgn-settings-tabs button{flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#70677e);font-weight:600}',
      '.dgn-settings-tabs button[aria-selected=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:#9574c1;box-shadow:0 2px 7px #21152d14}',
      '.dgn-settings label{font-weight:550;margin:16px 0;color:var(--dsw-alias-label-primary,#302938)}',
      '.dgn-setting-toggle{display:flex!important;align-items:center;gap:12px;padding:13px 14px;margin:8px 0!important;background:var(--dsw-alias-bg-layer-2,#f8f6fa);border-radius:11px}',
      '.dgn-setting-toggle input{appearance:none;flex:none;width:34px;height:20px;border:0;border-radius:99px;background:var(--dsw-alias-border-l2,#cfc9d7);position:relative;cursor:pointer;transition:background .18s;margin:0}',
      '.dgn-setting-toggle input::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .18s}',
      '.dgn-setting-toggle input:checked{background:#9574c1}.dgn-setting-toggle input:checked::after{transform:translateX(14px)}',
      '.dgn-settings input[type=text],.dgn-settings input[type=number],.dgn-settings textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#ded8e5)!important;border-radius:10px!important;padding:10px 12px!important;background:var(--dsw-alias-bg-layer-2,#faf8fc)!important;color:inherit;outline:none;font:inherit;transition:border-color .15s,box-shadow .15s}',
      '.dgn-settings input[type=text]{margin-top:8px;width:100%;font-size:12px}.dgn-settings input[type=number]{width:100px;margin-left:10px}',
      '.dgn-settings textarea{height:230px;margin-top:8px;line-height:1.9;font-weight:400}',
      '.dgn-settings :is(input,textarea,button):focus-visible{outline:2px solid #a786ce;outline-offset:3px}',
      '.dgn-settings p{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8a8194)}',
      '.dgn-detect-status{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#e0d9e9);border-left:3px solid #a887cf;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f8f5fc);color:var(--dsw-alias-label-secondary,#6c5d7d)!important;margin:18px 0!important}',
      '.dgn-detection-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.dgn-detection-actions button{font-size:12px;padding:7px 11px}',
      '.dgn-settings-actions{padding-top:18px;margin-top:22px;border-top:1px solid var(--dsw-alias-border-l2,#eee);gap:8px;flex-wrap:wrap}',
      '.dgn-settings button:hover{background:var(--dsw-alias-interactive-bg-hover,#f0ebf6)}',
      '.dgn-settings-actions .dgn-primary{background:#9271bc;color:white;border-color:transparent;box-shadow:0 3px 9px #9271bc30}',
      '.dgn-settings-actions .dgn-primary:hover{background:#815fae}',
      '@media(max-width:560px){.dgn-settings{padding:20px;border-radius:16px}.dgn-settings-mask{padding:12px}}',
    ].join('\n')
  }

  function injectStyle() {
    if (document.getElementById('dgn-style')) return
    var st = document.createElement('style')
    st.id = 'dgn-style'
    st.setAttribute('data-plugin', 'dsh-gpt-niang-quota')
    st.textContent = buildCss()
    document.head.appendChild(st)
  }

  // ── 颜色 / 时间 ───────────────────────────────────────────────────────
  function fillBg(r) {
    if (r <= 10) return 'linear-gradient(90deg,#d94a4a,#e87a7a)'
    if (r <= 30) return 'linear-gradient(90deg,#d9913a,#eab765)'
    return 'linear-gradient(90deg,#9b86c1,#b9a6dd)'
  }
  function badgeClass(r) {
    if (r === null) return ''
    if (r <= 10) return ' dgn-low'
    if (r <= 30) return ' dgn-mid'
    return ''
  }
  function relTime(iso) {
    if (!iso) return ''
    var at = Date.parse(iso)
    if (!isFinite(at)) return ''
    var s = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (s < 45) return '刚刚更新'
    if (s < 90) return '1 分钟前'
    return Math.round(s / 60) + ' 分钟前'
  }

  // ── 状态 ──────────────────────────────────────────────────────────────
  var rootEl = null, charEl = null, imgEl = null, badgeEl = null, bubbleEl = null
  var toolsEl = null, muteBtn = null, toastEl = null, toastTimer = null
  var quota = null
  var loading = false
  var quotes = []
  var bubbleMode = null      // null | 'quote' | 'quota'
  var lastQuote = ''
  var alphaMap = null        // { w, h, data }
  var started = false
  var freePos = null         // { hAnchor, hDist, vAnchor, vDist }
  var dragInProgress = false // 自动布局不能在拖动中覆盖实时位置

  // ── 立绘 alpha 采样（让透明处不吞点击）────────────────────────────────
  function buildAlphaMap() {
    try {
      var W = 96, H = 96
      var c = document.createElement('canvas')
      c.width = W; c.height = H
      var g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(imgEl, 0, 0, W, H)
      var d = g.getImageData(0, 0, W, H).data
      var a = new Uint8Array(W * H)
      for (var i = 0; i < W * H; i++) a[i] = d[i * 4 + 3]
      alphaMap = { w: W, h: H, data: a }
    } catch (e) {
      alphaMap = null   // 取不到就退回「整块可点」，不影响功能
    }
  }

  // 事件坐标是否落在立绘不透明像素上
  function hitsArtwork(clientX, clientY) {
    if (!alphaMap || !charEl) return true
    var r = charEl.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return true
    var u = (clientX - r.left) / r.width
    var v = (clientY - r.top) / r.height
    if (u < 0 || u > 1 || v < 0 || v > 1) return false
    if (rootEl.getAttribute('data-facing') === 'right') u = 1 - u
    var x = Math.min(alphaMap.w - 1, Math.max(0, Math.floor(u * alphaMap.w)))
    var y = Math.min(alphaMap.h - 1, Math.max(0, Math.floor(v * alphaMap.h)))
    return alphaMap.data[y * alphaMap.w + x] > 24
  }

  // ── 音效 ──────────────────────────────────────────────────────────────
  // 用 WebAudio 播发行包的原创 press/release 采样；解码没就绪时合成一个短音兜底，
  // 这样"点一下一定会叫"，不会出现第一次点击没声音的情况。
  var audioCtx = null
  var buffers = {}
  var SND = { press: SND_PRESS, release: SND_RELEASE }

  function ac() {
    if (audioCtx) return audioCtx
    try {
      var C = window.AudioContext || window.webkitAudioContext
      audioCtx = C ? new C() : null
    } catch (e) { audioCtx = null }
    return audioCtx
  }

  function preloadAudio() {
    var c = ac()
    if (!c) return
    for (var kind in SND) {
      if (buffers[kind]) continue
      buffers[kind] = 'loading'
      ;(function (k) {
        fetch(SND[k], { credentials: 'same-origin' })
          .then(function (r) { return r.arrayBuffer() })
          .then(function (ab) {
            return new Promise(function (res, rej) {
              c.decodeAudioData(ab, res, rej)
            })
          })
          .then(function (buf) { buffers[k] = buf })
          .catch(function () { buffers[k] = null })   // 失败就一路走合成音
      })(kind)
    }
  }

  function beep(freq, dur) {
    var c = ac()
    if (!c) return
    try {
      var t = c.currentTime
      var o = c.createOscillator()
      var g = c.createGain()
      o.type = 'triangle'
      o.frequency.setValueAtTime(freq, t)
      o.frequency.exponentialRampToValueAtTime(freq * 1.7, t + dur)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.22 * clamp(cfg.volume, 0, 1), t + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(g); g.connect(c.destination)
      o.start(t); o.stop(t + dur + 0.02)
    } catch (e) { /* ignore */ }
  }

  function play(kind) {
    if (cfg.muted || cfg.volume <= 0) return
    var c = ac()
    var buf = c && buffers[kind]
    if (buf && buf !== 'loading') {
      try {
        if (c.state === 'suspended') c.resume()
        var src = c.createBufferSource()
        src.buffer = buf
        var g = c.createGain()
        g.gain.value = clamp(cfg.volume, 0, 1)
        src.connect(g); g.connect(c.destination)
        src.start()
        return
      } catch (e) { /* 落到兜底 */ }
    }
    if (c && c.state === 'suspended') { try { c.resume() } catch (e) { /* ignore */ } }
    beep(kind === 'press' ? 880 : 1240, kind === 'press' ? 0.10 : 0.13)
  }

  // ── 语录 ──────────────────────────────────────────────────────────────
  function loadQuotes() {
    fetch(QUOTES_URL, { credentials: 'same-origin' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var list = (j && j.quotes) || []
        quotes = list.filter(function (q) {
          return q && typeof q.text === 'string' && q.text
        })
        if (!lastQuote && quotes.length) lastQuote = pickQuote()
      })
      .catch(function () { /* 语录拿不到就不显示语录页 */ })
  }

  function pickQuote() {
    if (cfg.repliesEdited) {
      var edited = cfg.customQuotes.split(/\r?\n/).map(function (s) { return s.trim() }).filter(Boolean)
      return edited.length ? edited[Math.floor(Math.random() * edited.length)] : ''
    }
    var custom = String(cfg.customQuotes || '').split(/\r?\n/).map(function (s) { return s.trim() }).filter(Boolean)
    if (custom.length && (cfg.customQuotesOnly || Math.random() < 0.5)) {
      return custom[Math.floor(Math.random() * custom.length)]
    }
    // 特殊语录（原应用 specialQuotes）偶尔出现
    if (cfg.specialQuotes && Math.random() < 0.18) return cfg.specialQuotes
    if (!quotes.length) return ''
    var total = 0
    for (var i = 0; i < quotes.length; i++) total += (Number(quotes[i].weight) || 1)
    var t = Math.random() * total
    for (var k = 0; k < quotes.length; k++) {
      t -= (Number(quotes[k].weight) || 1)
      if (t <= 0) return quotes[k].text
    }
    return quotes[quotes.length - 1].text
  }

  // ── 额度 ──────────────────────────────────────────────────────────────
  function primaryWindow() {
    var ws = (quota && quota.windows) || []
    for (var i = 0; i < ws.length; i++) if (ws[i].minutes === 300) return ws[i]
    return ws[0] || null
  }

  function paintBadge() {
    var p = primaryWindow()
    var rem = p ? p.remaining : null
    badgeEl.style.display = cfg.quotaEnabled && cfg.quotaBadge ? '' : 'none'
    badgeEl.textContent = rem === null ? '—' : rem + '%'
    badgeEl.className = 'dgn-badge' + badgeClass(rem)
    // 原生 title 浮层由浏览器定位，容易压在语录/额度上；说明改用无障碍标签。
    charEl.removeAttribute('title')
    charEl.setAttribute('aria-label', 'GPT 娘 · 拖动移动，单击查看语录和额度，悬停显示工具条')
  }

  function load(force) {
    if (!cfg.quotaEnabled) return
    loading = true
    if (bubbleMode === 'quota') paintBubble()
    fetch(API + (force ? '?refresh=1' : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        quota = j
        loading = false
        paintBadge()
        if (bubbleMode === 'quota') paintBubble()
      })
      .catch(function (err) {
        quota = {
          ok: false, queryOk: false, windows: [], planLabel: '未知套餐',
          error: '无法连接额度服务：' + String((err && err.message) || err),
        }
        loading = false
        paintBadge()
        if (bubbleMode === 'quota') paintBubble()
      })
  }

  // ── 气泡渲染 ──────────────────────────────────────────────────────────
  function clearBubble() {
    while (bubbleEl.firstChild) bubbleEl.removeChild(bubbleEl.firstChild)
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function paintBubble() {
    if (!bubbleEl || !bubbleMode) return
    clearBubble()

    if (bubbleMode === 'quote' && !lastQuote) { hideBubble(); return }
    if (bubbleMode === 'quote') {
      bubbleEl.appendChild(el('div', 'dgn-quote', lastQuote || '休息一下，再继续吧。'))
    } else {
      var ws = (quota && quota.windows) || []

      var head = el('div', 'dgn-qhead')
      head.appendChild(el('span', 'dgn-qname', 'Codex 额度'))
      head.appendChild(el('span', 'dgn-plan', (quota && quota.planLabel) || '未知套餐'))
      bubbleEl.appendChild(head)

      if (ws.length) {
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i]
          var row = el('div', 'dgn-row')

          var top = el('div', 'dgn-rowtop')
          top.appendChild(el('span', null, w.label))
          top.appendChild(el('span', 'dgn-pct', '剩余 ' + w.remaining + '%'))

          var tr = el('div', 'dgn-track')
          var fl = el('div', 'dgn-fill')
          fl.style.width = clamp(w.remaining, 0, 100) + '%'
          fl.style.background = fillBg(w.remaining)
          tr.appendChild(fl)

          var mt = el('div', 'dgn-meta', '已用 ' + w.used + '%' +
            (w.resetBeijing ? ' · 重置 ' + w.resetBeijing : ''))

          row.appendChild(top); row.appendChild(tr); row.appendChild(mt)
          bubbleEl.appendChild(row)
        }
      } else {
        bubbleEl.appendChild(el('div', 'dgn-err',
          (quota && quota.error) || (loading ? '正在读取额度…' : '暂无额度数据')))
      }

      var foot = el('div', 'dgn-foot')
      foot.appendChild(el('span', null,
        loading ? '刷新中…' : (relTime(quota && quota.observedAt) || '—')))
      var btn = el('button', 'dgn-btn', '刷新')
      btn.type = 'button'
      btn.disabled = !!loading
      btn.addEventListener('click', function (e) { e.stopPropagation(); load(true) })
      foot.appendChild(btn)
      bubbleEl.appendChild(foot)
    }

    bubbleEl.style.display = ''
    if (rootEl) rootEl.classList.add('dgn-bubble-open')
    placeBubble()
  }

  // 气泡摆放：优先在立绘上方，放不下改下方；水平夹在视口内。
  // 气泡是 root 的子节点，而 root 左上角 = 立绘左上角，所以偏移都相对立绘量。
  function placeBubble() {
    if (!bubbleEl || bubbleEl.style.display === 'none') return
    var cr = charEl.getBoundingClientRect()
    var vw = window.innerWidth, vh = window.innerHeight

    bubbleEl.style.left = '0px'
    bubbleEl.style.top = '0px'
    var bw = bubbleEl.offsetWidth
    var bh = bubbleEl.offsetHeight
    var GAP = 12
    // 工具条在立绘上方占有固定空间，即使尚未悬停也预留，避免鼠标移入后遮住气泡。
    // 气泡与工具条互斥；隐藏的工具条 rect 为 0，不能拿它计算位置。
    var tr = { top: cr.top, bottom: cr.top }
    var ceiling = cr.top - GAP
    var above = ceiling - bh >= 8
    var left = clamp(cr.left + cr.width / 2 - bw / 2, 8, Math.max(8, vw - bw - 8))
    var top
    bubbleEl.style.maxHeight = ''
    bubbleEl.style.overflowY = ''
    if (above) {
      top = ceiling - bh
    } else if (cr.bottom + GAP + bh <= vh - 8) {
      top = cr.bottom + GAP
    } else if (cr.right + GAP + bw <= vw - 8 || cr.left - GAP - bw >= 8) {
      // 顶部空间不足时改放侧面，侧面从工具条下沿开始，不挤到按钮。
      left = cr.right + GAP + bw <= vw - 8 ? cr.right + GAP : cr.left - GAP - bw
      top = Math.max(8, tr.bottom + GAP)
      var room = Math.max(40, vh - top - 8)
      bubbleEl.style.maxHeight = room + 'px'
      bubbleEl.style.overflowY = 'auto'
    } else {
      // 极窄视口：浮层放在工具条下方，内容内部滚动，保住工具条可操作区。
      top = Math.max(8, tr.bottom + GAP)
      bubbleEl.style.maxHeight = Math.max(40, vh - top - 8) + 'px'
      bubbleEl.style.overflowY = 'auto'
    }

    bubbleEl.style.left = Math.round(left - cr.left) + 'px'
    bubbleEl.style.top = Math.round(top - cr.top) + 'px'

    // 尾巴对准立绘中心；气泡被视口夹住时仍然指着角色，只是尾巴偏到一侧
    var tailX = clamp(cr.left + cr.width / 2 - left, 18, Math.max(18, bw - 18))
    bubbleEl.style.setProperty('--dgn-tail-x', Math.round(tailX) + 'px')
    bubbleEl.className = 'dgn-bubble ' + (above ? 'dgn-tail-up' : 'dgn-tail-down')
  }

  function hideBubble() {
    bubbleMode = null
    if (bubbleEl) bubbleEl.style.display = 'none'
    if (rootEl) rootEl.classList.remove('dgn-bubble-open')
  }

  // 点击反馈：蹦一下（配合音效，视觉+听觉双反馈）
  var reactTimer = null
  function react() {
    if (!charEl) return
    charEl.classList.remove('dgn-idle')
    charEl.classList.add('dgn-react')
    if (reactTimer) clearTimeout(reactTimer)
    reactTimer = setTimeout(function () {
      charEl.classList.remove('dgn-react')
      charEl.classList.add('dgn-idle')
      reactTimer = null
    }, 380)
  }

  // 点击立绘：语录 ↔ 额度 交替（原应用 bubbleTapAdvance 语义）
  function tapBubble() {
    react()
    if (!cfg.quotaEnabled) { lastQuote = pickQuote(); bubbleMode = 'quote'; paintBubble(); return }
    if (!bubbleMode) {
      lastQuote = pickQuote() || lastQuote
      bubbleMode = 'quote'
    } else if (bubbleMode === 'quote') {
      bubbleMode = 'quota'
    } else {
      lastQuote = pickQuote() || lastQuote
      bubbleMode = 'quote'
    }
    paintBubble()
  }

  // ── 位置 ──────────────────────────────────────────────────────────────
  function baseSize() {
    var vw = window.innerWidth, vh = window.innerHeight
    // 参考边长 260，结合通用缩放值，让立绘在输入框旁边保持适当尺寸
    var ref = Math.min(260, Math.min(vw, vh) * 0.32)
    return Math.round(clamp(ref * cfg.scale, 110, 620))
  }

  function composerRect() {
    var seat = document.querySelector('[data-composer-seat]') ||
      document.querySelector('[data-composer-card]') ||
      document.querySelector('[data-composer-input]')
    if (!seat) return null
    var card = seat.closest('[data-composer-card]') || seat
    var r = card.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return r
  }

  // 默认位置：站在输入框左侧，与输入框同底
  var GAP = 12                   // 立绘与输入框之间的间距
  var MIN_SIZE = 88              // 收小也有个下限，不能变成一粒米
  var EDGE = 8                   // 离视口边缘的最小留白

  function composerAnchoredPos() {
    var r = composerRect()
    var vw = window.innerWidth, vh = window.innerHeight
    var size = effectiveSize()
    if (!r) return { left: 24, top: vh - size - 24 }
    // 立绘始终在输入框左侧。余量不够时收小尺寸（见 anchoredRoomSize），
    // 绝不翻到右边 —— 翻边会让"贴在输入框左边"这个默认位置凭空变卦。
    // 万一收小到了下限仍然放不下，就把间距压掉贴着 8px，也不会越到输入框上。
    var left = r.left - GAP - size
    if (left < EDGE) left = EDGE
    if (left + size > vw - EDGE) left = Math.max(EDGE, vw - size - EDGE)
    var top = clamp(r.bottom - size, EDGE, Math.max(EDGE, vh - size - EDGE))
    return { left: left, top: top }
  }

  function savePos(left, top) {
    var vw = window.innerWidth, vh = window.innerHeight
    // 记的是"自由摆放"后的位置，而自由状态一律用 baseSize()（不受左边距收小约束），
    // 所以这里的锚点必须用 baseSize() 算，跟之后 place() 的解释保持同一套尺寸。
    var size = baseSize()
    var maxOffH = Math.max(0, vw - size)
    var maxOffV = Math.max(0, vh - size)
    var l = clamp(left, 0, maxOffH)
    var t = clamp(top, 0, maxOffV)
    // 离边距离必须非负，否则会存成"永久坏锚点"，此后每次启动都复现
    freePos = {
      hAnchor: (l <= vw - size - l) ? 'left' : 'right',
      hDist: Math.max(0, Math.round(Math.min(l, vw - size - l))),
      vAnchor: (t <= vh - size - t) ? 'top' : 'bottom',
      vDist: Math.max(0, Math.round(Math.min(t, vh - size - t))),
    }
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        v: 2, hAnchor: freePos.hAnchor, hDist: freePos.hDist,
        vAnchor: freePos.vAnchor, vDist: freePos.vDist,
      }))
    } catch (e) { /* ignore */ }
  }

  function loadPos() {
    try {
      var a = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (!a || a.v !== 2) return null
      if (a.hAnchor !== 'left' && a.hAnchor !== 'right') return null
      if (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') return null
      if (typeof a.hDist !== 'number' || typeof a.vDist !== 'number') return null
      return { hAnchor: a.hAnchor, hDist: a.hDist, vAnchor: a.vAnchor, vDist: a.vDist }
    } catch (e) { return null }
  }

  // 锚定状态下的可用尺寸：输入框左侧确实摆不下时收小，而不是压住输入框。
  // 只有"贴输入框左边"这个默认位置才受此约束；用户拖动过之后完全按自己的尺寸来。
  // 返回 0 表示不约束（自由摆放，或边距本来就够）。
  function anchoredRoomSize() {
    if (freePos) return 0
    var r = composerRect()
    if (!r) return 0
    var room = r.left - GAP - EDGE
    var size = baseSize()
    if (room >= size) return 0            // 摆得下，不动
    return Math.round(clamp(room, Math.min(MIN_SIZE, size), size))
  }

  // 真正用于渲染的尺寸。place() 和 composerAnchoredPos() 必须用同一个值，
  // 否则算出来的 left 是拿大尺寸推的、画出来的却是小尺寸，位置会飘。
  function effectiveSize() {
    return anchoredRoomSize() || baseSize()
  }

  function place() {
    if (!rootEl || !charEl || dragInProgress) return
    var size = effectiveSize()
    rootEl.style.setProperty('--dgn-base', size + 'px')
    charEl.style.width = size + 'px'
    charEl.style.height = size + 'px'

    var left, top
    if (freePos) {
      var vw = window.innerWidth, vh = window.innerHeight
      var maxOffH = Math.max(0, vw - size)
      var maxOffV = Math.max(0, vh - size)
      var hDist = clamp(isFinite(freePos.hDist) ? freePos.hDist : 0, 0, maxOffH)
      var vDist = clamp(isFinite(freePos.vDist) ? freePos.vDist : 0, 0, maxOffV)
      left = freePos.hAnchor === 'left' ? hDist : vw - hDist - size
      top = freePos.vAnchor === 'top' ? vDist : vh - vDist - size
      left = clamp(left, 0, maxOffH)
      top = clamp(top, 0, maxOffV)
    } else {
      var p = composerAnchoredPos()
      left = p.left; top = p.top
    }

    rootEl.style.left = Math.round(left) + 'px'
    rootEl.style.top = Math.round(top) + 'px'
    updateFacing(left, size)
    if (toolsEl && !bubbleMode) {
      var tw = toolsEl.offsetWidth
      var tx = clamp(left + size / 2 - tw / 2, 8, Math.max(8, window.innerWidth - tw - 8))
      toolsEl.style.left = Math.round(tx - left) + 'px'
      toolsEl.style.transform = 'none'
    }
    if (bubbleMode) placeBubble()
  }

  function updateFacing(left, size) {
    var r = composerRect()
    var target = r ? r.left + r.width / 2 : window.innerWidth / 2
    rootEl.setAttribute('data-facing', left + size / 2 <= target ? 'right' : 'left')
  }

  function resetPos() {
    freePos = null
    try { localStorage.removeItem(POS_KEY) } catch (e) { /* ignore */ }
    hideBubble()          // 复位时收起气泡
    place()
  }

  // ── 缩放 / 提示 ───────────────────────────────────────────────────────
  function zoomBy(delta) {
    cfg.scale = clamp(cfg.scale + delta, 0.2, 2.4)
    saveCfg()
    place()
    showToast(Math.round(cfg.scale * 100) + '%')
  }

  function showToast(text) {
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.classList.add('dgn-show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('dgn-show')
      toastTimer = null
    }, 900)
  }

  function syncMuteBtn() {
    if (!muteBtn) return
    muteBtn.textContent = cfg.muted ? '♫̸' : '♫'
    muteBtn.setAttribute('aria-label', cfg.muted ? '开启点击音效' : '关闭点击音效')
    muteBtn.title = cfg.muted ? '已静音，点击开声' : '点击静音'
    muteBtn.classList.toggle('dgn-on', cfg.muted)
  }

  var settingsMask = null
  function openSettings() {
    if (settingsMask) return
    hideBubble()
    var previousFocus = document.activeElement
    var mask = el('div', 'dgn-settings-mask')
    settingsMask = mask
    var panel = el('section', 'dgn-settings')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', 'GPT 娘设置')
    panel.appendChild(el('h3', null, 'GPT 娘设置'))
    panel.appendChild(el('p', 'dgn-settings-subtitle', '让她按你的习惯陪伴工作'))
    var tabs = el('div', 'dgn-settings-tabs')
    tabs.setAttribute('role', 'tablist')
    var monitor = el('div'), replies = el('div')
    function tab(text, target) {
      var b = el('button', null, text)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', target === monitor ? 'true' : 'false')
      b.addEventListener('click', function () {
        monitor.hidden = target !== monitor; replies.hidden = target !== replies
        Array.prototype.forEach.call(tabs.children, function (n) { n.setAttribute('aria-selected', n === b ? 'true' : 'false') })
      })
      tabs.appendChild(b)
    }
    tab('额度监控', monitor); tab('回复信息', replies)
    panel.appendChild(tabs)
    function checkbox(text, value) {
      var label = el('label', 'dgn-setting-toggle'), input = document.createElement('input')
      input.type = 'checkbox'; input.checked = value
      label.appendChild(input); label.appendChild(document.createTextNode(' ' + text))
      monitor.appendChild(label)
      return input
    }
    var enabled = checkbox('启用 Codex 额度监控', cfg.quotaEnabled)
    var badge = checkbox('显示角色额度角标', cfg.quotaBadge)
    var intervalLabel = el('label', null, '刷新间隔（秒，15～3600） ')
    var interval = document.createElement('input')
    interval.type = 'number'; interval.min = '15'; interval.max = '3600'; interval.value = cfg.quotaInterval
    interval.setAttribute('aria-label', '刷新间隔秒数')
    intervalLabel.appendChild(interval); monitor.appendChild(intervalLabel)
    monitor.appendChild(el('p', null, '自动检测运行 DSH 的机器上的 Codex。请先在 Codex 使用 ChatGPT 账号登录。关闭监控后停止发起新的额度查询。'))
    var detectStatus = el('p', 'dgn-detect-status', '正在检测 Codex…')
    detectStatus.setAttribute('role', 'status')
    monitor.appendChild(detectStatus)
    var pathLabel = el('label', null, '手动指定 Codex 程序路径（留空使用自动检测）')
    var pathInput = document.createElement('input')
    pathInput.type = 'text'
    pathInput.style.cssText = 'box-sizing:border-box;width:100%;padding:8px;border:1px solid #aaa;border-radius:6px;background:transparent;color:inherit'
    pathInput.placeholder = '例如 C:\\Users\\用户名\\…\\codex.exe 或 /opt/homebrew/bin/codex'
    pathInput.setAttribute('aria-label', 'Codex 程序路径')
    pathLabel.appendChild(pathInput); monitor.appendChild(pathLabel)
    var detectionActions = el('div', 'dgn-detection-actions')
    monitor.appendChild(detectionActions)
    var detectBusy = false
    function detectionButton(text, fn) {
      var b = el('button', null, text); b.type = 'button'
      b.addEventListener('click', fn); detectionActions.appendChild(b)
      return b
    }
    function renderDetection(j) {
      detectStatus.textContent = (j.detected ? '已检测到 Codex' : '未检测到 Codex，请手动填写程序路径') +
        ' · ' + (j.platform || '') + ' / ' + (j.arch || '') +
        (j.source === 'manual' ? ' · 手动指定' : ' · 自动检测') +
        (quota && quota.queryOk ? ' · 额度查询成功 · ' + (quota.planLabel || '') : '')
    }
    function detect(save) {
      if (detectBusy) return
      detectBusy = true
      detectStatus.textContent = save ? '正在保存并检测路径…' : '正在检测 Codex…'
      var options = { credentials: 'same-origin' }
      if (save) { options.method = 'POST'; options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify({ path: pathInput.value.trim() }) }
      fetch(PREFIX + '/detection.json', options)
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '检测失败'); return j }) })
        .then(function (j) { if (!save) pathInput.value = j.configuredPath || ''; renderDetection(j) })
        .catch(function (err) { detectStatus.textContent = err.message || '检测失败，请检查路径' })
        .finally(function () { detectBusy = false })
    }
    detectionButton('重新检测', function () { detect(false) })
    detectionButton('保存路径并检测', function () { detect(true) })
    detectionButton('刷新额度', function () {
      if (!enabled.checked) { detectStatus.textContent = '先启用并保存额度监控，再刷新额度'; return }
      detectStatus.textContent = '正在查询额度…'
      fetch(API + '?refresh=1', { credentials: 'same-origin' }).then(function (r) { return r.json() }).then(function (j) {
        quota = j; paintBadge()
        detectStatus.textContent = j.queryOk ? '额度查询成功 · ' + (j.planLabel || '') + ' · ' + (relTime(j.observedAt) || '刚刚更新') : (j.error || '额度查询失败，请检查 Codex 登录状态')
      }).catch(function () { detectStatus.textContent = '额度服务连接失败' })
    })
    monitor.appendChild(el('p', null, '手动路径单独点击“保存路径并检测”应用，保存在当前 DSH 的本机配置中；留空保存恢复自动检测。检测确认程序存在，刷新额度验证登录与接口。'))
    detect(false)
    var label = el('label', null, '回复信息（每行一句，直接添加、修改或删除）')
    var input = el('textarea')
    input.maxLength = 20000
    function builtinText() { return quotes.map(function (q) { return q.text }).join('\n') }
    input.value = cfg.repliesEdited ? cfg.customQuotes : builtinText() + (cfg.customQuotes ? '\n' + cfg.customQuotes : '')
    input.setAttribute('aria-label', '回复信息，每行一句')
    label.appendChild(input); replies.appendChild(label)
    replies.appendChild(el('p', null, '未编辑时显示全部内置语录；保存后只使用编辑框中的句子。留空将不显示回复文字。设置只存本地，不上传。'))
    replies.hidden = true
    panel.appendChild(monitor); panel.appendChild(replies)
    var actions = el('div', 'dgn-settings-actions')
    function close() {
      document.removeEventListener('keydown', onSettingsKey, true)
      mask.remove()
      settingsMask = null
      if (previousFocus && previousFocus.isConnected) previousFocus.focus()
    }
    function onSettingsKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      if (e.key === 'Tab') {
        var items = Array.prototype.filter.call(panel.querySelectorAll('textarea,input,button'), function (n) { return n.getClientRects().length > 0 })
        var first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    function button(text, fn) {
      var b = el('button', text === '保存' ? 'dgn-primary' : '', text)
      b.type = 'button'
      b.addEventListener('click', fn)
      actions.appendChild(b)
    }
    button('恢复内置回复', function () { tabs.children[1].click(); input.value = builtinText(); input.focus() })
    button('取消', close)
    button('保存', function () {
      cfg.customQuotes = input.value.split(/\r?\n/).map(function (s) { return s.trim() }).filter(Boolean).slice(0, 200).map(function (s) { return s.slice(0, 500) }).join('\n')
      cfg.customQuotesOnly = true
      cfg.repliesEdited = true
      cfg.quotaEnabled = enabled.checked
      cfg.quotaBadge = badge.checked
      cfg.quotaInterval = clamp(Number(interval.value) || 60, 15, 3600)
      hideBubble()
      paintBadge()
      if (cfg.quotaEnabled) load(false)
      saveCfg()
      lastQuote = pickQuote()
      close()
      showToast('设置已保存')
    })
    panel.appendChild(actions)
    mask.appendChild(panel)
    mask.addEventListener('click', function (e) { if (e.target === mask) close() })
    document.addEventListener('keydown', onSettingsKey, true)
    document.body.appendChild(mask)
    tabs.querySelector('button').focus()
  }

  function buildTools() {
    toolsEl = document.createElement('div')
    toolsEl.className = 'dgn-tools'

    function mkBtn(label, title, act, wide) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'dgn-tbtn' + (wide ? ' dgn-tbtn-w' : '')
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        e.preventDefault()
        act(b)
      })
      return b
    }

    toolsEl.appendChild(mkBtn('−', '缩小（也可 Shift+滚轮）', function () { zoomBy(-0.08) }))
    toolsEl.appendChild(mkBtn('+', '放大（也可 Shift+滚轮）', function () { zoomBy(+0.08) }))
    muteBtn = mkBtn('♫', '点击切换点击提示音', function () {
      cfg.muted = !cfg.muted
      saveCfg()
      syncMuteBtn()
      if (!cfg.muted) play('release')     // 开声时立刻叫一声，确认音量
    })
    toolsEl.appendChild(muteBtn)
    toolsEl.appendChild(mkBtn('刷新', '立即刷新额度', function () {
      load(true)
      showToast('刷新中…')
    }, true))

    toolsEl.appendChild(mkBtn('设置', '额度监控与回复信息', openSettings, true))

    toastEl = document.createElement('div')
    toastEl.className = 'dgn-toast'

    rootEl.appendChild(toolsEl)
    rootEl.appendChild(toastEl)
    syncMuteBtn()
  }

  // ── 组装 DOM ──────────────────────────────────────────────────────────
  function build() {
    rootEl = document.createElement('div')
    rootEl.className = 'dgn-root'
    rootEl.style.opacity = '0'

    charEl = document.createElement('div')
    charEl.className = 'dgn-char dgn-idle'

    imgEl = document.createElement('img')
    imgEl.className = 'dgn-img'
    imgEl.src = IMG
    imgEl.alt = 'GPT 娘'
    imgEl.draggable = false
    imgEl.addEventListener('load', function () { buildAlphaMap() })

    badgeEl = document.createElement('span')
    badgeEl.className = 'dgn-badge'
    badgeEl.textContent = '…'

    var artEl = document.createElement('div')
    artEl.className = 'dgn-art'
    artEl.appendChild(imgEl)
    charEl.appendChild(artEl)
    charEl.appendChild(badgeEl)

    bubbleEl = document.createElement('div')
    bubbleEl.className = 'dgn-bubble'
    bubbleEl.style.display = 'none'

    rootEl.appendChild(bubbleEl)
    rootEl.appendChild(charEl)
    document.body.appendChild(rootEl)

    buildTools()
    bindDrag()
    bindBubble()

    // 工具条与立绘共享悬停生命周期；短暂离开容错，跨越间隙不闪退。
    var hoverTimer = null
    function enterTools() {
      clearTimeout(hoverTimer)
      rootEl.classList.add('dgn-hover')
    }
    function leaveTools(e) {
      if (e.relatedTarget instanceof Node && rootEl.contains(e.relatedTarget)) return
      clearTimeout(hoverTimer)
      hoverTimer = setTimeout(function () { rootEl.classList.remove('dgn-hover') }, 280)
    }
    rootEl.addEventListener('mouseenter', enterTools)
    charEl.addEventListener('mouseenter', enterTools)
    toolsEl.addEventListener('mouseenter', enterTools)
    rootEl.addEventListener('mouseleave', leaveTools)
    toolsEl.addEventListener('mouseleave', leaveTools)
  }

  // ── 拖动 / 点击（whale 同款：位移超过阈值才算拖动）────────────────────
  function bindDrag() {
    var dragging = false
    var moved = false
    var startX = 0, startY = 0
    var originLeft = 0, originTop = 0
    var THRESHOLD = 4

    charEl.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // 透明像素不接管：把点击让给下层
      if (!hitsArtwork(e.clientX, e.clientY)) {
        charEl.style.pointerEvents = 'none'
        var under = document.elementFromPoint(e.clientX, e.clientY)
        charEl.style.pointerEvents = ''
        if (under && under !== charEl && !rootEl.contains(under)) {
          try {
            under.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
            }))
          } catch (err) { /* ignore */ }
        }
        return
      }
      dragging = true
      dragInProgress = true
      moved = false
      startX = e.clientX; startY = e.clientY
      var r = charEl.getBoundingClientRect()
      originLeft = r.left; originTop = r.top
      charEl.classList.add('dgn-dragging')
      charEl.classList.remove('dgn-idle')
      try { charEl.setPointerCapture(e.pointerId) } catch (err) { /* ignore */ }
      play('press')
      e.preventDefault()
    })

    charEl.addEventListener('pointermove', function (e) {
      if (!dragging) return
      var dx = e.clientX - startX
      var dy = e.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return
      moved = true
      var size = baseSize()
      var vw = window.innerWidth, vh = window.innerHeight
      var left = clamp(originLeft + dx, 0, Math.max(0, vw - size))
      var top = clamp(originTop + dy, 0, Math.max(0, vh - size))
      rootEl.style.left = Math.round(left) + 'px'
      rootEl.style.top = Math.round(top) + 'px'
      updateFacing(left, size)
      if (bubbleMode) placeBubble()
    })

    function endDrag(e) {
      if (!dragging) return
      dragging = false
      dragInProgress = false
      charEl.classList.remove('dgn-dragging')
      charEl.classList.add('dgn-idle')
      try { charEl.releasePointerCapture(e.pointerId) } catch (err) { /* ignore */ }
      play('release')
      if (moved) {
        var r = charEl.getBoundingClientRect()
        savePos(r.left, r.top)
        place()          // 摆到自由位置后不再受"左边距"约束，尺寸即时回到用户设定值
      } else {
        tapBubble()
      }
    }

    charEl.addEventListener('pointerup', endDrag)
    charEl.addEventListener('pointercancel', function (e) {
      if (!dragging) return
      dragging = false
      dragInProgress = false
      charEl.classList.remove('dgn-dragging')
      charEl.classList.add('dgn-idle')
      try { charEl.releasePointerCapture(e.pointerId) } catch (err) { /* ignore */ }
    })

    // 连点只触发点击反馈。复位必须明确点击工具条按钮，避免双击误清位置。
    charEl.addEventListener('dblclick', function (e) {
      e.preventDefault()
      e.stopPropagation()
    })

    // 缩放：必须按住修饰键，否则滚轮正常穿透去滚消息列表
    // （不劫持普通滚轮 —— 鼠标扫过挂件时页面该滚还是得滚）
    charEl.addEventListener('wheel', function (e) {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      cfg.scale = clamp(cfg.scale + (e.deltaY < 0 ? 0.03 : -0.03), 0.2, 2.4)
      saveCfg()
      place()
    }, { passive: false })
  }

  function bindBubble() {
    // 点气泡本身：语录页 → 换一句；额度页不动（刷新按钮自己处理）
    bubbleEl.addEventListener('click', function (e) {
      e.stopPropagation()
      if (bubbleMode === 'quote') {
        lastQuote = pickQuote() || lastQuote
        paintBubble()
      }
    })
  }

  // 点空白处 / Esc 收起气泡
  function onDocDown(e) {
    if (!bubbleMode || !rootEl) return
    if (e.target instanceof Node && rootEl.contains(e.target)) return
    hideBubble()
  }
  function onKey(e) {
    if (bubbleMode && (e.key === 'Escape' || e.keyCode === 27)) hideBubble()
  }

  // ── 启动 ──────────────────────────────────────────────────────────────
  var raf = null
  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(function () { raf = null; place() })
  }

  function init() {
    injectStyle()
    freePos = loadPos()
    build()
    preloadAudio()
    loadQuotes()
    load(false)
    paintBadge()
    place()
    rootEl.style.opacity = '1'

    var lastPoll = Date.now()
    setInterval(function () {
      if (cfg.quotaEnabled && Date.now() - lastPoll >= clamp(cfg.quotaInterval, 15, 3600) * 1000) { lastPoll = Date.now(); load(false) }
    }, 1000)

    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', schedule, true)
    window.addEventListener('scroll', schedule, true)
    // 输入框随内容长高 / 布局变化：低频重算（拖过之后不再跟随）
    setInterval(function () { if (!freePos) place() }, 600)
  }

  function tryStart() {
    if (started) return true
    try {
      if (isChatRoot(document.getElementById('root') || document.body)) {
        started = true
        try { init() } catch (e) { started = false }
        return true
      }
    } catch (e) { /* ignore */ }
    return false
  }

  if (!tryStart()) {
    var obs = new MutationObserver(function () {
      if (tryStart() && obs) { obs.disconnect(); obs = null }
    })
    try {
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true })
    } catch (e) { /* ignore */ }
    window.addEventListener('hashchange', tryStart)
  }
})()
