const crypto = require("node:crypto");
const path = require("node:path");

const ALL_DONE_MARKER = "GGGG全部完成GGGG";
const ALL_DONE_OUTPUT = ALL_DONE_MARKER + ALL_DONE_MARKER;
const LEGACY_RUN_PROMPT = `1. 从 {targetFile} 获取一条任务进行工作，完成后将任务标记为完成。不要启动子 agent，直接在当前 agent 中完成。
2. 成功完成后修改 {targetFile}，失败则不修改，并输出错误。
3. 如果任务完成，则输出 "任务完成"。
4. 如果目标文件中任务全部完成，则输出 "全部任务完成"。`;
const LEGACY_RUN_PROMPT_V2 = `1. 从 {targetFile} 获取一条任务进行工作，完成后将任务标记为完成。不要启动子 agent，直接在当前 agent 中完成。
2. 成功完成后修改 {targetFile}，失败则不修改，并输出错误。
3. 如果任务完成，则输出 "任务完成"。
4. 如果目标文件中任务全部完成，则输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。`;
const TASK_PROGRESS_RULES = `- 每条父任务使用 Markdown todo 清单，初始为 - [ ]，状态为“未开始”。
- 每条父任务下必须有“详细方案”和“开发步骤”：方案说明实现方式、涉及文件或模块、依赖与验证方法；步骤按执行顺序列出，可分解为多条可独立验证的子任务。
- 子任务未完成时使用 - [ ]（todo）；每完成并验证一条，就将该条改为 - [x]（done），并在父任务下记录改动和验证结果。
- 只有所有子任务都已完成且父任务的完成标准已满足，才将父任务改为 - [x] 并将其状态标记为 FINISHED；本轮成功后仍有未完成步骤时，父任务保持 - [ ]，状态为“进行中”。
- 保留已有的有效方案、已完成勾选和执行记录；继续未完成步骤，不重复创建计划，也不把仅有方案或尚未验证的父任务标记为完成。`;
const LEGACY_RUN_PROMPT_V3 = `1. 从 {targetFile} 选择一条未完成父任务进行工作；如果已分解子任务，则本轮只执行其中一条未完成子任务。不要启动子 agent，直接在当前 agent 中完成。
2. 执行前为选中的父任务拟定详细方案和开发步骤，将通用模板细化为具体可验证的步骤。先在当前上下文中准备计划，本轮成功后再写入 {targetFile} 中该父任务下。
3. 每完成并验证一条子任务，就按下列规则更新勾选和执行记录。只有所有子任务完成并满足父任务的完成标准，才能将父任务标记为 FINISHED。
4. 仅在本轮任务或子任务成功完成并验证后修改 {targetFile}；本轮失败则不修改任务文件（包括方案、步骤、勾选和状态），并输出错误。
5. 本轮任务或子任务成功完成并写入任务文件后，输出 "任务完成"；父任务仍有未完成子任务时也输出该文本，以便下一轮继续。
6. 如果目标文件中所有父任务均已完成且没有未完成子任务（兼容历史任务的完成标记），则输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。

任务文件规则：
${TASK_PROGRESS_RULES}`;

