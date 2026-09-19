# claude_loop

一个本地零外部依赖的 Node Web 应用，用于配置 Gemini、Claude、Codex 等 Agent Profile，并循环执行 Markdown 任务文件。

## 功能

- 多提供者 Profile：每个 Profile 可配置 Anthropic、OpenAI、Google、Replicate、fal.ai、Runway、Stability AI 或自定义提供者，并声明文本、图片、视频输入/输出能力。
- 任务文件生成与编辑：创建任务只保存信息、不调用大模型。需求来源有四种：直接输入任务列表（每行一个任务项，写入模板）、输入原始需求稍后由大模型生成（保存后到运行页点击「生成目标文件」）、载入工作目录已有文件、从电脑导入文件。
- 多模态任务：图片和视频任务可配置产物目录、文件名、格式、比例、分辨率、时长和参考文件，生成成功后在运行页直接预览。
- 循环执行：任务文件是唯一凭据。每轮生成 `任务+<uuid>` 凭据注入 Prompt，命令返回后只读任务文件：含连续双完成标志即停止；含本轮凭据算成功，至少 2 分钟后继续；否则视为失败，按 2 分钟起指数退避（上限 1 小时）并切换 Profile，连续 6 次失败停止。回复文本中的 `任务完成` 或完成标志不再参与判定。
- 日志监控：每个任务独立日志，记录真实 Prompt、Agent 激活、PID、输出流和退出统计。
- 多目录隔离：任务只能选择已登记的工作目录，不同任务独立启动和停止。
- 运行页任务 tab：运行中、排队、预约或等待重试的任务会在运行页顶部按 tab 列出，点击即可切换到对应任务的控制面板、目标文件与日志。
- 任务删除与去重：任务列表和运行页支持删除；创建时自动复用同一目标文件的任务，也可一键清理已有重复记录。

## 运行 Web 应用

```bash
npm start
```

默认访问地址：

```text
http://127.0.0.1:13100
```

服务默认绑定 `0.0.0.0:13100`（所有网卡），但 `0.0.0.0` 是监听地址，不是浏览器访问目标。本机请使用上面的 `127.0.0.1`；局域网设备请将 `127.0.0.1` 换成本机实际局域网 IP，并确认本机网络和防火墙允许该端口访问。

可以通过 `HOST` 和 `PORT` 覆盖监听配置：

```bash
HOST=127.0.0.1 PORT=3100 npm start
```

