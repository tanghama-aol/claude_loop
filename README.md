# claude_loop

一个本地零外部依赖的 Node Web 应用，用于配置 Gemini、Claude、Codex 等 Agent Profile，并循环执行 Markdown 任务文件。

## 功能

- 多 Agent Profile：每个 Profile 可配置命令、参数、环境变量、Prompt 模板、配置目录和超时时间。
- 任务文件生成与编辑：创建任务时可调用生成 Profile 写入 Markdown 目标文件，也可载入已有文件或导入本地文件。
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

Windows PowerShell 自定义端口：

```powershell
$env:PORT = "3100"
npm start
```

运行数据保存在 `.claude-loop-data/`，该目录默认不提交。

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
```

PowerShell 脚本语法检查：

```powershell
$null = [scriptblock]::Create((Get-Content -Raw .\claude_loop.ps1))
```