const TASK_COMPLETION_RULES = `- 只有所有父任务及子任务均已完成并验证（兼容历史任务的完成标记），才在目标任务文件末尾另起一行写入 "${ALL_DONE_MARKER}" 两遍，中间不要有空格、换行或其他间隔；该结束标志行只写一次，并在回复中连续输出同样的标志两遍。
- 生成或追加未完成任务时，移除旧的完整结束标志，保留任务内容和执行记录；不要把连续两遍的完整结束标志写进规则、示例或未完成任务。`;
const LEGACY_RUN_PROMPT_V4 = `1. 从 {targetFile} 选择一条未完成父任务进行工作；如果已分解子任务，则本轮只执行其中一条未完成子任务。不要启动子 agent，直接在当前 agent 中完成。
2. 执行前为选中的父任务拟定详细方案和开发步骤，将通用模板细化为具体可验证的步骤。先在当前上下文中准备计划，本轮成功后再写入 {targetFile} 中该父任务下。
3. 每完成并验证一条子任务，就按下列规则更新勾选和执行记录。只有所有子任务完成并满足父任务的完成标准，才能将父任务标记为 FINISHED。
4. 仅在本轮任务或子任务成功完成并验证后修改 {targetFile}；本轮失败则不修改任务文件（包括方案、步骤、勾选和状态），并输出错误。
5. 本轮任务或子任务成功完成并写入任务文件后，输出 "任务完成"；父任务仍有未完成子任务时也输出该文本，以便下一轮继续。
6. 如果目标文件中所有父任务均已完成且没有未完成子任务（兼容历史任务的完成标记），则先在 {targetFile} 末尾按下列规则写入结束标志，再输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。

任务文件规则：
${TASK_PROGRESS_RULES}
${TASK_COMPLETION_RULES}`;
const RUN_TOKEN_PREFIX = "任务+";
const RUN_TOKEN_PATTERN = /任务\+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const RUN_TOKEN_RULES = `- 本轮执行凭据为 {runToken}。只有本轮任务或子任务成功完成并验证后，才在 {targetFile} 中该任务的执行记录下另起一行写入 "{runToken}：<本轮结果描述>"，凭据原样写入，不要改动。
- 程序只根据任务文件判断本轮结果，不读取回复文本：任务文件中没有本轮凭据即视为本轮失败。失败时不要写入凭据，也不要修改任务文件。`;
const DEFAULT_RUN_PROMPT = `1. 从 {targetFile} 选择一条未完成父任务进行工作；如果已分解子任务，则本轮只执行其中一条未完成子任务。不要启动子 agent，直接在当前 agent 中完成。
2. 执行前为选中的父任务拟定详细方案和开发步骤，将通用模板细化为具体可验证的步骤。先在当前上下文中准备计划，本轮成功后再写入 {targetFile} 中该父任务下。
3. 每完成并验证一条子任务，就按下列规则更新勾选和执行记录。只有所有子任务完成并满足父任务的完成标准，才能将父任务标记为 FINISHED。
4. 仅在本轮任务或子任务成功完成并验证后修改 {targetFile}；本轮失败则不修改任务文件（包括方案、步骤、勾选和状态），并输出错误。
5. 本轮任务或子任务成功完成并写入任务文件后，必须在该任务的执行记录下另起一行写入 "{runToken}：<本轮结果描述>"；父任务仍有未完成子任务时也照此写入，以便下一轮继续。
6. 如果目标文件中所有父任务均已完成且没有未完成子任务（兼容历史任务的完成标记），则先在 {targetFile} 末尾按下列规则写入结束标志，再输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。

任务文件规则：
${TASK_PROGRESS_RULES}
${TASK_COMPLETION_RULES}
${RUN_TOKEN_RULES}`;

const DEFAULT_MEDIA_RUN_PROMPT = `请执行一个 {taskType} 多模态生成任务，不要启动子 Agent。
根据目标任务文件和用户需求生成最终媒体产物，并将文件直接写入指定产物目录。

目标任务文件：{targetFile}
工作目录：{workingDirectory}
任务类型：{taskType}
用户需求：
{requirement}

产物目录：{artifactDirectory}
建议产物文件：{outputFile}
输出格式：{outputFormat}
画面比例：{aspectRatio}
分辨率：{resolution}
视频时长（秒）：{durationSeconds}
参考文件：
{referenceFiles}

完成标准：至少生成一个符合任务类型的文件并保存到产物目录。不要只返回外部链接或文字说明。
生成成功后输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。`;

const CODEX_AUTO_CONFIRM_FLAG = "--dangerously-bypass-approvals-and-sandbox";
// 单轮 Agent 进程的默认超时：Claude 等 CLI 一轮可能持续超过 30 分钟，过短会误杀正常运行。
const DEFAULT_TIMEOUT_SECONDS = 7200;
// 循环调度约束：两次请求间隔不少于 2 分钟；失败轮次按 2 分钟起步指数退避，上限 1 小时；连续失败达到上限后停止。
const LOOP_TIMING = Object.freeze({
    minRunIntervalMs: 120000,
    failureBackoffBaseMs: 120000,
    failureBackoffMaxMs: 3600000,
    maxConsecutiveFailures: 6,
});
const DEFAULT_CODEX_ARGS = `exec --skip-git-repo-check ${CODEX_AUTO_CONFIRM_FLAG} {prompt}`;
const LEGACY_CODEX_ARGS = "exec --skip-git-repo-check {prompt}";
// Profile 的默认工作目录是相对项目目录的路径，这样状态文件在不同机器之间搬动时不会指向失效的绝对路径。
// 相对路径在 Ping 前按需创建；绝对路径按原样使用，缺失时报「工作目录不存在」。
const DEFAULT_PROFILE_DIRECTORY = "default_work_dir";

const DEFAULT_GENERATE_PROMPT = `请根据用户需求生成 Markdown 任务目标文件，并直接写入目标任务文件。
不要执行任务项，也不要启动子 Agent；只负责创建或更新任务目标文件。
任务列表应适合后续 Agent 循环执行，每个任务项需要包含明确完成标准。
如果目标任务文件已有内容，请保留仍然有效的上下文并按用户需求更新。

任务文件规则：
${TASK_PROGRESS_RULES}
${TASK_COMPLETION_RULES}
生成时就在每条任务下填写针对该需求的详细方案和开发步骤，不要只留通用占位说明。新增父任务和子任务均使用 - [ ]，状态为“未开始”；生成方案不等于执行完成，不得将新增任务标记为 FINISHED。

目标任务文件：{targetFile}
工作目录：{workingDirectory}
任务标题：{title}
任务类型：{taskType}
最终产物目录：{artifactDirectory}
建议产物文件：{outputFile}
输出格式：{outputFormat}
画面比例：{aspectRatio}
分辨率：{resolution}
视频时长（秒）：{durationSeconds}
参考文件：{referenceFiles}
用户需求：
{requirement}

完成后只输出 "任务目标文件已生成"。`;
const DEFAULT_DECOMPOSE_PROMPT = DEFAULT_GENERATE_PROMPT;
const TASK_LOG_EVENT_VERSION = 1;
const DEFAULT_TASK_ITEM_COMPLETION = "实现并验证该任务项，必要时更新相关文件。";

