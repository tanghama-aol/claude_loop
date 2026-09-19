# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

零外部依赖的 Node.js 本地 Web 应用：配置 Claude / Codex / Gemini / 多模态提供者的 Profile，
循环执行 Markdown 任务文件，直到任务完成。是 `claude_loop.sh`（保留为历史参考）的 Web 化版本。

CommonJS，无构建步骤，无第三方依赖。**不要新增 dependencies** —— 零依赖是明确约束，
提供者一律通过 Profile 的命令行调用器接入。

## 常用命令

```bash
npm start                                          # http://127.0.0.1:13100（默认监听 0.0.0.0:13100）
HOST=127.0.0.1 PORT=3100 npm start                 # 覆盖监听配置
LOG_LEVEL=debug npm start                          # 终端日志级别 debug|info|warn|error|silent（默认 info）
npm run check                                      # node --check 语法检查（改动后必跑）
npm test                                           # node --test，自动发现 test/**
node --test test/core.test.js                      # 单个测试文件
node --test --test-name-pattern "parseArgs" test/core.test.js   # 按名称跑单个测试
bash -n claude_loop.sh                             # 旧 Bash 脚本语法检查
```

没有 lint / format 配置，风格靠约定维持（见「编码风格」）。

## 架构

### server.js 是单文件闭包，不是模块

`server.js` 约 5200 行，全部逻辑在 `createApp()` 的一个闭包内 —— 定位代码靠**内部函数名**，
不要指望模块边界。常用锚点：`handleApi`(路由分发)、`publicState`(状态序列化)、`runTaskLoop`(循环状态机)、
`beginTaskRun` / `enqueueTaskRun`(调度与排队)、`pingProfile`(Ping)、`loadState` / `saveState`(持久化)。

`createApp(options)` 返回普通 `http.Server` 并附加两个方法：

- `server.inject({ method, path, body, headers })` → `{ statusCode, headers, body, json() }`
- `server.closeRunners()` → 优雅关闭所有 Agent 子进程与 Ping 定时器

`options` 常用项：`rootDir`、`dataDir`、`publicDir`、`disablePingScheduler`。
模块导出 `createApp`、`STATUS`、`SCHEDULE_MODE`、`RUNTIME_STATE`、`DEFAULT_HOST/PORT` 等。

### 模块分工

- `server.js` — HTTP 服务、全部 REST 路由、任务循环状态机、子进程控制、日志落盘、Ping 调度、状态读写
- `lib/core.js` — 纯同步无依赖的可测试核心：`parseArgs`、`fillTemplate`、`parseEnvText`、日志事件、任务 Markdown 生成、`createTerminalLogger`（终端日志器）
- `lib/log-reader.js` — 字节偏移日志索引缓存 + 游标分页（不保存整份输出文本）
- `public/` — 无框架、无构建的 SPA：`index.html`(静态标记) / `styles.css` / `app.js`(全部客户端逻辑) / `i18n.js`(UMD，浏览器与 Node 测试共用)
- `test/` — `node:test`，5 个测试文件

### 终端日志

`createApp` 内部通过 `createTerminalLogger()`（`lib/core.js`）创建 `logger`，并派生 `httpLog` / `stateLog` /
`taskLog` / `agentLog` / `pingLog` 五个作用域。级别解析顺序：`options.logLevel` → 环境变量 `LOG_LEVEL` → 默认 `info`；
`node --test` 环境（`NODE_TEST_CONTEXT`）默认 `silent`，测试要断言日志时传入 `options.logger` 捕获。
HTTP 日志靠 `instrumentHttpResponse()` 包装 `writeHead` / `end` 得到状态码与耗时，`server.inject` 同样经过它。
`addEvent()` 与 `appendTaskLogEvent()` 是任务/Agent 日志的统一出口，新增事件不必单独打印。

### 状态与数据流

