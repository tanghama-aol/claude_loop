# 优化任务创建

## 背景与目标

- 工作目录：`D:\dev\git\claude_loop_on_github\claude_loop`
- 任务类型：text
- 用户需求：
  1. 任务需求分两种来源：**直接输入任务列表**（用户已写好任务项，直接保存）与 **原始需求 + 大模型生成**（用户输入原始需求，稍后点击「生成」由大模型生成任务列表）。
  2. **创建任务只负责编辑和保存任务信息，不调用大模型。** 现状：`server.js` 的 `POST /api/tasks` 在 `sourceMode === "agent"` 时会同步调用 `runTaskFileGeneration()`，创建请求被生成过程阻塞，需要移除。
  3. 在**运行界面**选择任务后再执行「生成目标文件」、「启动」，并跟踪进展；运行界面已有 `#decomposeTask`（调 `/api/tasks/:id/generate`）、`#startTask`、日志面板，需要按新流程调整可见性与提示。
- 现状锚点（供后续 Agent 定位）：
  - 后端创建路由：`server.js` `handleApi` 内 `if (method === "POST" && pathname === "/api/tasks")`（约 4706 行起）；来源归一化 `normalizeTaskSourceMode()`（约 1890 行，合法值 `agent/existing/upload/template`）；生成入口 `runTaskFileGeneration()`（约 3277 行）与 `/api/tasks/:id/(decompose|generate)` 路由（约 5163 行）。
  - 模板生成：`lib/core.js` `generateTaskMarkdown()` / `extractTaskLines()`（把需求文本逐行拆成任务项）。
  - 前端表单：`public/index.html` `#taskForm`（来源下拉 `#taskSourceMode` 只有 agent/existing/upload 三项，无 template）；`public/app.js` `syncTaskSourceMode()`（约 1421 行）、表单 submit 处理（约 1924 行）、`openTaskPage()`（约 1743 行）、`renderRuntimeContext()`（约 1139 行）、`renderRuntimeTabs()`（约 1281 行）、`#decomposeTask` 点击处理（约 2160 行）。
  - 文案：`public/i18n.js` 键 `task.source.*`、`task.sourceHelp.*`、`task.submit.*`、`runtime.generate`、`toast.taskGenerated`。
  - 测试：`test/server.test.js`（创建 agent 模式的用例在约 106–170 行，依赖 `writeAgentScript` 假 Agent 生成文件；多处用 `sourceMode: "template"`）、`test/frontend.test.js`（源码切片测试）、`test/i18n.test.js`（zh/en 键集合一致性）。
- 兼容约束：零依赖、CommonJS、4 空格缩进；`STATUS` 等枚举值不改；旧 `state.json` 中 `sourceMode: "template"` 的任务必须仍能载入与运行；不改目录隔离与重试策略。

## 任务列表