function nowISO() {
    return new Date().toISOString();
}

function isAllDoneOutput(output) {
    return String(output || "").includes(ALL_DONE_OUTPUT);
}

// 每轮执行前生成的凭据。Agent 只有把它写进任务文件，本轮才算成功。
// Claude Fable 5.1 官方费率（美元 / 百万 token）。费用估算统一按此费率，不区分 Profile 实际模型。
const FABLE_5_PRICING = Object.freeze({
    model: "claude-fable-5-1",
    inputPerMillion: 10,
    outputPerMillion: 50,
    cacheWritePerMillion: 12.5,
    cacheReadPerMillion: 0.25,
});
const MAX_TASK_CYCLES = 500;

function estimateCycleCostUsd(usage = {}, pricing = FABLE_5_PRICING) {
    const count = (value) => Math.max(0, Number(value) || 0);
    const cost = count(usage.inputTokens) * pricing.inputPerMillion
        + count(usage.outputTokens) * pricing.outputPerMillion
        + count(usage.cacheCreationTokens) * pricing.cacheWritePerMillion
        + count(usage.cacheReadTokens) * pricing.cacheReadPerMillion;
    return Math.round(cost / 1e6 * 1e6) / 1e6;
}

// 从结构化输出（Claude stream-json / Codex --json）里取 usage；多条 result 取最后一条完整的。
function extractUsageFromOutput(rawOutput = "") {
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reportedCostUsd: null, found: false };
    const count = (value) => {
        const parsed = Number(String(value ?? "").replaceAll(",", ""));
        return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
    };
    const visit = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        const source = node.usage && typeof node.usage === "object" ? node.usage : null;
        if (source) {
            const input = count(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens);
            const output = count(source.output_tokens ?? source.outputTokens ?? source.completion_tokens);
            const cacheWrite = count(source.cache_creation_input_tokens ?? source.cacheCreationInputTokens);
            const cacheRead = count(source.cache_read_input_tokens ?? source.cacheReadInputTokens ?? source.cached_input_tokens);
            if (input !== null || output !== null) {
                // Claude 的 result 事件带整轮汇总；逐条 assistant 消息也带 usage，后者会被最终 result 覆盖。
                usage.found = true;
                usage.inputTokens = input ?? usage.inputTokens;
                usage.outputTokens = output ?? usage.outputTokens;
                usage.cacheCreationTokens = cacheWrite ?? usage.cacheCreationTokens;
                usage.cacheReadTokens = cacheRead ?? usage.cacheReadTokens;
            }
        }
        if (node.total_cost_usd !== undefined && Number.isFinite(Number(node.total_cost_usd))) {
            usage.reportedCostUsd = Number(node.total_cost_usd);
        }
        for (const value of Object.values(node)) {
            if (value && typeof value === "object" && value !== source) visit(value);
        }
    };
    for (const line of String(rawOutput || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
        try {
            visit(JSON.parse(trimmed));
        } catch {
            // 非 JSON 行（CLI 提示、纯文本）直接跳过。
        }
    }
    if (!usage.found) {
        const total = String(rawOutput || "").match(/tokens?\s+used\s*[\r\n:]+\s*([\d,]+)/i);
        if (total) {
            usage.found = true;
            usage.inputTokens = count(total[1]) || 0;
        }
    }
    return usage;
}

function appendTaskCycle(task, cycle, limit = MAX_TASK_CYCLES) {
    const cycles = Array.isArray(task.cycles) ? task.cycles : [];
    cycles.push(cycle);
    task.cycles = cycles.length > limit ? cycles.slice(cycles.length - limit) : cycles;
    return task.cycles;
}

