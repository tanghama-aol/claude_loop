# claude_loop

一个本地零外部依赖的 Node Web 应用，用于配置 Gemini、Claude、Codex 等 Agent Profile，并循环执行 Markdown 任务文件。

## 功能

- 多提供者 Profile：每个 Profile 可配置 Anthropic、OpenAI、Google、Replicate、fal.ai、Runway、Stability AI 或自定义提供者，并声明文本、图片、视频输入/输出能力。
- 任务文件生成与编辑：创建任务时可调用生成 Profile 写入 Markdown 目标文件，也可载入已有文件或导入本地文件。
- 多模态任务：图片和视频任务可配置产物目录、文件名、格式、比例、分辨率、时长和参考文件，生成成功后在运行页直接预览。
- 循环执行：保留 `429` 等待、`任务完成` 继续、`GGGG全部完成GGGG` 退出、连续 3 次无变化停止规则。
- 日志监控：每个任务独立日志，记录真实 Prompt、Agent 激活、PID、输出流和退出统计。
- 多目录隔离：任务只能选择已登记的工作目录，不同任务独立启动和停止。

## 运行 Web 应用

```bash
npm start
```

默认访问地址：

```text
http://127.0.0.1:3000
```

服务默认绑定 `0.0.0.0:3000`（所有网卡），但 `0.0.0.0` 是监听地址，不是浏览器访问目标。本机请使用上面的 `127.0.0.1`；局域网设备请将 `127.0.0.1` 换成本机实际局域网 IP，并确认本机网络和防火墙允许该端口访问。

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
curl -X POST http://127.0.0.1:3000/api/tasks/<taskId>/items \
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