Windows PowerShell 自定义端口：

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "3100"
npm start
```

运行数据保存在 `.claude-loop-data/`，该目录默认不提交。

### 终端日志

服务会把运行详情打印到启动它的终端，每行格式为
`[ISO 时间] [级别] [作用域] 消息 key=value ...`，便于直接观察或用 `grep` 过滤。
作用域包括 `server`（启动/监听/关闭）、`server:http`（每个请求的方法、路径、状态码、耗时、来源地址）、
`server:task`（任务事件：开始、排队、重试、切换 Profile、完成、停止）、`server:agent`（Agent 子进程启动、
首次输出、退出码、耗时、stdout/stderr 内容）、`server:ping`（Ping 调度与结果）、`server:state`（state.json 写入与损坏回退）。

用 `LOG_LEVEL` 控制详细程度（`debug` / `info` / `warn` / `error` / `silent`，默认 `info`）：
`info` 打印任务与 Agent 生命周期、写操作请求与 Ping 结果；`debug` 额外打印 `GET` 轮询、state.json 写入和
Agent 的 stdout/stderr 原文（单行截断到 400 字符）。`warn`/`error` 级别的行写到 stderr，其余写到 stdout。

```bash
LOG_LEVEL=debug npm start
```

## Profile 的默认工作目录

Profile 上的「默认工作目录」只用于 Ping：Ping 会真的启动一次 Agent 进程，这个字段决定它在哪个目录里运行。普通任务使用的是项目/任务的目录，与它无关。

- **相对路径**按服务根目录解析，例如默认值 `default_work_dir` 表示 `<项目目录>/default_work_dir`，因此状态文件在不同机器之间搬动时不会指向失效的绝对路径。相对路径在 Ping 前按需创建，且必须位于项目目录内。
- **绝对路径**按原样使用，不会被创建；目录缺失时 Ping 会直接报「工作目录不存在：…」，不会再表现为 `spawn … ENOENT`。
- 留空等同内置默认值 `default_work_dir`。字段可在 Profile 编辑表单中修改，也会显示在 Profile 卡片上。

历史状态文件里保存的绝对路径不会被自动改写，需要在界面上逐个改成相对路径（或改成仍然存在的绝对路径）。

## 自动 Ping 的 Profile

自动 Ping 只覆盖**显式勾选**的 Profile，未勾选的一律不参与，不再默认对所有 Claude Code / Codex Profile 生效。

- 名单保存在 `state.json` 的 `pingSettings.profileIds`，是自动 Ping 的唯一真相；Profile 上的 `pingEnabled` 只是它的派生视图，用于卡片显示与编辑表单回显。
- 入口有两个，改的都是同一份名单：Ping 页的「自动 Ping 的 Profile」勾选区（含「已勾选 n/m」计数），以及 Profile 编辑表单里的「加入自动 Ping」勾选框。
- 只接受可 Ping 的 Profile：类型为 `claude`、`claudecode` 或 `codex`，且 Profile 本身处于启用状态；`gemini`、`custom` 等类型即使出现在名单里也会被跳过。
- 新建 Profile 默认不加入名单，需要在 Ping 页或编辑表单中主动勾选；用 `POST /api/profiles` 编辑已有 Profile 时不传 `pingEnabled`，则保持原有名单状态不变。
- 状态文件里不存在的 Profile ID、以及被删除 Profile 的 ID，会在读取状态时自动从名单中清理。
- 手动「测试连接」（`POST /api/profiles/:id/ping`）不受名单限制；Ping 页的「立即 Ping」（`POST /api/pings/run`）与定时调度都只 Ping 名单内的 Profile。
- 旧版 `state.json` 没有 `profileIds` 字段：首次读取时按原有 `pingEnabled`（未显式关闭即为参与）迁移，因此升级前已配置的自动 Ping 行为保持不变。

接口示例：

```text
POST /api/pings/settings
{ "enabled": true, "profileIds": ["profile_claude_default", "profile_codex_default"] }
```

两个字段都可单独提交：只传 `profileIds` 会更新名单并保留全局开关，只传 `enabled` 会切换总开关并保留名单；`profileIds` 不是数组时返回 `400`。

## 任务计划与完成状态

默认文本任务 Prompt 要求在每条父任务下填写详细方案（实现方式、涉及文件或模块、依赖与验证方法），并按执行顺序列出可验证的开发步骤。每轮执行一条未完成子任务，成功并验证后将该条 Markdown todo 从 `- [ ]` 改为 `- [x]`，记录改动和验证结果。例如：

```markdown
- [ ] 1. 支持任务搜索
  - 状态：进行中
  - 完成标准：按标题过滤任务，清空搜索后恢复完整列表。
  - 详细方案：在 public/index.html 增加搜索框，在 public/app.js 按标题过滤任务；复用现有任务列表，验证输入和清空两种情况。
  - 开发步骤：
    - [x] 1. 确认任务列表渲染入口和标题字段。
    - [ ] 2. 增加搜索输入和过滤逻辑。
    - [ ] 3. 验证搜索、无匹配结果和清空输入。
  - 执行记录：已确认列表渲染入口和标题字段。
