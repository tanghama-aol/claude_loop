# claude_loop

一个本地零外部依赖的 Node Web 应用，用于配置 Gemini、Claude、Codex 等 Agent Profile，并循环执行 Markdown 任务文件。

## 功能

- 多提供者 Profile：每个 Profile 可配置 Anthropic、OpenAI、Google、Replicate、fal.ai、Runway、Stability AI 或自定义提供者，并声明文本、图片、视频输入/输出能力。
- 任务文件生成与编辑：创建任务时可调用生成 Profile 写入 Markdown 目标文件，也可载入已有文件或导入本地文件。
- 多模态任务：图片和视频任务可配置产物目录、文件名、格式、比例、分辨率、时长和参考文件，生成成功后在运行页直接预览。
- 循环执行：每轮命令返回后检查任务文件中的连续双完成标志，命中即停止；兼容输出中的连续双标志，保留 `429` 等待、`任务完成` 继续、连续 3 次无变化停止规则。
- 日志监控：每个任务独立日志，记录真实 Prompt、Agent 激活、PID、输出流和退出统计。
- 多目录隔离：任务只能选择已登记的工作目录，不同任务独立启动和停止。
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

## Profile 的默认工作目录

Profile 上的「默认工作目录」只用于 Ping：Ping 会真的启动一次 Agent 进程，这个字段决定它在哪个目录里运行。普通任务使用的是项目/任务的目录，与它无关。

- **相对路径**按服务根目录解析，例如默认值 `default_work_dir` 表示 `<项目目录>/default_work_dir`，因此状态文件在不同机器之间搬动时不会指向失效的绝对路径。相对路径在 Ping 前按需创建，且必须位于项目目录内。
- **绝对路径**按原样使用，不会被创建；目录缺失时 Ping 会直接报「工作目录不存在：…」，不会再表现为 `spawn … ENOENT`。
- 留空等同内置默认值 `default_work_dir`。字段可在 Profile 编辑表单中修改，也会显示在 Profile 卡片上。

历史状态文件里保存的绝对路径不会被自动改写，需要在界面上逐个改成相对路径（或改成仍然存在的绝对路径）。

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

只有所有子任务完成且父任务的完成标准已满足，才将父任务勾选为 `- [x]`，并写入 `状态：FINISHED`。有剩余步骤时保留父任务的未完成状态；成功完成子任务后仍输出“任务完成”，供循环继续下一步。计划在执行前准备，本轮成功后随执行记录写入任务文件；失败时不修改任务文件，并输出错误。

所有父任务和子任务均已完成并验证后，Agent 须在任务文件末尾另起一行写入 `GGGG全部完成GGGG` 两遍，中间没有空格、换行或其他字符，已有结束标志行不重复添加；回复中同样连续输出两遍。执行规则和未完成任务只描述该格式，不能提前写入完整的连续双标志。

每次文本任务的 Agent 命令返回后，运行器读取任务文件；包含连续双标志即进入 `all_done`、结束日志并释放目录队列，不再安排下一轮，即使命令没有输出标志、返回非零退出码或输出含有 `429`。缺失或不可读的文件不视为完成，继续按输出和重试规则处理。兼容仅在命令输出中返回连续双标志的旧 Profile；媒体任务仍须生成实际产物。追加新任务项时会移除旧的完整结束标志并恢复可执行状态，保留已有任务及执行记录。

Agent 生成模式会要求直接写出具体方案与步骤；本地模板和追加任务项提供同一套结构，由执行 Agent 在开始工作时细化。追加任务只按父任务编号递增，子任务编号和代码块中的示例不参与计数。旧版内置默认 Prompt 会自动升级；用户修改过的自定义 Prompt 保留原文，可参照以上规则自行调整。

## 删除与去重

任务列表中的“删除”和运行页的“删除任务”仅移除任务记录及其事件流引用，目标 Markdown、日志、媒体产物和归档文件保留在磁盘上。运行、排队、预约或等待重试的任务需先停止，仍有 Agent 进程未退出时也不能删除。

创建任务时按规范化后的目标文件完整路径去重（包括目录符号链接别名），重复请求返回原任务并带有 `deduplicated: true`，不会覆盖目标文件或再次调用生成 Agent。“覆盖同名文件”只适用于尚未登记为任务的文件。不同路径的同名任务仍可分别创建。

任务列表的“一键去重”清理未归档任务的重复记录：优先保留活动任务，其次保留有执行记录的任务，再按创建时间保留最早的记录。活动中的重复任务会跳过，归档任务不参与去重。被清理任务的文件和日志同样保留。接口如下：

```text
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

打开任务列表中的“日志”即可进入运行视图。运行视图会按时间线区分阶段、Profile/Agent、命令与 Prompt、stdout、stderr/错误、重试/Profile 切换、停止和最终结果；历史任务从上述文件读取完整过程，运行下拉框可切换同一任务的不同 `runId`。实时轮询使用 `after` 游标增量读取，向上滚动查看旧内容时会暂停自动跟随，点击“跟随最新”可恢复。

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