// 汇总统计：轮次、成功失败、token、费用、平均调用间隔（相邻两轮 Agent 启动时刻之差）。
function summarizeTaskCycles(cycles = [], pricing = FABLE_5_PRICING) {
    const list = Array.isArray(cycles) ? cycles.filter((cycle) => cycle && cycle.startedAt) : [];
    const summary = {
        cycles: list.length,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        reportedCostUsd: 0,
        agentDurationMs: 0,
        firstStartedAt: null,
        lastEndedAt: null,
        elapsedMs: 0,
        averageIntervalMs: null,
        averageDurationMs: null,
        pricing,
    };
    let previousStart = null;
    let intervalTotal = 0;
    let intervalCount = 0;
    for (const cycle of list) {
        if (cycle.success) summary.successes += 1;
        else summary.failures += 1;
        summary.inputTokens += Number(cycle.inputTokens) || 0;
        summary.outputTokens += Number(cycle.outputTokens) || 0;
        summary.cacheCreationTokens += Number(cycle.cacheCreationTokens) || 0;
        summary.cacheReadTokens += Number(cycle.cacheReadTokens) || 0;
        summary.costUsd += Number(cycle.costUsd) || 0;
        summary.reportedCostUsd += Number(cycle.reportedCostUsd) || 0;
        summary.agentDurationMs += Number(cycle.durationMs) || 0;
        const start = new Date(cycle.startedAt).getTime();
        if (Number.isFinite(start)) {
            if (!summary.firstStartedAt || start < new Date(summary.firstStartedAt).getTime()) summary.firstStartedAt = cycle.startedAt;
            if (previousStart !== null && start >= previousStart) {
                intervalTotal += start - previousStart;
                intervalCount += 1;
            }
            previousStart = start;
        }
        const end = new Date(cycle.endedAt || cycle.startedAt).getTime();
        if (Number.isFinite(end) && (!summary.lastEndedAt || end > new Date(summary.lastEndedAt).getTime())) {
            summary.lastEndedAt = cycle.endedAt || cycle.startedAt;
        }
    }
    summary.totalTokens = summary.inputTokens + summary.outputTokens + summary.cacheCreationTokens + summary.cacheReadTokens;
    summary.costUsd = Math.round(summary.costUsd * 1e6) / 1e6;
    summary.reportedCostUsd = Math.round(summary.reportedCostUsd * 1e6) / 1e6;
    summary.averageIntervalMs = intervalCount ? Math.round(intervalTotal / intervalCount) : null;
    summary.averageDurationMs = list.length ? Math.round(summary.agentDurationMs / list.length) : null;
    if (summary.firstStartedAt && summary.lastEndedAt) {
        summary.elapsedMs = Math.max(0, new Date(summary.lastEndedAt).getTime() - new Date(summary.firstStartedAt).getTime());
    }
    return summary;
}

function createRunToken() {
    return `${RUN_TOKEN_PREFIX}${crypto.randomUUID()}`;
}

function taskFileHasRunToken(content, token) {
    const value = String(token || "").trim();
    if (!value) return false;
    return String(content || "").includes(value);
}

// 自定义 Prompt 模板可能没有 {runToken} 占位符；追加凭据说明，保证每个 Profile 都受同一规则约束。
function ensureRunTokenInstruction(prompt, token, targetFile = "") {
    const text = String(prompt || "");
    if (!token || text.includes(token)) return text;
    const rules = fillTemplate(RUN_TOKEN_RULES, { runToken: token, targetFile: targetFile || "目标任务文件" });
    return `${text.replace(/\s+$/g, "")}\n\n本轮执行凭据规则：\n${rules}`;
}

function failureBackoffMs(failureStreak, timing = LOOP_TIMING) {
    const streak = Math.max(1, Number(failureStreak) || 1);
    const base = Math.max(0, Number(timing.failureBackoffBaseMs) || 0);
    const max = Math.max(base, Number(timing.failureBackoffMaxMs) || 0);
    return Math.min(max, base * 2 ** (streak - 1));
}