```

只有所有子任务完成且父任务的完成标准已满足，才将父任务勾选为 `- [x]`，并写入 `状态：FINISHED`。有剩余步骤时保留父任务的未完成状态；成功完成子任务后必须在执行记录下另起一行写入 `任务+<uuid>：<结果描述>`（uuid 由本轮 Prompt 给出），供循环判定本轮成功并继续下一步。计划在执行前准备，本轮成功后随执行记录写入任务文件；失败时不修改任务文件，不写入凭据，并输出错误。

所有父任务和子任务均已完成并验证后，Agent 须在任务文件末尾另起一行写入 `GGGG全部完成GGGG` 两遍，中间没有空格、换行或其他字符，已有结束标志行不重复添加；回复中同样连续输出两遍。执行规则和未完成任务只描述该格式，不能提前写入完整的连续双标志。

每次文本任务的 Agent 命令返回后，运行器只读取任务文件：包含连续双标志即进入 `all_done`、结束日志并释放目录队列，不再安排下一轮，即使命令返回非零退出码或输出含有 `429`；包含本轮凭据即 `completed`，至少等待 2 分钟再开下一轮；两者都没有则本轮失败，`retry_wait` 的等待时间按连续失败次数从 2 分钟起翻倍（上限 1 小时），并在日志中标明原因（任务文件未改动 / 已改动但缺少凭据 / 429 / 无媒体产物），连续 6 次失败后停止。回复文本中的任何标志都不再作为完成依据。缺失或不可读的文件不视为完成。媒体任务仍须生成实际产物。追加新任务项时会移除旧的完整结束标志并恢复可执行状态，保留已有任务及执行记录。

两次 Agent 请求之间至少间隔 2 分钟：手动停止后立即重启或服务重启恢复的任务，距上次 Agent 结束不足 2 分钟时会先记录 `rate_limit_wait` 再启动。Profile 的超时默认 7200 秒（旧配置中的 1800 会自动迁移）。命令为 `claude` 且未指定 `--output-format` 时，任务循环自动加上 `--verbose --output-format stream-json`，把事件流实时渲染为 `[system]` / `[tool_use]` / `[tool_result]` / `[result]` 等可读行，用户在运行中就能看到 Agent 在做什么；纯 `-p` 模式要到整轮结束才有输出。

Agent 生成模式会要求直接写出具体方案与步骤；本地模板和追加任务项提供同一套结构，由执行 Agent 在开始工作时细化。追加任务只按父任务编号递增，子任务编号和代码块中的示例不参与计数。旧版内置默认 Prompt 会自动升级；用户修改过的自定义 Prompt 保留原文，可参照以上规则自行调整。

## 删除与去重

任务列表中的“删除”和运行页的“删除任务”仅移除任务记录及其事件流引用，目标 Markdown、日志、媒体产物和归档文件保留在磁盘上。运行、排队、预约或等待重试的任务需先停止，仍有 Agent 进程未退出时也不能删除。

总览和运行页都有「运行统计」区块：每轮 Agent 结束后记录一条 cycle（起止时间、耗时、成功与否及原因、Profile、token 用量、费用），磁贴展示调用轮次（成功 / 失败）、输入 / 输出 token（含缓存写 / 读）、平均调用间隔（相邻两轮 Agent 启动时刻之差）、平均单轮耗时、累计时间与预估费用，并按时间轴绘制累计费用曲线、累计输入 / 输出 token 曲线以及每轮成功（绿 ✓）/ 失败（红 ✕）的耗时柱图。token 用量取自结构化输出（Claude 的 stream-json `result` 事件、Codex 的 `--json` `turn.completed`），非结构化输出解析不到时费用按 0 计并在区块下方提示。费用统一按 Claude Fable 5.1 费率估算：输入 $10、输出 $50、缓存写 $12.5、缓存读 $0.25（每百万 token），不区分 Profile 实际使用的模型。总览展示当前活动任务，没有活动任务时展示最近运行的任务，点击区块进入运行页。每个任务最多保留 500 轮记录，日志时间线里也有对应的「本轮统计」事件。

创建任务不调用大模型。「任务来源」下拉有四项：`manual`（直接输入任务列表，每行一个任务项，请求体 `requirementMode: "manual"`，落盘为 `sourceMode: "template"`）、`agent`（只保存原始需求，`requirementMode: "agent"`，目标文件写入占位内容，`generationState: "pending"`）、`existing`、`upload`。保存后自动跳到运行页。agent 任务在运行页会看到「尚未生成目标文件」提示，「生成目标文件」成为主按钮，启动与预约按钮禁用，服务端 `POST /api/tasks/:id/start` 也会返回 400「请先生成目标文件」；生成成功后 `generationState` 变为 `generated`，失败为 `failed`（仍拦下启动）。用户手动编辑过占位文件即可启动。运行页的标签栏会把当前选中但尚未启动的任务一并列出。旧数据里没有 `generationState` 的 agent 任务视为已生成，不受影响。

任务页为左树右编辑布局：左侧是项目任务树，点击任务即在右侧编辑该任务，标题、任务需求、需求来源（仅 manual / agent 任务可切换）、所属项目、生成 Profile、执行 Profiles 和媒体产物设置修改后约 0.6 秒自动保存（`PATCH /api/tasks/:id`），状态条显示「保存中」「已自动保存 时间」或失败原因。目标文件名、工作目录、任务类型在创建后锁定，正文请在运行页或编辑页修改。运行、排队、预约、等待重试或已归档的任务只读。目标文件仍是系统写入的原样内容（占位或模板）时，改标题或需求会随之重写文件；用户改过的文件不碰。需求来源从 agent 切到 manual 且文件未改过时，按新需求生成任务列表；从 manual 切到 agent 默认只标记待生成，传 `regenerate: true` 才重写为占位内容。点击「新建任务」回到创建表单；树中的「日志」按钮仍直接跳到运行页。

创建任务时按规范化后的目标文件完整路径去重（包括目录符号链接别名），重复请求返回原任务并带有 `deduplicated: true`，不会覆盖目标文件或再次调用生成 Agent。“覆盖同名文件”只适用于尚未登记为任务的文件。不同路径的同名任务仍可分别创建。

任务列表的“一键去重”清理未归档任务的重复记录：优先保留活动任务，其次保留有执行记录的任务，再按创建时间保留最早的记录。活动中的重复任务会跳过，归档任务不参与去重。被清理任务的文件和日志同样保留。接口如下：

```text
PATCH  /api/tasks/<taskId>                  # 编辑任务信息：title / requirement / requirementMode / projectId / decomposeProfileId / runProfileIds / 媒体参数；不能改 directory、targetFileName、taskType
DELETE /api/tasks/<taskId>
POST   /api/tasks/deduplicate
```

去重接口返回 `deletedCount`、`deletedTaskIds`、`duplicates`（删除任务与保留任务的 ID 对应关系）和 `skippedCount`、`skippedTaskIds`，重复执行不会再次删除已清理的记录。

## 性能与刷新

页面只在前台轮询：有活动任务时约每 2 秒刷新，空闲时约每 5 秒刷新；每次请求完成后再安排下一次，后台标签页暂停轮询。状态接口支持 ETag，状态未变化时返回 `304`，浏览器跳过解析和重绘。页面使用 `/api/state?compact=1` 避免重复传输任务树和 Ping 历史，仅进入 Ping 页时使用 `includePings=1` 获取记录。

结构化日志按文件缓存字节位置索引，后续读取只索引追加部分，缓存中不保存整份输出文本。打开日志时默认读取最近 200 条事件，实时显示最多保留 400 条、约 512K 字符；点击“更早日志”按页回看，点击“跟随最新”返回实时输出。新输出为空时保留原来的日志 DOM，完整历史仍保存在磁盘文件中。

分页接口示例：

```text
GET /api/tasks/<taskId>/log?limit=200
GET /api/tasks/<taskId>/log?before=<firstCursor>&limit=200
GET /api/tasks/<taskId>/log?after=<nextCursor>&limit=200
```

分页响应包含 `firstCursor`、`nextCursor`、`oldestCursor`、`latestCursor`、`hasMoreBefore`、`hasMoreAfter` 和 `totalEvents`。追赶新日志时按 `nextCursor` 继续读取即可；不传 `limit` 的原有接口仍返回全部匹配事件，`full=1` 也会返回完整纯文本日志。复制按钮复制当前载入的日志页。

本次用约 27 MB、2 万条事件的合成日志做对照测试：空增量请求从约 1.4 秒降至 15 毫秒，首次页面响应从约 27 MB 降至 271 KB。结果是本机对照测量，实际耗时随日志和机器负载变化。已有服务需要重启并刷新浏览器后启用全部改动；运行中的任务应先完成或由用户停止。

## 日志、历史任务与追加任务

任务启动时就会创建日志文件，运行中的每个事件会以 UTF-8 增量写入，不需要等到 Agent 正常退出才落盘。默认目录结构如下：

```text
.claude-loop-data/
├── state.json                         # 任务、Profile、运行元数据
└── logs/
    ├── <task>.log                     # 兼容旧版的聚合纯文本日志
    ├── <task>.events.jsonl            # 聚合结构化事件（按 sequence 排序）
    ├── <task>.<run>.log               # 单次运行纯文本日志
    └── <task>.<run>.events.jsonl      # 单次运行结构化事件
