# Repository Guidelines

## 项目结构与模块组织

本仓库现在是一个零外部依赖的 Node Web 应用，用于管理 Gemini、Claude、Codex 等 Agent Profile，并循环执行 Markdown 任务文件。

- `server.js`：HTTP 服务、API、任务循环、进程控制和日志写入。
- `lib/core.js`：参数解析、环境变量解析、Prompt 模板填充、任务文件生成等可测试核心逻辑。
- `public/`：前端单页应用，包含 `index.html`、`styles.css`、`app.js`。
- `test/`：Node 内置测试，覆盖核心函数和 API 行为。
- `claude_loop.sh`：原始 Bash 版本，作为历史参考保留。
- `.claude-loop-data/`：运行时状态和日志目录，已在 `.gitignore` 中排除。

## 构建、测试与开发命令

- `npm start`：启动 Web 应用，默认访问 `http://127.0.0.1:13100`。
- `PORT=3100 npm start`：使用自定义端口启动。
- `LOG_LEVEL=debug npm start`：调整终端日志级别（`debug|info|warn|error|silent`，默认 `info`；日志器在 `lib/core.js` 的 `createTerminalLogger`）。
- `npm run check`：对 `server.js`、`public/app.js`、`lib/core.js` 做语法检查。
- `npm test`：运行 Node 测试套件。
- `bash -n claude_loop.sh`：检查旧 Bash 脚本语法。

项目没有打包步骤，也不需要安装第三方依赖。

## 编码风格与命名规范

JavaScript 使用 CommonJS 和四空格缩进。后端保持同步文件写入的简单模型，避免引入数据库或框架。状态值使用小写下划线，例如 `not_started`、`retry_wait`、`all_done`。前端选择器和 API 路径应保持语义清晰，例如 `/api/tasks/:id/start`。

## 自动 Ping 名单

`state.json` 的 `pingSettings.profileIds` 决定哪些 Profile 参与自动 Ping，未列出的 Profile 不会被自动 Ping；Profile 上的 `pingEnabled` 只是该名单的派生视图。新增或修改 Ping 行为时请同步更新 `README.md` 的「自动 Ping 的 Profile」章节与 `test/server.test.js` 中的 Ping 用例。

## 测试指南

新增核心逻辑时优先补 `test/core.test.js`；新增 API 行为时补 `test/server.test.js`。测试不要监听真实端口，使用 `server.inject()` 调用接口。提交前至少运行：

```bash
npm run check
npm test
```

## 提交与 Pull Request 规范

Git 历史在当前检出环境中不可读，提交信息使用简洁祈使句，例如 `Add task runtime monitor`。PR 应说明行为变化、列出验证命令，并特别标注对执行命令、目录隔离、重试策略或 Prompt 模板的改动。

## 安全与配置提示

Agent Profile 可配置高风险参数，例如 `--dangerously-skip-permissions`。敏感环境变量不要提交到仓库；运行时数据保存在 `.claude-loop-data/`。任务只能选择已登记目录，但 Agent 进程本身仍按本机权限运行，配置 Profile 前应确认命令可信。