function compactJson(value, limit = 400) {
    let text;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }
    text = String(text ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit})` : text;
}

function streamContentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) => typeof item === "string" ? item : item?.type === "text" ? String(item.text || "") : "")
        .filter(Boolean)
        .join("\n");
}

// 把 Claude CLI 的 stream-json 事件翻译成可读文本；无法解析的行原样返回，忽略的事件返回 null。
function renderStreamJsonLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return null;
    let record;
    try {
        record = JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return trimmed;
    const type = String(record.type || "");
    if (type === "stream_event") return null;
    if (type === "system") {
        const parts = [`[system] ${record.subtype || "event"}`];
        if (record.model) parts.push(`model=${record.model}`);
        if (record.session_id) parts.push(`session=${record.session_id}`);
        if (record.cwd) parts.push(`cwd=${record.cwd}`);
        if (Array.isArray(record.tools)) parts.push(`tools=${record.tools.length}`);
        return parts.join(" ");
    }
    if (type === "assistant" || type === "user") {
        const content = record.message?.content;
        const items = Array.isArray(content) ? content : [{ type: "text", text: streamContentText(content) }];
        const lines = [];
        for (const item of items) {
            if (!item || typeof item !== "object") continue;
            if (item.type === "text" && String(item.text || "").trim()) {
                lines.push(type === "assistant" ? String(item.text) : `[user] ${String(item.text)}`);
            } else if (item.type === "tool_use") {
                lines.push(`[tool_use] ${item.name || "tool"} ${compactJson(item.input ?? {}, 400)}`);
            } else if (item.type === "tool_result") {
                const label = item.is_error ? "[tool_error]" : "[tool_result]";
                lines.push(`${label} ${compactJson(streamContentText(item.content) || item.content || "", 600)}`);
            } else if (item.type === "thinking") {
                const length = String(item.thinking || "").length;
                if (length) lines.push(`[thinking] ${length} chars`);
            }
        }
        return lines.length ? lines.join("\n") : null;
    }
    if (type === "result") {
        const usage = record.usage || {};
        const parts = [`[result] ${record.subtype || (record.is_error ? "error" : "success")}`];
        if (record.num_turns !== undefined) parts.push(`turns=${record.num_turns}`);
        if (record.duration_ms !== undefined) parts.push(`duration=${record.duration_ms}ms`);
        if (record.total_cost_usd !== undefined) parts.push(`cost=$${Number(record.total_cost_usd).toFixed(4)}`);
        if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
            parts.push(`tokens=in:${usage.input_tokens ?? "-"} out:${usage.output_tokens ?? "-"}`);
        }
        const text = typeof record.result === "string" ? record.result.trim() : "";
        return text ? `${parts.join(" ")}\n${text}` : parts.join(" ");
    }
    return `[${type || "event"}] ${compactJson(record, 300)}`;
}

// 子进程按块输出，JSON 行可能被截断；渲染器缓冲不完整的最后一行，flush() 在进程结束时清空。
function createStreamJsonRenderer() {
    let buffered = "";
    const render = (lines) => lines.map(renderStreamJsonLine).filter((line) => line !== null).join("\n");
    return {
        push(text) {
            buffered += String(text || "");
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() || "";
            return render(lines);
        },
        flush() {
            const rest = buffered;
            buffered = "";
            return rest.trim() ? render([rest]) : "";
        },
    };
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

const TERMINAL_LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEFAULT_TERMINAL_LOG_LEVEL = "info";

function resolveTerminalLogLevel(value, fallback = DEFAULT_TERMINAL_LOG_LEVEL) {
    const level = String(value ?? "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMINAL_LOG_LEVELS, level) ? level : fallback;
}

function formatTerminalLogValue(value) {
    if (value === null || value === undefined) return "-";
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === "string") {
        const text = value.replace(/\s+/g, " ").trim();
        return /[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatTerminalLogLine({ level = "info", scope = "server", message = "", fields = {}, timestamp = nowISO() } = {}) {
    const parts = [`[${timestamp}]`, `[${String(level).toUpperCase().padEnd(5)}]`, `[${scope}]`, String(message).trim()];
    for (const [key, value] of Object.entries(fields || {})) {
        if (value === undefined) continue;
        parts.push(`${key}=${formatTerminalLogValue(value)}`);
    }
    return parts.filter(Boolean).join(" ");
}

// 零依赖的终端日志器：按级别过滤，warn/error 写 stderr，其余写 stdout；
// writer 参数便于测试捕获输出。scope 用 child() 派生，字段以 key=value 附在行尾。
function createTerminalLogger({ level = DEFAULT_TERMINAL_LOG_LEVEL, scope = "server", writer = null, clock = nowISO } = {}) {
    const threshold = TERMINAL_LOG_LEVELS[resolveTerminalLogLevel(level)];
    const write = writer || ((line, entry) => {
        const stream = TERMINAL_LOG_LEVELS[entry.level] >= TERMINAL_LOG_LEVELS.warn ? process.stderr : process.stdout;
        stream.write(`${line}\n`);
    });
    const make = (currentScope) => {
        const log = (entryLevel, message, fields = {}) => {
            const normalized = resolveTerminalLogLevel(entryLevel, "info");
            if (TERMINAL_LOG_LEVELS[normalized] < threshold || normalized === "silent") return false;
            const entry = { level: normalized, scope: currentScope, message: String(message ?? ""), fields: fields || {}, timestamp: clock() };
            write(formatTerminalLogLine(entry), entry);
            return true;
        };
        return {
            level: resolveTerminalLogLevel(level),
            scope: currentScope,
            enabled: (entryLevel) => TERMINAL_LOG_LEVELS[resolveTerminalLogLevel(entryLevel, "info")] >= threshold,
            log,
            debug: (message, fields) => log("debug", message, fields),
            info: (message, fields) => log("info", message, fields),
            warn: (message, fields) => log("warn", message, fields),
            error: (message, fields) => log("error", message, fields),
            child: (childScope) => make(childScope ? `${currentScope}:${childScope}` : currentScope),
        };
    };
    return make(scope);
}

function normalizeTaskLogEventType(value = "system") {
    const type = String(value || "system")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return type || "system";
}

function createTaskLogEvent({
    id = "",
    sequence = 0,
    taskId = "",
    runId = "",
    timestamp = nowISO(),
    type = "system",
    phase = "run",
    text = "",
    stream = null,
    profile = null,
    metadata = {},
} = {}) {
    const normalizedSequence = Math.max(0, Math.trunc(Number(sequence) || 0));
    const normalizedTaskId = String(taskId || "");
    const normalizedRunId = String(runId || "");
    const normalizedProfile = profile && typeof profile === "object"
        ? {
            id: String(profile.id || ""),
            name: String(profile.name || ""),
            agentType: String(profile.agentType || ""),
            provider: String(profile.provider || ""),
            modelName: String(profile.modelName || ""),
        }
        : null;
    const normalizedStream = ["stdout", "stderr", "error"].includes(String(stream || "").toLowerCase())
        ? String(stream).toLowerCase()
        : null;

    return {
        version: TASK_LOG_EVENT_VERSION,
        id: String(id || `${normalizedTaskId}:${normalizedSequence}`),
        sequence: normalizedSequence,
        taskId: normalizedTaskId,
        runId: normalizedRunId,
        timestamp: String(timestamp || nowISO()),
        type: normalizeTaskLogEventType(type),
        phase: normalizeTaskLogEventType(phase || "run"),
        text: String(text ?? ""),
        stream: normalizedStream,
        profile: normalizedProfile,
        metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {},
    };
}

function parseTaskLogEvents(content = "") {
    return String(content || "")
        .split(/\r?\n/)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.trim())
        .flatMap(({ line, index }) => {
            try {
                const event = JSON.parse(line);
                if (!event || typeof event !== "object" || Array.isArray(event)) return [];
                return [{ ...event, _sourceIndex: index }];
            } catch {
                return [];
            }
        })
        .sort((left, right) => {
            const sequenceDifference = Number(left.sequence || 0) - Number(right.sequence || 0);
            if (sequenceDifference !== 0) return sequenceDifference;
            const timeDifference = String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
            return timeDifference || left._sourceIndex - right._sourceIndex;
        })
        .map(({ _sourceIndex, ...event }) => event);
}

function parseArgs(input = "") {
    const args = [];
    let current = "";
    let quote = null;
    let escaped = false;

    for (const char of input) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === "\\") {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                args.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (escaped) current += "\\";
    if (quote) throw new Error("命令参数存在未闭合的引号");
    if (current.length > 0) args.push(current);
    return args;
}

function parseEnvText(text = "") {
    const env = {};
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const index = line.indexOf("=");
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            env[key] = value;
        }
    }
    return env;
}

function maskEnvText(text = "") {
    return String(text)
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return line;
            return `${line.slice(0, line.indexOf("="))}=********`;
        })
        .join("\n");
}

function fillTemplate(template, context = {}) {
    let output = String(template || "");
    const replacements = {
        ...context,
        prompt: context.prompt || "",
        targetFile: context.targetFile || context.taskFile || "",
        taskFile: context.taskFile || context.targetFile || "",
        "目标任务文件": context.targetFile || context.taskFile || "",
        requirement: context.requirement || "",
        title: context.title || "",
        workingDirectory: context.workingDirectory || "",
    };

    for (const [key, value] of Object.entries(replacements)) {
        if (!key) continue;
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const renderedValue = Array.isArray(value)
            ? value.join("\n")
            : value === null || value === undefined
                ? ""
                : typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value);
        output = output
            .replace(new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`, "g"), () => renderedValue)
            .replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), () => renderedValue)
            .replace(new RegExp(`\\{\\s*${escaped}\\s*\\}`, "g"), () => renderedValue);
    }
    return output;
}