```

打开任务列表中的“日志”即可进入运行视图。运行视图顶部的“已启动的任务”tab 条只列出当前已启动的任务（Agent 运行中、空闲等待、目录队列等待、已预约或等待重试），每个 tab 显示任务标题和运行态；点击 tab 与切换“任务”下拉框效果相同，会同步刷新运行控制、目标文件编辑器和日志，没有已启动任务时 tab 条自动隐藏。运行视图会按时间线区分阶段、Profile/Agent、命令与 Prompt、stdout、stderr/错误、重试/Profile 切换、停止和最终结果；历史任务从上述文件读取完整过程，运行下拉框可切换同一任务的不同 `runId`。实时轮询使用 `after` 游标增量读取，向上滚动查看旧内容时会暂停自动跟随，点击“跟随最新”可恢复。

需要通过脚本或其他客户端读取历史日志时，可使用：

```text
GET /api/tasks/<taskId>/log?runId=<runId>&after=<sequence>
GET /api/tasks/<taskId>/logs                 # 返回该任务的运行列表
GET /api/tasks/<taskId>/logs/<runId>         # 读取某一次运行
```

已结束任务可以在运行视图底部逐行或批量追加任务项。追加项会按原 Markdown 清单的最大编号顺序写入，初始状态为“未开始”，旧文件内容、旧日志和旧运行记录不会被重排或覆盖：

```bash
curl -X POST http://127.0.0.1:13100/api/tasks/<taskId>/items \
  -H 'content-type: application/json' \
  -d '{"items":["补充回归测试",{"text":"更新说明","completionCriteria":"README 已更新"}]}'