磁盘 `state.json` 是唯一持久化真相（v3：directories / projects / profiles / tasks / events / pingRecords）。
`saveState()` 同步原子写（`state.json.tmp` + `renameSync`）；`loadState()` 按文件签名缓存并返回 `structuredClone`；
JSON 损坏时备份为 `state.json.<ts>.broken` 并回退到初始状态。`events` 上限 200 条、`pingRecords` 上限 5000 条。

内存态（`runners`、`taskProcesses`）重启即失，但 `startPingScheduler()` / `restoreScheduledTasks()` /
`restoreQueuedTasks()` 会在 `createApp` 时恢复预约与排队任务。

任务页（`#tasks`）左树右编辑：`openTaskEditor()` / `resetTaskEditor()` 切换 `#taskForm` 的 `data-mode`（`create` / `edit`），
编辑态由 `scheduleTaskAutosave()` 去抖后 `PATCH /api/tasks/:id`（仅元数据；`TASK_EDITOR_LOCKED_FIELDS` 列出创建后锁定的字段），
后端路由拒绝忙碌 / 归档任务；文件仍等于 `loop.placeholderHash` / `loop.templateHash` 时才随标题需求重写。

**创建不调用大模型**：`POST /api/tasks` 只写文件（manual → `generateTaskMarkdown` 模板；agent → `generatePlaceholderTaskMarkdown` 占位）。
`requirementMode`（manual / agent）与 `generationState`（none / pending / generated / failed）由 `normalizeRequirementMode()` /
`normalizeGenerationState()` 从旧数据推导。`runTaskFileGeneration()` 成功置 `generated`、失败置 `failed`；
`taskAwaitingGeneration()` 在启动路由拦下「文件仍是占位内容」的 agent 任务（用户改过文件即放行）。前端 `buildTaskRequestBody()` 把表单
来源映射为请求体，`runtimeGenerationView()` 决定运行页提示 / 主按钮 / 启动禁用，`runtimeTabTasks()` 让选中任务进入标签栏。

前端：`public/app.js` 持有单一快照 `state.data`，全量重渲染；`api()` 是唯一的 fetch 封装（带 ETag 缓存）；
`poll()` 只在前台轮询（活动任务约 2s、空闲约 5s、日志跟随约 100ms），`/api/state` 返回 `304` 时客户端复用原快照。
状态只经 API 写入，客户端从不直接改 `state.json`。

### 枚举即契约

`STATUS`（`not_started` / `queued` / `scheduled` / `running` / `retry_wait` / `completed` / `all_done` /
`stopped` / `failed`）、`SCHEDULE_MODE`、`RUNTIME_STATE` 定义在 `server.js` 顶部并被测试直接断言 ——
改枚举值必须同步改测试与前端。

## 循环状态机（最容易改错的部分）

`runTaskLoop(taskId)` 在一次运行结束后的判定优先级（**任务文件是唯一凭据，回复文本不参与判定**）：

1. `runner.stopped` → `stopped`
2. 媒体任务、退出码 0、产物目录出现新文件 → `all_done`
3. 任务文件含完成标记 → `all_done`
4. 任务文件含本轮凭据 `任务+<uuid>` → `completed`，`failureStreak` 归零，**2 分钟**（`LOOP_TIMING.minRunIntervalMs`）后继续
5. 否则本轮失败：`failureStreak++`，`rotateProfile()`，等待 `failureBackoffMs()`（2 分钟起指数翻倍，上限 1 小时）
   后 `retry_wait`；连续 **6** 次（`maxConsecutiveFailures`）→ `stopped`。失败原因记入 `metadata.reason`：
   `task_file_unchanged` / `run_token_missing` / `429` / `artifact_missing`

**本轮凭据**：每轮开始 `createRunToken()` 生成 `任务+<uuid>`，经 `{runToken}` 注入 Prompt（自定义模板缺占位符时
`ensureRunTokenInstruction()` 自动追加规则段），记录在 `task.lastRunToken` 与 `run_token` 日志事件。Agent 只有把它
写进任务文件本轮才算成功；输出里的 `任务完成`、双完成标记都**不再**算数（这正是 2026-09-18 Codex 报「high demand」
退出却因 stderr 回显 Prompt 而被判成功、每 10 秒重跑 489 轮的根因）。