function providerForAgentType(agentType = "") {
    const value = String(agentType || "").trim().toLowerCase();
    if (value === "claude" || value === "claudecode") return "anthropic";
    if (value === "codex") return "openai";
    if (value === "gemini") return "google";
    return "custom";
}

function normalizeModalities(value, fallback = ["text"]) {
    const allowed = new Set(["text", "image", "video"]);
    const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
    const result = [];
    for (const item of values) {
        const modality = String(item || "").trim().toLowerCase();
        if (!allowed.has(modality) || result.includes(modality)) continue;
        result.push(modality);
    }
    return result.length ? result : [...fallback];
}

function nextProfileId(currentId, profileIds = []) {
    const list = (Array.isArray(profileIds) ? profileIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean);
    if (list.length === 0) return String(currentId || "");
    const index = list.indexOf(String(currentId || ""));
    if (index === -1) return list[0];
    return list[(index + 1) % list.length];
}

function configEnvForProfile(profile = {}) {
    const configDirectory = String(profile.configDirectory || "").trim();
    if (!configDirectory) return {};
    const agentType = String(profile.agentType || "").trim().toLowerCase();
    if (agentType === "claude") return { CLAUDE_CONFIG_DIR: configDirectory };
    if (agentType === "codex") return { CODEX_HOME: configDirectory };
    if (agentType === "gemini") {
        return {
            GEMINI_CONFIG_DIR: configDirectory,
            GEMINI_CLI_HOME: configDirectory,
        };
    }
    return { AGENT_CONFIG_DIR: configDirectory };
}

