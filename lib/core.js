const crypto = require("node:crypto");
const path = require("node:path");

const ALL_DONE_MARKER = "GGGG全部完成GGGG";
const ALL_DONE_OUTPUT = ALL_DONE_MARKER + ALL_DONE_MARKER;
const LEGACY_RUN_PROMPT = `1. 从 {targetFile} 获取一条任务进行工作，完成后将任务标记为完成。不要启动子 agent，直接在当前 agent 中完成。
2. 成功完成后修改 {targetFile}，失败则不修改，并输出错误。
3. 如果任务完成，则输出 "任务完成"。
4. 如果目标文件中任务全部完成，则输出 "全部任务完成"。`;
const DEFAULT_RUN_PROMPT = `1. 从 {targetFile} 获取一条任务进行工作，完成后将任务标记为完成。不要启动子 agent，直接在当前 agent 中完成。
2. 成功完成后修改 {targetFile}，失败则不修改，并输出错误。
3. 如果任务完成，则输出 "任务完成"。
4. 如果目标文件中任务全部完成，则输出 "${ALL_DONE_MARKER}"两遍，不要有间隔。`;

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
const DEFAULT_CODEX_ARGS = `exec --skip-git-repo-check ${CODEX_AUTO_CONFIRM_FLAG} {prompt}`;
const LEGACY_CODEX_ARGS = "exec --skip-git-repo-check {prompt}";
// Profile 的默认工作目录是相对项目目录的路径，这样状态文件在不同机器之间搬动时不会指向失效的绝对路径。
// 相对路径在 Ping 前按需创建；绝对路径按原样使用，缺失时报「工作目录不存在」。
const DEFAULT_PROFILE_DIRECTORY = "default_work_dir";

const DEFAULT_GENERATE_PROMPT = `请根据用户需求生成 Markdown 任务目标文件，并直接写入目标任务文件。
不要执行任务项，也不要启动子 Agent；只负责创建或更新任务目标文件。
任务列表应适合后续 Agent 循环执行，每个任务项需要包含明确完成标准。
如果目标任务文件已有内容，请保留仍然有效的上下文并按用户需求更新。

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

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
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
        .map((task, index) => [
            `- [ ] ${index + 1}. ${task}`,
            `  - 状态：未开始`,
            `  - 完成标准：实现并验证该任务项，必要时更新相关文件。`,
            `  - 执行记录：暂无`,
        ].join("\n"))
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

## 任务列表

${checklist}
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
    for (const line of String(markdown || "").split(/\r?\n/)) {
        const match = /^\s*(?:[-*+]\s*|\d+[.)、:]\s+)\[[ xX]\]\s*(?:(\d+)[.)、:]\s*)?/.exec(line);
        if (!match) continue;
        checklistCount += 1;
        if (match[1]) largestNumber = Math.max(largestNumber, Number(match[1]));
    }
    return Math.max(largestNumber, checklistCount) + 1;
}

function appendTaskItemsToMarkdown(markdown = "", items = [], options = {}) {
    const source = String(markdown ?? "");
    const values = (Array.isArray(items) ? items : [items])
        .map(normalizeTaskItem)
        .filter((item) => item.text);
    if (values.length === 0) {
        return { content: source, items: [], nextNumber: nextTaskItemNumber(source) };
    }

    const requestedStart = Number(options.startNumber);
    const startNumber = Number.isFinite(requestedStart) && requestedStart > 0
        ? Math.trunc(requestedStart)
        : nextTaskItemNumber(source);
    const numberedItems = values.map((item, index) => ({
        ...item,
        number: startNumber + index,
    }));
    const block = numberedItems.map((item) => [
        `- [ ] ${item.number}. ${item.text}`,
        `  - 状态：未开始`,
        `  - 完成标准：${item.completionStandard}`,
        `  - 执行记录：暂无`,
    ].join("\n")).join("\n\n");
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
            timeoutSeconds: 1800,
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
            timeoutSeconds: 1800,
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
            timeoutSeconds: 1800,
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
    DEFAULT_DECOMPOSE_PROMPT,
    DEFAULT_GENERATE_PROMPT,
    DEFAULT_MEDIA_RUN_PROMPT,
    DEFAULT_CODEX_ARGS,
    DEFAULT_PROFILE_DIRECTORY,
    DEFAULT_RUN_PROMPT,
    DEFAULT_TASK_ITEM_COMPLETION,
    appendTaskItemsToMarkdown,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
    TASK_LOG_EVENT_VERSION,
    configEnvForProfile,
    createTaskLogEvent,
    createDefaultProfiles,
    fillTemplate,
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
    safeTaskFileName,
};