**最小请求间隔**：`runTaskLoop` 开头检查 `task.lastAgentEndedAt`，距上次 Agent 结束不足 2 分钟就先 `rate_limit_wait`
再启动，手动 stop/start 同样受限。测试用 `createApp({ loopTiming: { minRunIntervalMs, failureBackoffBaseMs,
failureBackoffMaxMs, maxConsecutiveFailures } })` 缩短等待，勿在测试里硬等真实间隔。

**完成标记的精确语义**：`ALL_DONE_MARKER = "GGGG全部完成GGGG"`（定义在 `lib/core.js`），
退出要求该标记**无分隔符地连续写入两遍**。单个标记、换行分隔的两个标记、以及 `全部任务完成`
都**不算**完成 —— `test/core.test.js` 有对应负例断言，修改判定逻辑前先看那些用例。

**Claude 实时输出**：命令名为 `claude` 且未自带 `--output-format` 时，`buildTaskSpawn()` 自动前置
`--verbose --output-format stream-json`（纯 `-p` 模式直到整轮结束才输出，运行超过超时值会被误杀且用户看不到过程）。
`createStreamJsonRenderer()`（`lib/core.js`）把 JSONL 事件渲染为 `[system]` / `[tool_use]` / `[tool_result]` /
`[result]` 可读行再写日志，`task.lastOutput` 也存渲染后的文本。`prepareSpawnSpecForPlatform()` 必须用 `...spawnSpec`
保留 `structuredOutput` 标记，否则 Windows 下渲染器不会启用。

**超时**：`DEFAULT_TIMEOUT_SECONDS = 7200`；`normalizeProfile()` 会把旧默认值 1800 自动迁移为 7200。

**每轮统计**：`runTaskLoop` 判定前用 `extractUsageFromOutput(rawOutput)`（`lib/core.js`）从结构化输出取 usage，
`appendTaskCycle()` 追加到 `task.cycles`（上限 `MAX_TASK_CYCLES = 500`），并写 `cycle_stats` 日志事件；`publicState` 附带
`task.stats = summarizeTaskCycles(cycles)`（轮次、成败、token、费用、平均间隔、累计时间），compact 模式只带最近 200 轮。
费用按 `FABLE_5_PRICING`（Fable 5.1：输入 10 / 输出 50 / 缓存写 12.5 / 缓存读 0.25 美元每百万 token）估算，不按 Profile 模型区分。
前端 `renderTaskStats()` 用内联 SVG 画三张图（总览 `#dashboardStats`、运行页 `#runtimeStats` 共用），配色已过 dataviz 校验。

**目录隔离**：同一目录同时只允许一个任务运行，其余进队列（`directoryActiveTask` → `enqueueTaskRun` →
`advanceDirectoryQueue` / `startNextQueuedTask`）。

## Profile、模板与环境变量

- `fillTemplate()` 同时支持 `{key}`、`${key}`、`{{key}}` 三种占位符语法，数组值按 `\n` 连接；
  `promptTemplate` / `mediaPromptTemplate` / `args` 都经过它。除通用键外还有多模态占位符
  （`{provider}` `{modelName}` `{taskType}` `{artifactDirectory}` `{outputFile}` `{outputFormat}`
  `{aspectRatio}` `{resolution}` `{durationSeconds}` `{referenceFiles}`）与中文别名 `目标任务文件`。
- `configEnvForProfile()` 把 `configDirectory` 映射为 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
  `GEMINI_CONFIG_DIR` + `GEMINI_CLI_HOME` / `AGENT_CONFIG_DIR`。
