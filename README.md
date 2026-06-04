# claude_loop

一个本地 Web 应用，用于配置 Gemini、Claude、Codex 等 Agent Profile，并把 Markdown 任务文件作为执行目标循环运行。

## 功能

- 多 Agent Profile：每个 Profile 可配置命令、参数、环境变量、Prompt 模板和超时时间。
- 任务文件生成与编辑：根据用户需求生成 Markdown 目标文件，并在页面中直接编辑。
- 循环执行：保留原脚本的 `429` 等待、`任务完成` 继续、`全部任务完成` 退出、连续 3 次无变化停止规则。
- 日志监控：每个任务独立日志，运行状态实时刷新。
- 多目录隔离：任务只能选择已配置的工作目录，不同任务独立启动和停止。

## 运行

```bash
npm start
```

默认访问地址：

```text
http://127.0.0.1:3000
```

运行数据保存在 `.claude-loop-data/`，该目录默认不提交。

## 验证

```bash
npm run check
npm test
```
