# GPT娘额度挂件

Tokyo · 1.5.0 · MIT 代码 / CC0 原创素材 · `dsh-gpt-niang-quota`

DSH 聊天界面的纯 DOM 陪伴挂件：角色默认位于输入框左侧，可拖动、缩放，点击切换回复气泡与 Codex 额度卡片。额度展示套餐、剩余比例与北京时间重置点，以 Codex 实际返回窗口为准。

![Tokyo 原创陪伴角色](assets/niang.png)

公开版使用独立创作的紫色龙角陪伴角色、合成音效与 12 句原创回复，不包含原应用提取的图片、音效、语录库或个人截图。

## 安装

发布并上架后，在 DSH 插件市场搜索包名，通过标准 bundle 安装并启用。也可交由 DSH 的插件管理工具安装：

```text
plugin_manager { action: "install_bundle", target: "dsh-gpt-niang-quota" }
```

启动型 profile 安装后重启 DSH。无需本地安装脚本，也无需手工编辑 profile。需要支持 `webServer`、`webserver/index-inject` 或 `tapIndex` 的 DSH 版本；聊天输入框 DOM 变化可能影响挂载与定位。

## 使用与设置

- 拖动角色移动；悬停显示缩小、放大、音效、刷新与设置按钮。Shift / Ctrl / ⌘ 加滚轮也可缩放。位置与缩放在当前浏览器中记忆。
- 单击角色在回复与额度之间切换，点击回复气泡换一句，点击空白或 Esc 收起。浏览器音频策略可能需要先进行一次用户交互；音效资源缺失时使用合成提示音。
- **设置 → 额度监控**：开启／关闭监控、控制额度角标、设置刷新间隔（15～3600 秒，默认 60 秒）。点击“保存”应用。关闭后停止新的自动查询，已在途请求仍可能完成。
- **手动程序路径**：自动检测失败时，填写运行 DSH 的机器上的 Codex 可执行文件绝对路径，单独点击“保存路径并检测”；留空保存恢复自动检测。“重新检测”仅确认文件，“刷新额度”验证登录与额度接口。手动路径失效时不会回退到其他程序。
- **设置 → 回复信息**：每行一句，直接增删改；保存后仅使用编辑框内容，留空即不显示回复。最多保存 200 句，每句 500 字；“恢复内置回复”填回发行包提供的回复，随后点击“保存”。发行包内置 12 句原创回复。

后台成功查询缓存 60 秒，即使前端间隔更短也可能得到缓存；“刷新”绕过缓存，同时进行的请求会合并。默认缩放 0.65、音量 0.4，通用提示语为“休息一下，再继续吧。”。

## 平台与账号边界

先在 Codex 中使用 ChatGPT 账号登录，并安装提供 `app-server --stdio` 的 Codex CLI／客户端。API Key 登录不提供订阅额度；不同账户或版本可能没有可展示窗口。

- macOS：检测 Codex.app、用户 daemon、PATH、Homebrew 与常见用户 bin。
- Windows：检测原生 `codex.exe`、用户 daemon、npm 原生包和可访问的 WindowsApps 布局；`.cmd` / `.bat` / `.ps1` 只用于解析固定 npm 原生路径，不通过 shell 执行。受保护目录或特殊安装位置可使用手动路径。
- Linux：检测用户 daemon、PATH 与常见用户／系统 bin。

路径发现含 x64／arm64 分支和平台虚拟文件系统测试，但不代表所有平台已完成真机验收。WSL、容器与远程 DSH 分别使用各自运行环境；浏览器所在电脑的 Codex 登录不会自动转移到 DSH 服务端。

## 隐私与本地存储

插件通过本地子进程发送 `initialize`、`account/read`（`refreshToken: false`）与 `account/rateLimits/read`，另发送初始化通知，不创建对话或请求模型生成。Codex 自身可能连接其官方服务；插件没有独立遥测或第三方上传端点。

插件不主动写入账户邮箱、账户 ID 或凭据，额度接口仅返回套餐、登录类型、额度窗口和查询状态，缓存保存在进程内存。手动程序路径保存在当前 DSH profile 的插件状态中，并通过受宿主访问控制保护的检测接口返回给设置页；本地路径仍属于隐私信息。客户端偏好、自定义回复与位置保存在当前站点的 localStorage（`dgn-cfg`、`dgn-pos`），不会由插件上传至服务端。卸载插件不会自动清除这些浏览器偏好或路径设置。

## 开发、许可与发行资源

```bash
npm run check
npm test
# 可选：Chrome 路径由 CHROME_PATH 指定；Node.js 需支持全局 WebSocket
npm run test:browser
```

源码沿用本地 gptniang-dsh，并参考 GPTNiangMac / Local GPT Niang Widget 与 dsh-whale-widget 的实现思路。保留原代码 MIT 署名；完整条款见 [LICENSE](./LICENSE)。该条款不将原应用角色、美术、音效或语录重新授权为 MIT。

原创素材（立绘、图标、合成提示音、回复文字）采用 CC0 1.0，见 [素材许可](assets/LICENSE.txt)。可编辑 SVG 源图保存在仓库中；npm 包仅包含运行所需资源。回复格式为 `{ "quotes": [{ "text": "原创回复", "weight": 1 }] }`。

首次市场收录需目录维护者审核；公开仓库、npm 发布和目录收录是分别完成的步骤。