```

任务运行中、预约启动或等待重试时追加会返回 `409`；任务完成、失败或停止后追加成功会恢复为 `not_started`，只有新增项进入下一次执行。日志内容在浏览器端统一转义后再插入视图，特殊字符、Unicode、多行文本和大段输出不会被当作 HTML/脚本执行。

## 多模态提供者接入

应用仍保持零外部依赖，不把某个云厂商 SDK 固定在服务端。每个提供者通过 Profile 的命令行调用器接入；可以使用厂商 CLI、项目内 Node 脚本或其他可信可执行程序。

图片/视频任务运行时会注入统一环境变量：

```text
AGENT_PROVIDER
AGENT_MODEL
AGENT_TASK_TYPE
AGENT_OUTPUT_DIR
AGENT_OUTPUT_FILE
AGENT_OUTPUT_FORMAT
AGENT_ASPECT_RATIO
AGENT_RESOLUTION
AGENT_DURATION_SECONDS
AGENT_REFERENCE_FILES
```

参数和媒体 Prompt 模板还可使用以下占位符：

```text
{prompt} {provider} {modelName} {taskType}
{artifactDirectory} {outputFile} {outputFormat}
{aspectRatio} {resolution} {durationSeconds} {referenceFiles}
```

Token 会按提供者映射为常见环境变量，例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`REPLICATE_API_TOKEN`、`FAL_KEY`、`RUNWAYML_API_SECRET` 和 `STABILITY_API_KEY`。也可以在 Profile 的环境变量中补充厂商专有配置。

图片任务识别 `png`、`jpg`、`jpeg`、`webp`、`gif`、`avif`；视频任务识别 `mp4`、`webm`、`mov`、`mkv`、`m4v`。媒体任务只有在产物目录中出现新的对应文件后才会标记为全部完成。

## Windows 脚本版本

仓库提供 `claude_loop.ps1`，用于在 Windows PowerShell 中运行与旧 Bash 脚本等价的单文件循环：

```powershell
.\claude_loop.ps1
```

指定任务文件或 Agent 命令：

```powershell
.\claude_loop.ps1 -TaskFile ".\claude_loop_task.md" -AgentCommand "claude"
```

默认参数等价于：

```powershell
claude --dangerously-skip-permissions -p "<prompt>"
```

如需传入自定义参数：

```powershell
.\claude_loop.ps1 -AgentCommand "codex" -AgentArguments @("exec", "--skip-git-repo-check")
```

PowerShell 与 Bash 单文件循环同样在每次命令返回后优先检查文件中的连续双完成标志；输出判定也要求两遍连续标志，单个标志和旧版结束文本不再触发全部完成。

## Windows 上的 PowerShell 宿主

Profile 的命令解析到 `.ps1`（例如 nvm 生成的 `claude.ps1`、`codex.ps1`）时，服务会用 PowerShell 宿主执行它。Windows 上按以下顺序选择宿主：

1. `CLAUDE_LOOP_POWERSHELL` 环境变量；
2. PATH 中第一个可用的 `pwsh.exe`；
3. `%ProgramFiles%\PowerShell\7\pwsh.exe`（含 `7-preview`）；
4. Microsoft Store 版 `pwsh.exe` 别名（`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`）；
5. 系统自带的 Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）。

需要固定宿主时设置环境变量（值可以带引号）：

```powershell
$env:CLAUDE_LOOP_POWERSHELL = "C:\Program Files\PowerShell\7\pwsh.exe"
npm start
```

选到 `pwsh` 时，`.ps1` 会先经过数据目录下的 `powershell-utf8.ps1` 委托脚本，把宿主的输出编码固定为 UTF-8。否则 PowerShell 自身输出的中文会按 OEM 代码页（简体中文为 GBK）写出，被服务当成 UTF-8 解码而乱码；Agent 原生输出（node/CLI）本身是 UTF-8，不受影响。Windows PowerShell 5.1 在重定向输出时忽略该设置，因此回退到它时仍可能出现上述乱码。

Profile 的默认目录（或任务的 `directory`）不存在时，启动会直接给出「工作目录不存在：…」，不再表现为 `spawn … ENOENT`。

## 验证

```bash
npm run check
npm test
bash -n claude_loop.sh
```

测试使用临时工作目录和数据目录，结束后会清理，不会污染仓库中的 `.claude-loop-data/`。

## 回归与人工验收记录（2026-07-25）

- 自动化回归共 49 项：48 项通过，Windows PowerShell 专属用例在 Linux 上按平台跳过。完整生命周期用例覆盖创建/启动、命令与 Prompt、stdout/stderr、多行 Unicode、HTML 片段、16 KB 级输出、完成态、服务重启后历史读取、完成任务追加新项、再次重启及新增项状态恢复；前端回归断言确认日志文本会转义，不能注入 `<script>`。
- 使用临时数据目录启动服务并以 `agent-browser` 验收：1440×900 桌面视图可实时显示阶段、Agent 输出、错误、退出和完成事件；重启服务后历史运行下拉仍可打开完整日志；已完成任务追加表单成功写入并显示追加事件；错误输出和 `429` Profile 切换在时间线中可辨认。
- 将视口切换为 375×812 窄屏后，运行控制、追加表单和日志时间线仍可操作（导航栏按横向滚动适配）；包含 `<script>` 的 Agent 输出在 DOM 中没有脚本节点，仅作为文本显示。临时服务、浏览器会话和数据目录均已关闭并清理。

PowerShell 脚本语法检查：

```powershell
$null = [scriptblock]::Create((Get-Content -Raw .\claude_loop.ps1))
```