- [ ] 1. 后端：创建任务只保存信息，不调用大模型（状态：进行中）

  **详细方案**
  - 在 `server.js` 引入新的需求来源语义 `requirementMode`：`manual` = 直接输入任务列表，`agent` = 原始需求待大模型生成。为避免大改，在 `normalizeTaskSourceMode()` 中把请求里的 `requirementMode: "manual"` 映射为现有的 `sourceMode: "template"`，`requirementMode: "agent"` 映射为 `sourceMode: "agent"`；`existing` / `upload` 保持不变。任务对象新增持久化字段 `requirementMode`，`normalizeState()` 兼容旧数据：`template → manual`，`agent → agent`，其它为空串。
  - `POST /api/tasks` 的 `sourceMode === "agent"` 分支：**删除** `await runTaskFileGeneration(...)` 调用与响应中的 `generation` 字段。创建时仍要求 `requirement` 非空、`decomposeProfileId` 可用（校验保留，便于运行界面直接点「生成」）。目标文件初始化为占位 Markdown（标题 + 原始需求 + 提示「尚未生成任务列表，请在运行界面点击生成」），而不是空文件，让编辑器可见内容并便于判断「用户是否改过文件」。
  - `sourceMode === "template"`（即 manual）分支继续调用 `generateTaskMarkdown()` 把每行需求转成 todo 任务项；确认 `extractTaskLines()` 对 `- [ ]`、`1.`、纯文本行都能正确识别，必要时补充对已带 `- [ ]` 前缀行的处理（不重复加前缀）。
  - 任务对象新增 `generationState` 字段：`none`（manual / existing / upload）、`pending`（agent 模式尚未生成）、`generated`（`runTaskFileGeneration` 成功且文件变化）、`failed`。占位内容哈希保存在 `task.loop.placeholderHash`。`publicState()` 原样输出这两个字段，供运行界面判断。
  - `/api/tasks/:id/generate` 路由保持不变，但 `runTaskFileGeneration()` 成功/失败处更新 `generationState`；`beginTaskRun()` 在 `generationState === "pending"` 且目标文件哈希仍等于 `placeholderHash` 时返回 400「请先生成目标文件」（用户手动编辑过占位文件则允许启动）。
  - 验证：`npm run check && node --test test/server.test.js`；新增用例见开发步骤。

  **开发步骤**
  - [x] 1.1 `normalizeTaskSourceMode()` 支持 `requirementMode`（manual → template，agent → agent）；任务对象与 `normalizeState()` 增加 `requirementMode` / `generationState` 字段及旧数据迁移；`publicState()` 输出这两个字段。验证：server 测试「migrates legacy sourceMode into requirementMode」——写入旧格式 `state.json` 后 `GET /api/state` 中字段正确；`npm run check` 通过。
  - [x] 1.2 `POST /api/tasks` 移除 agent 模式下的 `runTaskFileGeneration` 调用，写入占位 Markdown 并记录 `loop.placeholderHash`、`generationState = "pending"`；响应保持 `{ ok: true, task }`。验证：server 测试「creating an agent task does not spawn the generation profile」——用 `writeAgentScript` 写一个会在目录里创建标记文件的假 Agent，创建后断言标记文件不存在、`task.generationState === "pending"`、目标文件含原始需求。
  - [ ] 1.3 `runTaskFileGeneration()` 成功后置 `generationState = "generated"`，失败置 `failed`；`beginTaskRun()` 对占位文件未生成的 agent 任务返回 400。验证：server 测试「start is rejected until the agent task is generated」——先 `POST /start` 得到 400，`POST /generate` 后 `generationState === "generated"`，再次 start 成功。
  - [ ] 1.4 更新 `test/server.test.js` 中依赖「创建即生成」的既有用例（约 106–170 行）：改为创建后显式调用 `/generate` 再断言；`node --test test/server.test.js` 全部通过。

  **执行记录**
  - 2026-09-19 完成 1.1：`server.js` 新增 `normalizeRequirementMode()` / `normalizeGenerationState()`，`normalizeTask()` 输出 `requirementMode`（template → manual、agent → agent、其余空串）与 `generationState`；旧 agent 任务无该字段时视为 `generated`（创建时已同步生成过，不阻塞启动），仅当 `loop.placeholderHash` 存在时才视为 `pending`；显式字段优先，非法值回退推导。`normalizeTaskSourceMode()` 支持请求里的 `requirementMode`（manual → template，agent → agent）；`POST /api/tasks` 创建的任务对象写入 `requirementMode` 与 `generationState`（agent 为 `pending`，其余 `none`）。`publicState()` 经 `...task` 展开自动输出这两个字段。
  - 验证：新增 `test/server.test.js`「server migrates legacy sourceMode into requirementMode」（写入旧格式 `state.json` 覆盖 template / agent / existing / upload / 带占位哈希 / 显式字段 / 非法值七种任务，并用 `requirementMode: "manual"` 创建任务断言映射到 `sourceMode: "template"`）；`npm run check` 通过；`npm test` 119 用例：117 通过、2 跳过（平台条件）、0 失败。
  - 2026-09-19 完成 1.2：`lib/core.js` 新增并导出 `generatePlaceholderTaskMarkdown({ title, requirement, createdAt })`，输出「标题 + 创建时间 + 『尚未生成任务列表，请在运行界面选择本任务并点击「生成目标文件」』提示 + 原始需求」，不含任务项与完成标记，并注明生成时整体替换。`server.js` `POST /api/tasks` 的 agent 分支改为写入该占位内容（原来写空文件），`task.loop` 增加 `placeholderHash`（等于创建时的 `lastHash`），**删除**创建后同步 `await runTaskFileGeneration()` 的调用与响应中的 `generation` 字段，四种来源统一响应 `{ ok: true, task }`；创建事件文案改为「创建任务（待生成目标文件）：<title>」。`requirement` 非空与生成 Profile 可用的校验保留。`runTaskFileGeneration()` 与 `/api/tasks/:id/generate` 路由未改动，生成成功后 `loop.lastHash` 更新为新哈希、`placeholderHash` 保留（供 1.3 判断是否仍为占位内容）。前端 `public/app.js` 提交处理里对 `result.generation?.failed` 的读取现在恒为 `undefined`，无副作用，留待任务 3 一并清理。
  - 验证：新增 `test/server.test.js`「server creating an agent task does not spawn the generation profile」——假 Agent 会写 `generator-invoked.txt`，用 `requirementMode: "agent"` 创建后断言：响应无 `generation` 字段、`generationState === "pending"`、等待 150ms 后标记文件不存在、目标文件含标题与两行原始需求且不含 `- [ ]` / `GGGG`、`state.json` 里 `loop.placeholderHash === loop.lastHash`、`/api/state` 输出 `pending` 与占位哈希、事件含「待生成目标文件」、`logRuns` 为空；随后显式 `POST /generate` 才调用 Profile 且 `fileChanged === true`。既有用例「server creates task files and supports editing」与「server deduplicates during generation …」已改为创建后显式调用 `/generate`（1.4 的主要内容已随本步完成，剩余在 1.3 后复核）。`npm run check` 通过；`npm test` 120 用例：118 通过、2 跳过（平台条件）、0 失败。