function safeTaskFileName(input = "tasks.md") {
    const base = path.basename(String(input || "tasks.md"))
        .replace(/[\0<>:"|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    let fileName = base || "tasks.md";
    if (fileName === "." || fileName === "..") fileName = "tasks.md";
    if (!fileName.toLowerCase().endsWith(".md")) fileName += ".md";
    return fileName;
}

function extractTaskLines(requirement) {
    const lines = String(requirement || "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)、]\s*/, "").trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return ["梳理需求并确认执行边界", "实现核心功能", "验证运行结果并记录问题"];
    }

    return lines.slice(0, 8);
}

function formatTaskItemMarkdown({ number, text, completionStandard = DEFAULT_TASK_ITEM_COMPLETION }) {
    return [
        `- [ ] ${number}. ${text}`,
        `  - 状态：未开始`,
        `  - 完成标准：${completionStandard}`,
        `  - 详细方案：执行前结合项目现状补充具体实现方式、涉及文件或模块、依赖与验证方法。`,
        `  - 开发步骤：`,
        `    - [ ] 1. 梳理现状与依赖，补全本任务的详细方案和验收方法。`,
        `    - [ ] 2. 按方案实施改动，记录涉及文件和结果。`,
        `    - [ ] 3. 按完成标准验证结果，记录验证命令或检查方式。`,
        `  - 执行记录：暂无`,
    ].join("\n");
}

function generateTaskMarkdown({
    title = "任务目标",
    requirement = "",
    createdAt = nowISO(),
    taskType = "text",
    artifactDirectory = "",
    outputFile = "",
    outputFormat = "",
    aspectRatio = "",
    resolution = "",
    durationSeconds = "",
    referenceFiles = [],
} = {}) {
    const tasks = extractTaskLines(requirement);
    const checklist = tasks
        .map((task, index) => formatTaskItemMarkdown({ number: index + 1, text: task }))
        .join("\n\n");

    const referenceFileList = Array.isArray(referenceFiles)
        ? referenceFiles.map((item) => String(item || "").trim()).filter(Boolean)
        : String(referenceFiles || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const mediaSection = taskType === "text" ? "" : `
## 多模态产物设置

- 任务类型：${taskType}
- 产物目录：${artifactDirectory || "由运行器提供"}
- 建议产物文件：${outputFile || "由运行器决定"}
- 输出格式：${outputFormat || "默认"}
- 画面比例：${aspectRatio || "默认"}
- 分辨率：${resolution || "默认"}
- 视频时长（秒）：${durationSeconds || "不适用"}
- 参考文件：${referenceFileList.length ? referenceFileList.join("、") : "无"}

完成时必须把最终媒体文件写入产物目录，不能只返回链接或文字说明。
`;

    return `# ${title}

生成时间：${createdAt}

## 原始需求

${requirement || "暂无原始需求。"}
${mediaSection}

## 执行规则

${TASK_PROGRESS_RULES}
${TASK_COMPLETION_RULES}

模板中的方案和步骤须在执行前细化；本轮成功后再写入任务文件，失败时不修改任务文件并输出错误。

## 任务列表

${checklist}
`;
}

// agent 模式创建任务时写入的占位内容：只保留标题与原始需求，任务列表由运行界面触发大模型生成。
// 占位内容不含任务项与完成标记，且明确要求生成时整体替换，避免生成 Agent 保留提示文字。
function generatePlaceholderTaskMarkdown({
    title = "任务目标",
    requirement = "",
    createdAt = nowISO(),
} = {}) {
    return `# ${title}

创建时间：${createdAt}

> 尚未生成任务列表，请在运行界面选择本任务并点击「生成目标文件」。
> 本文件为占位内容，生成目标文件时请整体替换。

## 原始需求

${requirement || "暂无原始需求。"}
`;
}

function normalizeTaskItemText(value) {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
}

function normalizeTaskItem(item) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
        const textValue = item.text
            ?? item.title
            ?? item.task
            ?? item.taskText
            ?? item.description
            ?? item.requirement
            ?? item.name
            ?? item.label
            ?? item.content;
        const completionValue = item.completionStandard
            ?? item.completionCriteria
            ?? item.criteria
            ?? item.doneCriteria
            ?? item.completion
            ?? item.acceptanceCriteria;
        return {
            text: normalizeTaskItemText(textValue),
            completionStandard: normalizeTaskItemText(completionValue) || DEFAULT_TASK_ITEM_COMPLETION,
        };
    }
    return {
        text: normalizeTaskItemText(item),
        completionStandard: DEFAULT_TASK_ITEM_COMPLETION,
    };
}

function nextTaskItemNumber(markdown = "") {
    let largestNumber = 0;
    let checklistCount = 0;
    let parentIndent = Infinity;
    let fence = null;
    for (const line of String(markdown || "").split(/\r?\n/)) {
        const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence[0]
                && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1];
            continue;
        }
        const match = /^([ \t]*)(?:[-*+]\s*|(\d+)[.)、:]\s+)\[[ xX]\]\s*(?:(\d+)[.)、:]\s*)?/.exec(line);
        if (!match) continue;
        // Only the outermost checklists number parent tasks; nested steps and
        // Markdown examples must not advance the next appended task number.
        const indent = match[1].replace(/\t/g, "    ").length;
        if (indent > parentIndent) continue;
        if (indent < parentIndent) {
            parentIndent = indent;
            largestNumber = 0;
            checklistCount = 0;
        }
        checklistCount += 1;
        const number = match[3] || match[2];
        if (number) largestNumber = Math.max(largestNumber, Number(number));
    }
    return Math.max(largestNumber, checklistCount) + 1;
}