- 三个默认 Profile（`createDefaultProfiles()`）的命令带 `--dangerously-skip-permissions`、
  `--dangerously-bypass-approvals-and-sandbox` —— 这是刻意的本地免交互行为，改动前先确认。
- Ping 用真实 Agent 进程做存活探测（随机 Prompt、首个输出延迟、token 统计），仅对
  `claude|claudecode|codex` 生效。
- **自动 Ping 名单**：`state.json` 的 `pingSettings.profileIds` 是唯一真相，未列出的 Profile 一律不自动 Ping。
  Profile 上的 `pingEnabled` 是名单的派生视图（`normalizeState` / `setAutoPingProfiles` 负责同步），
  旧状态没有 `profileIds` 时按 `pingEnabled` 迁移。改判定逻辑时同步看 `test/server.test.js` 里的
  「only auto-pings the Profiles listed in pingSettings.profileIds」用例。

## Windows 特有行为

- `powershellHostPath()` 按顺序选择宿主：`CLAUDE_LOOP_POWERSHELL` → PATH 中的 `pwsh.exe` →
  ProgramFiles → Store 别名 → Windows PowerShell 5.1。选到 `pwsh` 时，`.ps1` 会先经过数据目录下生成的
  `powershell-utf8.ps1` 委托脚本强制 UTF-8；否则 PowerShell 自身输出的中文会按 OEM 代码页（简体中文为 GBK）
  写出、被当成 UTF-8 解码而乱码。回退到 5.1 时该问题依旧存在。
- `resolveWindowsCommandPath()` / `prepareSpawnSpecForPlatform()` 解析 `.cmd` / `.ps1` 垫片。
- 工作目录缺失时报「工作目录不存在：…」，而不是误导性的 `spawn … ENOENT`。

## 测试约定

- 新增**纯逻辑** → `test/core.test.js`；新增 **API 行为** → `test/server.test.js`。
- `test/server.test.js` 的既有骨架：临时 `rootDir` + `dataDir`、`t.after` 清理、`request()` 包 `server.inject`、
  `waitFor()` 轮询异步状态、`writeAgentScript()` 写假 Agent 脚本（用 `process.execPath` 指向真实文件）。
  **不要监听真实端口。**
- 平台差异用 `{ skip: process.platform !== "win32" }` 之类的条件跳过。
- `test/frontend.test.js` 是**源码切片测试**：读取 `public/app.js` 文本，用 `vm.runInNewContext` 单独执行
  某些函数（如 `escapeHtml`、`legacyLogPreview`），并正则断言 `public/index.html` 的标记。改动这些函数名或
  挪动日志转义逻辑会直接弄坏它 —— 这些用例同时是 XSS 回归防线。
- 提交前至少运行：`npm run check && npm test`。

## 编码风格

CommonJS + **4 空格缩进**。后端保持同步文件写入的简单模型，**不要引入数据库或框架**。
状态值用小写下划线（`not_started`、`retry_wait`、`all_done`）。前端选择器与 API 路径保持语义清晰
（如 `/api/tasks/:id/start`）。后端错误字符串与 UI 默认语言均为中文（zh-CN，可切英文）。

## 提交与 PR

提交信息用简洁祈使句英文，如 `Add task runtime monitor`。PR 说明行为变化、列出验证命令，
并**特别标注**对执行命令、目录隔离、重试策略或 Prompt 模板的改动 —— 这四类改动影响面最大。

## 安全

Profile 可配置高风险参数（`--dangerously-skip-permissions` 等）。不要把敏感环境变量提交到仓库，
运行时数据保存在 `.claude-loop-data/`（已 gitignore）。任务只能选择已登记的目录，但 Agent 进程本身
按本机用户权限运行 —— 配置 Profile 前确认命令可信。

## 相关文档

- `AGENTS.md` — 并行的约定文件，内容与本文档重叠（主要供其他 Agent 工具读取）
- `README.md` — 面向使用者的完整功能说明：调度、日志分页、去重、多模态接入、验收记录