- [ ] 2. 后端：新增编辑任务信息接口（状态：未开始）

  **详细方案**
  - 新增路由 `PUT /api/tasks/:id`（放在 `handleApi` 的 `taskDeleteMatch` 附近，正则 `/^\/api\/tasks\/([^/]+)$/`），可编辑字段：`title`、`requirement`、`requirementMode`、`decomposeProfileId`、`runProfileIds`、`projectId`，以及媒体参数（`outputFileName` / `outputFormat` / `aspectRatio` / `resolution` / `durationSeconds` / `referenceFiles`，仅非 text 类型）。**不允许**修改 `directory`、`targetFileName`、`filePath`、`taskType`（涉及目录隔离与文件定位；要改就删除重建）。
  - 校验：任务不存在 → 404；`task.archived` → 409「归档任务为只读，不能编辑」；`task.status` 为 `running` / `retry_wait` / `queued` / `scheduled` → 409「任务运行中，停止后再编辑」；`runProfileIds` 复用 `selectUsableProfileIds()`；agent 模式复用「请选择可用的生成 Profile」校验。
  - `requirementMode` 从 `agent` 改为 `manual`：若文件哈希仍等于 `loop.placeholderHash`，用 `generateTaskMarkdown()` 按新需求重写文件并置 `generationState = "none"`；若用户已改过文件则只更新元数据。`manual` 改为 `agent`：仅置 `generationState = "pending"`，`body.regenerate === true` 时才把文件重写为占位内容并更新 `placeholderHash`。`requirement` 变更时同样只在文件仍为占位内容 / 模板原样（哈希等于创建时记录的 `loop.lastHash`）时重写文件。
  - 成功后 `task.updatedAt = nowISO()`、`addEvent(state, "task", id, "更新任务信息：<title>")`、`appendTaskLogEvent(task, "task_updated", …, { phase: "setup" })`、`saveState()`，响应 `{ ok: true, task }`。
  - 验证：`node --test --test-name-pattern "updates task" test/server.test.js`。

  **开发步骤**
  - [ ] 2.1 实现 `PUT /api/tasks/:id` 路由、字段白名单与状态校验。验证：server 测试「updates task metadata without touching the target file」——先 PUT `/file` 写入自定义内容，再修改 title / requirement / runProfileIds，断言 `GET /api/state` 字段更新且文件内容不变。
  - [ ] 2.2 实现 `requirementMode` 切换与占位文件重写逻辑。验证：server 测试「switching an untouched agent task to manual rewrites the file from the requirement」——断言文件出现 `- [ ]` 任务项且 `generationState === "none"`。
  - [ ] 2.3 运行中 / 归档任务拒绝编辑。验证：server 测试用假 Agent 让任务进入 `running` 后 PUT 返回 409；归档后 PUT 返回 409。

  **执行记录**
  - （待填写）