function appendTaskItemsToMarkdown(markdown = "", items = [], options = {}) {
    const original = String(markdown ?? "");
    const values = (Array.isArray(items) ? items : [items])
        .map(normalizeTaskItem)
        .filter((item) => item.text);
    if (values.length === 0) {
        return { content: original, items: [], nextNumber: nextTaskItemNumber(original) };
    }

    // The completion marker becomes stale as soon as new work is added.
    const source = original.split(ALL_DONE_OUTPUT).join("");
    const requestedStart = Number(options.startNumber);
    const startNumber = Number.isFinite(requestedStart) && requestedStart > 0
        ? Math.trunc(requestedStart)
        : nextTaskItemNumber(source);
    const numberedItems = values.map((item, index) => ({
        ...item,
        number: startNumber + index,
    }));
    const block = numberedItems.map(formatTaskItemMarkdown).join("\n\n");
    const separator = source.length === 0
        ? ""
        : source.endsWith("\n\n")
            ? ""
            : source.endsWith("\n")
                ? "\n"
                : "\n\n";
    return {
        content: `${source}${separator}${block}\n`,
        items: numberedItems,
        nextNumber: startNumber + numberedItems.length,
    };
}

function createDefaultProfiles() {
    return [
        {
            id: "profile_claude_default",
            name: "claude-default",
            agentType: "claude",
            provider: "anthropic",
            inputModalities: ["text"],
            outputModalities: ["text"],
            command: "claude",
            args: "--dangerously-skip-permissions -p {prompt}",
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: DEFAULT_PROFILE_DIRECTORY,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
        {
            id: "profile_codex_default",
            name: "codex-default",
            agentType: "codex",
            provider: "openai",
            inputModalities: ["text"],
            outputModalities: ["text"],
            command: "codex",
            args: DEFAULT_CODEX_ARGS,
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: DEFAULT_PROFILE_DIRECTORY,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
        {
            id: "profile_gemini_default",
            name: "gemini-default",
            agentType: "gemini",
            provider: "google",
            inputModalities: ["text"],
            outputModalities: ["text"],
            command: "gemini",
            args: "-p {prompt}",
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: DEFAULT_PROFILE_DIRECTORY,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
    ];
}

module.exports = {
    ALL_DONE_MARKER,
    ALL_DONE_OUTPUT,
    CODEX_AUTO_CONFIRM_FLAG,
    DEFAULT_TIMEOUT_SECONDS,
    LOOP_TIMING,
    RUN_TOKEN_PATTERN,
    RUN_TOKEN_PREFIX,
    RUN_TOKEN_RULES,
    LEGACY_RUN_PROMPT_V4,
    createRunToken,
    createStreamJsonRenderer,
    ensureRunTokenInstruction,
    failureBackoffMs,
    renderStreamJsonLine,
    taskFileHasRunToken,
    FABLE_5_PRICING,
    MAX_TASK_CYCLES,
    appendTaskCycle,
    estimateCycleCostUsd,
    extractUsageFromOutput,
    summarizeTaskCycles,
    DEFAULT_DECOMPOSE_PROMPT,
    DEFAULT_GENERATE_PROMPT,
    DEFAULT_MEDIA_RUN_PROMPT,
    DEFAULT_CODEX_ARGS,
    DEFAULT_PROFILE_DIRECTORY,
    DEFAULT_RUN_PROMPT,
    DEFAULT_TASK_ITEM_COMPLETION,
    DEFAULT_TERMINAL_LOG_LEVEL,
    TERMINAL_LOG_LEVELS,
    appendTaskItemsToMarkdown,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
    LEGACY_RUN_PROMPT_V2,
    LEGACY_RUN_PROMPT_V3,
    TASK_LOG_EVENT_VERSION,
    configEnvForProfile,
    createTaskLogEvent,
    createTerminalLogger,
    createDefaultProfiles,
    fillTemplate,
    formatTerminalLogLine,
    generatePlaceholderTaskMarkdown,
    generateTaskMarkdown,
    isAllDoneOutput,
    makeId,
    maskEnvText,
    normalizeModalities,
    nextProfileId,
    nextTaskItemNumber,
    normalizeTaskItem,
    normalizeTaskItemText,
    nowISO,
    parseArgs,
    parseEnvText,
    parseTaskLogEvents,
    providerForAgentType,
    resolveTerminalLogLevel,
    safeTaskFileName,
};
