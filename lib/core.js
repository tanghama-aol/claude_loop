const crypto = require("node:crypto");
const path = require("node:path");

const DEFAULT_RUN_PROMPT = `1. 从 {targetFile} 获取一条任务进行工作，完成后将任务标记为完成。不要启动子 agent，直接在当前 agent 中完成。
2. 成功完成后修改 {targetFile}，失败则不修改，并输出错误。
3. 如果任务完成，则输出 "任务完成"。
4. 如果目标文件中任务全部完成，则输出 "全部任务完成"。`;

const CODEX_AUTO_CONFIRM_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const DEFAULT_CODEX_ARGS = `exec --skip-git-repo-check ${CODEX_AUTO_CONFIRM_FLAG} {prompt}`;
const LEGACY_CODEX_ARGS = "exec --skip-git-repo-check {prompt}";

const DEFAULT_DECOMPOSE_PROMPT = `请根据用户需求拆解可执行任务，写入目标任务文件。
每个任务应可独立执行，并包含明确完成标准。
不要直接执行任务，只生成或更新任务列表。

目标任务文件：{targetFile}
用户需求：
{requirement}`;

function nowISO() {
    return new Date().toISOString();
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
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
        prompt: context.prompt || "",
        targetFile: context.targetFile || context.taskFile || "",
        taskFile: context.taskFile || context.targetFile || "",
        "目标任务文件": context.targetFile || context.taskFile || "",
        requirement: context.requirement || "",
        title: context.title || "",
        workingDirectory: context.workingDirectory || "",
    };

    for (const [key, value] of Object.entries(replacements)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        output = output
            .replace(new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`, "g"), value)
            .replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), value)
            .replace(new RegExp(`\\{\\s*${escaped}\\s*\\}`, "g"), value);
    }
    return output;
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

function generateTaskMarkdown({ title = "任务目标", requirement = "", createdAt = nowISO() } = {}) {
    const tasks = extractTaskLines(requirement);
    const checklist = tasks
        .map((task, index) => [
            `- [ ] ${index + 1}. ${task}`,
            `  - 状态：未开始`,
            `  - 完成标准：实现并验证该任务项，必要时更新相关文件。`,
            `  - 执行记录：暂无`,
        ].join("\n"))
        .join("\n\n");

    return `# ${title}

生成时间：${createdAt}

## 原始需求

${requirement || "暂无原始需求。"}

## 任务列表

${checklist}
`;
}

function createDefaultProfiles(rootDir) {
    return [
        {
            id: "profile_claude_default",
            name: "claude-default",
            agentType: "claude",
            command: "claude",
            args: "--dangerously-skip-permissions -p {prompt}",
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: 1800,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: rootDir,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
        {
            id: "profile_codex_default",
            name: "codex-default",
            agentType: "codex",
            command: "codex",
            args: DEFAULT_CODEX_ARGS,
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: 1800,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: rootDir,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
        {
            id: "profile_gemini_default",
            name: "gemini-default",
            agentType: "gemini",
            command: "gemini",
            args: "-p {prompt}",
            envText: "",
            promptTemplate: DEFAULT_RUN_PROMPT,
            timeoutSeconds: 1800,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: rootDir,
            configDirectory: "",
            createdAt: nowISO(),
            updatedAt: nowISO(),
        },
    ];
}

module.exports = {
    CODEX_AUTO_CONFIRM_FLAG,
    DEFAULT_DECOMPOSE_PROMPT,
    DEFAULT_CODEX_ARGS,
    DEFAULT_RUN_PROMPT,
    LEGACY_CODEX_ARGS,
    configEnvForProfile,
    createDefaultProfiles,
    fillTemplate,
    generateTaskMarkdown,
    makeId,
    maskEnvText,
    nextProfileId,
    nowISO,
    parseArgs,
    parseEnvText,
    safeTaskFileName,
};