- [ ] 3. 前端：创建任务表单改为「编辑并保存任务信息」（状态：未开始）

  **详细方案**
  - `public/index.html` `#taskForm`：
    - 「任务来源」下拉 `#taskSourceMode` 改为四项：`manual`（直接输入任务列表）、`agent`（输入原始需求，稍后由大模型生成）、`existing`（使用工作目录文件）、`upload`（从电脑选择文件）；默认 `manual`。
    - 「任务需求」textarea 在 `manual` 模式下 label 为「任务列表（每行一个任务项）」并给出 placeholder 示例；`agent` 模式下为「原始需求」；`existing` / `upload` 模式下设为可选。
    - 「生成 Profile」字段仅在 `agent` 模式显示（沿用 `.task-generation-field`），帮助文案改为「创建时不会调用大模型，保存后到运行界面点击『生成目标文件』」。
    - 提交按钮 `#taskSubmitButton` 文案：manual / agent 为「保存任务」（`task.submit.save`），`upload` 保持「导入所选文件」，`existing` 保持「载入工作目录文件」。
    - 表单增加 `<input type="hidden" name="id">` 用于编辑模式；编辑模式下面板标题显示「编辑任务：<title>」，并提供「取消编辑」按钮 `#taskCancelEdit` 回到创建模式。
  - `public/app.js`：
    - 新增纯函数 `buildTaskRequestBody(formValues)`：把表单值映射为 API body，`requirementMode` 取 manual / agent，`sourceMode` 取 template / agent / existing / upload；供 submit 与切片测试共用。
    - `syncTaskSourceMode()` 处理四种模式的显隐、`required` 与文案。
    - submit：有 `id` 时走 `PUT /api/tasks/:id`，否则 `POST /api/tasks`；成功后 `state.selectedTaskId = task.id`、`await refresh()`、`await openTaskPage(task.id)`（跳到运行界面而非 editor）；toast 使用 `toast.taskSaved` / `toast.taskUpdated`；删除对 `result.generation` 的处理。
    - 任务列表 `[data-edit-task]` 点击改为调用新函数 `fillTaskForm(task)`：回填 title / requirement / requirementMode / profiles / 媒体参数，目录、文件名、任务类型设为 `disabled` 并给出提示；`existing` / `upload` 来源的任务编辑时来源下拉锁定为当前值；`switchView("tasks")` 并滚动到表单。
    - 新增 `resetTaskForm()`，在取消编辑与保存成功后调用。
  - `public/i18n.js`：新增 zh/en 键 `task.source.manual`、`task.sourceHelp.manual`、`task.requirement.manual`、`task.requirement.agent`、`task.submit.save`、`task.editHeading`、`task.cancelEdit`、`toast.taskSaved`、`toast.taskUpdated`；改写 `task.sourceHelp.agent`；删除不再使用的 `task.submit.generate`（`toast.taskGenerated` 运行界面仍用，保留）。zh/en 键集合必须一致。
  - `public/styles.css`：编辑模式面板头部与「取消编辑」按钮样式，沿用 `.panel-head` / `.ghost`。
  - 验证：`node --test test/frontend.test.js test/i18n.test.js`；`npm start` 手动走「manual 创建 → 运行界面可见 → 返回编辑 → 保存」。

  **开发步骤**
  - [ ] 3.1 更新 `index.html` 表单标记（四种来源、隐藏 id、编辑标题与取消按钮）与 `i18n.js` 新键。验证：`node --test test/i18n.test.js` 通过；`test/frontend.test.js` 新增正则断言 `#taskSourceMode` 含 `value="manual"` 与 `value="agent"`，且 `index.html` 不含 `task.submit.generate`。
  - [ ] 3.2 实现 `buildTaskRequestBody()`，重写 `syncTaskSourceMode()` 与 submit 处理（POST / PUT 分流、跳转运行界面、移除 generation 分支）。验证：`test/frontend.test.js` 用 `vm.runInNewContext` 切片执行 `buildTaskRequestBody`，断言 manual → `sourceMode: "template"`、agent → `sourceMode: "agent"`、`requirementMode` 正确透传。
  - [ ] 3.3 实现 `fillTaskForm()` / `resetTaskForm()` 与任务列表编辑入口。验证：`npm start` 手动点击任务卡片「编辑」，表单回填、目录与文件名锁定，保存后任务列表标题更新；结果写入执行记录。
  - [ ] 3.4 `npm run check && npm test` 全绿。

  **执行记录**
  - （待填写）

