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
- `lib/core.js` — 纯同步无依赖的可测试核心：`parseArgs`、`fillTemplate`、`parseEnvText`、日志事件、任务 Markdown 生成
- `lib/log-reader.js` — 字节偏移日志索引缓存 + 游标分页（不保存整份输出文本）
- `public/` — 无框架、无构建的 SPA：`index.html`(静态标记) / `styles.css` / `app.js`(全部客户端逻辑) / `i18n.js`(UMD，浏览器与 Node 测试共用)
- `test/` — `node:test`，5 个测试文件

### 状态与数据流

磁盘 `state.json` 是唯一持久化真相（v3：directories / projects / profiles / tasks / events / pingRecords）。
`saveState()` 同步原子写（`state.json.tmp` + `renameSync`）；`loadState()` 按文件签名缓存并返回 `structuredClone`；
JSON 损坏时备份为 `state.json.<ts>.broken` 并回退到初始状态。`events` 上限 200 条、`pingRecords` 上限 5000 条。

内存态（`runners`、`taskProcesses`）重启即失，但 `startPingScheduler()` / `restoreScheduledTasks()` /
`restoreQueuedTasks()` 会在 `createApp` 时恢复预约与排队任务。

前端：`public/app.js` 持有单一快照 `state.data`，全量重渲染；`api()` 是唯一的 fetch 封装（带 ETag 缓存）；
`poll()` 只在前台轮询（活动任务约 2s、空闲约 5s、日志跟随约 100ms），`/api/state` 返回 `304` 时客户端复用原快照。
状态只经 API 写入，客户端从不直接改 `state.json`。

### 枚举即契约

`STATUS`（`not_started` / `queued` / `scheduled` / `running` / `retry_wait` / `completed` / `all_done` /
`stopped` / `failed`）、`SCHEDULE_MODE`、`RUNTIME_STATE` 定义在 `server.js` 顶部并被测试直接断言 ——
改枚举值必须同步改测试与前端。

## 循环状态机（最容易改错的部分）

`runTaskLoop(taskId)` 在一次运行结束后的判定优先级：

1. `runner.stopped` → `stopped`
2. 输出含 `/429/i` → `retry_wait`，`rotateProfile()` 切到下一个可用 Profile，**5 分钟**后重试
3. 媒体任务、退出码 0、产物目录出现新文件 → `all_done`
4. 完成标记命中 → `all_done`
5. 文本任务输出含 `任务完成` → `completed`，**10 秒**后重试
6. 否则停滞检测：输出与上次相同且（文本任务文件哈希未变 / 媒体任务无新产物）→ `stallCount++`，
   连续 **3** 次 → `stopped`；未到则 `retry_wait` + `rotateProfile()` + **60 秒**

**完成标记的精确语义**：`ALL_DONE_MARKER = "GGGG全部完成GGGG"`（定义在 `lib/core.js`），
退出要求该标记**无分隔符地连续输出两遍**。单个标记、换行分隔的两个标记、以及 `全部任务完成`
都**不算**完成 —— `test/core.test.js` 有对应负例断言，修改判定逻辑前先看那些用例。

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