- [ ] 4. 前端：运行界面承担生成、执行与进展跟踪（状态：未开始）

  **详细方案**
  - `renderRuntimeContext(task)` 根据 `task.requirementMode` / `task.generationState` 调整控制区：
    - `generationState === "pending"`：在副标题下显示提示条 `#runtimeGenerationHint`「该任务尚未生成目标文件，请先点击『生成目标文件』」；`#decomposeTask` 改为主按钮样式（移除 `ghost`）；`#startTask` 与 `#scheduleTask` 设为 `disabled` 并加 `title` 提示；生成 Profile 下拉默认选中 `task.decomposeProfileId`。
    - `generationState === "generated"` / `"none"`：恢复现有行为；agent 模式下 `#decomposeTask` 为次要按钮（可重新生成），manual / existing / upload 模式隐藏该按钮。
    - `generationState === "failed"`：提示条显示上次生成失败，并保留生成按钮。
  - `#decomposeTask` 点击处理：生成中禁用按钮并显示「生成中…」，完成后 `await refresh()` + `loadFile()` + `loadLog()`，toast `toast.taskGenerated` / `toast.generationFailed`。生成仍走同步的 `/api/tasks/:id/generate`，不新增后台生成状态机（保持后端简单模型）。
  - 任务选择：`renderRuntimeTabs()` 目前只显示已启动过的任务，需把 `state.selectedTaskId` 对应的任务也纳入标签（即使没有 `logRuns`），否则新建任务保存后跳转运行界面看不到标签；从 `renderRuntimeTabs` 拆出纯函数 `runtimeTabTasks(tasks, selectedTaskId)` 便于切片测试。`#runTask` 下拉保持能选择所有未归档任务。
  - 进展跟踪沿用现有日志面板、状态徽章与 `poll()`，不改轮询逻辑；确认 `generationState` 变化会改变 `/api/state` 的 ETag 并触发重渲染。
  - i18n 新增 zh/en：`runtime.generationPending`、`runtime.generationFailed`、`runtime.generating`、`runtime.startNeedsGeneration`。
  - 验证：`node --test test/frontend.test.js test/i18n.test.js`；`npm start` 手动验证 agent 任务创建 → 运行界面点生成 → 文件出现任务项 → 启动按钮可用。

  **开发步骤**
  - [ ] 4.1 `renderRuntimeContext()` 增加按 `generationState` 的按钮状态与提示条；`index.html` 增加 `#runtimeGenerationHint` 容器；i18n 键补齐。验证：`test/frontend.test.js` 正则断言 `index.html` 含 `id="runtimeGenerationHint"`；`test/i18n.test.js` 通过。
  - [ ] 4.2 `#decomposeTask` 点击流程加生成中禁用与完成刷新；拆出 `runtimeTabTasks()` 并让 `renderRuntimeTabs()` 纳入当前选中但未启动的任务。验证：`test/frontend.test.js` 切片执行 `runtimeTabTasks`，断言无 `logRuns` 的选中任务也被包含；`npm start` 手动验证并写入执行记录。
  - [ ] 4.3 `npm run check && npm test` 全绿。

  **执行记录**
  - （待填写）

- [ ] 5. 文档与回归（状态：未开始）

  **详细方案**
  - `README.md`：更新「创建任务」章节，说明两种需求来源（直接输入任务列表 / 原始需求由大模型生成）、创建不调用大模型、运行界面负责生成与执行；API 清单补充 `PUT /api/tasks/:id` 并标注不可修改字段。
  - `CLAUDE.md` 与 `AGENTS.md`：在架构 / 常用锚点部分补充 `requirementMode`、`generationState`、`PUT /api/tasks/:id`，并注明「创建任务不再触发 `runTaskFileGeneration`」；两文件相关内容保持一致。
  - 回归：全量 `npm run check && npm test`；用 `npm start` 走完四种来源（manual / agent / existing / upload）各创建一次，并对 agent 任务执行生成 + 启动 + 停止，把结果写入执行记录。
  - 本任务是前四项的收尾，**必须在任务 1–4 全部勾选后才开始**。

  **开发步骤**
  - [ ] 5.1 更新 `README.md` 创建任务与 API 说明。验证：通读章节与实际行为一致。
  - [ ] 5.2 同步更新 `CLAUDE.md`、`AGENTS.md` 的锚点与约束描述。验证：两文件相关段落一致。
  - [ ] 5.3 全量回归 `npm run check && npm test`，并手动走通四种来源；在执行记录中列出测试输出摘要（通过 / 失败数）。

  **执行记录**
  - （待填写）

- [x] 6. 服务打印详细的日志到终端（状态：FINISHED）

  **详细方案**
  - 实现方式：在 `lib/core.js` 新增零依赖终端日志器 `createTerminalLogger()`（级别 debug/info/warn/error/silent、`child()` 派生作用域、行尾 key=value 字段、warn 及以上写 stderr），`server.js` 的 `createApp` 用它派生 `httpLog` / `stateLog` / `taskLog` / `agentLog` / `pingLog`，在 HTTP 请求、任务事件（`addEvent`）、Agent 生命周期与输出（`appendTaskLogEvent`）、Ping 轮次、state.json 读写、服务启动/监听/关闭等路径打印日志。
  - 级别控制：`LOG_LEVEL` 环境变量（`resolveServerConfig` 解析）或 `createApp({ logLevel })`，默认 `info`；`node --test` 下默认 `silent`，测试通过 `createApp({ logger })` 注入捕获。
  - 涉及文件：`lib/core.js`、`server.js`、`test/core.test.js`、`test/server.test.js`、`README.md`、`CLAUDE.md`、`AGENTS.md`；无新增依赖。
  - 验证方法：`npm run check && npm test` 全绿；真实启动服务并用 curl 触发 GET / POST / 404 请求，观察终端 stdout / stderr 的格式与级别。
  - 完成标准：终端可见请求、任务、Agent 子进程、Ping、状态持久化与关闭的详细日志；级别可调；文档已说明；测试覆盖。

  **开发步骤**
  - [x] 6.1 `lib/core.js` 实现并导出 `createTerminalLogger` / `formatTerminalLogLine` / `resolveTerminalLogLevel`，`test/core.test.js` 添加级别过滤、格式化、子作用域与流路由单测。
  - [x] 6.2 `server.js` 接入：`resolveServerConfig` 解析 `LOG_LEVEL`；`instrumentHttpResponse` 包装 writeHead/end 记录状态码、耗时、来源（`server.inject` 同样经过）；`addEvent` / `appendTaskLogEvent`（生命周期 info、stdout/stderr debug、错误 error）；Ping 调度与结果；state.json 写入/损坏回退；启动、监听、关闭；主进程 uncaughtException / unhandledRejection 与信号关停日志。
  - [x] 6.3 `test/server.test.js` 更新 `resolveServerConfig` 用例并新增「server prints detailed terminal logs for requests, tasks, agents and shutdown」用例。
  - [x] 6.4 `README.md` 新增「终端日志」小节，`CLAUDE.md`、`AGENTS.md` 补充 `LOG_LEVEL` 与日志结构说明。

  **执行记录**
  - 2026-09-19：完成 6.1–6.4。`npm run check` 通过；`npm test` 116 通过 0 失败（新增 core 3 例、server 1 例）。真实启动 `LOG_LEVEL=debug node server.js` 后 curl 触发 `GET /api/state`（debug，stdout）、`POST /api/pings/settings`（info，stdout）、`GET /api/tasks/nope/logs`（404 warn，stderr），输出格式 `[时间] [级别] [作用域] 消息 key=value` 符合预期。
