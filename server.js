const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
    ALL_DONE_MARKER,
    CODEX_AUTO_CONFIRM_FLAG,
    DEFAULT_GENERATE_PROMPT,
    DEFAULT_MEDIA_RUN_PROMPT,
    DEFAULT_CODEX_ARGS,
    DEFAULT_RUN_PROMPT,
    appendTaskItemsToMarkdown,
    LEGACY_ALL_DONE_MARKERS,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
    configEnvForProfile,
    createTaskLogEvent,
    createDefaultProfiles,
    fillTemplate,
    generateTaskMarkdown,
    makeId,
    maskEnvText,
    nextProfileId,
    nextTaskItemNumber,
    normalizeTaskItem,
    normalizeModalities,
    nowISO,
    parseArgs,
    parseEnvText,
    parseTaskLogEvents,
    providerForAgentType,
    safeTaskFileName,
} = require("./lib/core");

const STATUS = {
    notStarted: "not_started",
    queued: "queued",
    scheduled: "scheduled",
    running: "running",
    retryWait: "retry_wait",
    completed: "completed",
    allDone: "all_done",
    stopped: "stopped",
    failed: "failed",
};

const SCHEDULE_MODE = {
    immediate: "immediate",
    fixedTime: "fixed_time",
    profileAvailable: "profile_available",
};

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_LEGACY_LOG_PREVIEW_BYTES = 256 * 1024;

/**
 * Resolve the address used by the command-line server entry point.
 *
 * Keep PORT's existing Number(...) semantics (including PORT=0 for an
 * ephemeral port), while treating an empty/whitespace-only HOST as unset.
 * Keeping this as a pure function makes the startup configuration testable
 * without opening a network socket.
 */
function resolveServerConfig(env = process.env) {
    const source = env && typeof env === "object" ? env : {};
    const rawHost = String(source.HOST ?? "").trim();
    return {
        host: rawHost || DEFAULT_HOST,
        port: Number(source.PORT || DEFAULT_PORT),
    };
}

function hostForUrl(host) {
    const value = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;
    if (value.includes(":") && !value.startsWith("[") && !value.endsWith("]")) {
        return `[${value}]`;
    }
    return value;
}

function localBrowserHost(host) {
    const value = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;
    if (value === "0.0.0.0" || value === "::" || value === "0:0:0:0:0:0:0:0") {
        return value === "::" || value === "0:0:0:0:0:0:0:0" ? "[::1]" : "127.0.0.1";
    }
    return hostForUrl(value);
}

function formatStartupMessage({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    const bindHost = hostForUrl(host);
    const browserHost = localBrowserHost(host);
    return `Agent Loop Web running at http://${browserHost}:${port} (listening on ${bindHost}:${port}; remote access depends on local network and firewall settings).`;
}

const RUNTIME_STATE = {
    agentRunning: "agent_running",
    idleWaiting: "idle_waiting",
    loopNotStarted: "loop_not_started",
    queueWaiting: "queue_waiting",
};

const TASK_TYPES = new Set(["text", "image", "video"]);
const MEDIA_FORMATS = {
    image: new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]),
    video: new Set(["mp4", "webm", "mov", "mkv", "m4v"]),
};
const MEDIA_CONTENT_TYPES = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".webm": "video/webm",
    ".webp": "image/webp",
};

function normalizeTaskType(value = "text") {
    const taskType = String(value || "text").trim().toLowerCase();
    return TASK_TYPES.has(taskType) ? taskType : "text";
}

function normalizeMediaFormat(taskType, value = "") {
    const type = normalizeTaskType(taskType);
    if (type === "text") return "";
    const format = String(value || "").trim().toLowerCase().replace(/^\./, "");
    if (MEDIA_FORMATS[type]?.has(format)) return format;
    return type === "video" ? "mp4" : "png";
}

function safeOutputFileName(input, taskType, outputFormat) {
    const format = normalizeMediaFormat(taskType, outputFormat);
    const fallback = `result.${format}`;
    const base = path.basename(String(input || fallback))
        .replace(/[\0<>:"|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    if (!base || base === "." || base === "..") return fallback;
    const extension = path.extname(base).slice(1).toLowerCase();
    if (!MEDIA_FORMATS[normalizeTaskType(taskType)]?.has(extension)) {
        return `${base.replace(/\.[^.]+$/, "") || "result"}.${format}`;
    }
    return base;
}

function normalizeReferenceFiles(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
    return Array.from(new Set(values.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 20);
}

function normalizeDurationSeconds(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 5;
}

function normalizeAppendedTaskItems(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            const normalized = normalizeTaskItem(item);
            const number = Number(item?.number);
            const normalizedNumber = Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
            const id = String(item?.id || "").trim()
                || `task_item_legacy_${crypto.createHash("sha1")
                    .update(`${normalizedNumber || ""}:${normalized.text}`)
                    .digest("hex")
                    .slice(0, 12)}`;
            const appendedAt = item?.appendedAt ? String(item.appendedAt) : null;
            if (!normalized.text) return null;
            return {
                id,
                number: normalizedNumber,
                text: normalized.text,
                completionStandard: normalized.completionStandard,
                status: String(item?.status || STATUS.notStarted),
                appendedAt,
            };
        })
        .filter(Boolean);
}

const PING_QUESTIONS = [
    "What is 1+1?",
    "What color is the sky on a clear day?",
    "Name one day of the week.",
    "What is the opposite of hot?",
    "How many legs does a chair usually have?",
    "What do people use to write on paper?",
    "Name one fruit.",
    "What is 2+2?",
    "What animal says meow?",
    "What do you drink when you are thirsty?",
    "Name one primary color.",
    "What is the first month of the year?",
    "How many minutes are in one hour?",
    "What do you call frozen water?",
    "Name one season.",
    "What is 5 minus 2?",
    "What do bees make?",
    "What do you wear on your feet?",
    "Name one planet.",
    "What is the opposite of up?",
    "How many days are in a week?",
    "What do you use to see in the dark?",
    "Name one common pet.",
    "What is 10 divided by 2?",
    "What do plants need from the sun?",
    "Name one ocean.",
    "What is the opposite of yes?",
    "What do you call a baby dog?",
    "How many wheels does a bicycle have?",
    "What is the last letter of the English alphabet?",
];
const PING_INTERVAL_MS = 60 * 60 * 1000;
const PING_SCHEDULER_TICK_MS = 60 * 1000;
const PING_DETAIL_MAX_CHARS = 64 * 1024;
const AVAILABILITY_CHECK_INTERVAL_MINUTES = 30;
const AVAILABILITY_CHECK_INTERVAL_MS = AVAILABILITY_CHECK_INTERVAL_MINUTES * 60 * 1000;

function tokenCount(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replaceAll(",", ""));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function firstTokenCount(source, keys) {
    for (const key of keys) {
        const value = tokenCount(source?.[key]);
        if (value !== null) return value;
    }
    return null;
}

function usageCounts(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value.usage && typeof value.usage === "object" ? value.usage : value;
    let inputTokens = firstTokenCount(source, [
        "input_tokens",
        "inputTokens",
        "prompt_tokens",
        "promptTokens",
        "input_token_count",
        "inputTokenCount",
    ]);
    const cacheCreationTokens = firstTokenCount(source, [
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    ]);
    const cacheReadTokens = firstTokenCount(source, [
        "cache_read_input_tokens",
        "cacheReadInputTokens",
    ]);
    if (cacheCreationTokens !== null || cacheReadTokens !== null) {
        inputTokens = (inputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
    }
    const outputTokens = firstTokenCount(source, [
        "output_tokens",
        "outputTokens",
        "completion_tokens",
        "completionTokens",
        "output_token_count",
        "outputTokenCount",
    ]);
    if (inputTokens === null && outputTokens === null) return null;
    return { inputTokens, outputTokens };
}

function parseJsonOutputRecords(value = "") {
    const text = String(value || "").trim();
    if (!text) return [];
    try {
        return [JSON.parse(text)];
    } catch {
        const records = [];
        for (const line of text.split(/\r?\n/)) {
            const candidate = line.trim();
            if (!candidate) continue;
            try {
                records.push(JSON.parse(candidate));
            } catch {
                // Structured CLIs may write a non-JSON notice next to JSONL events.
            }
        }
        return records;
    }
}

function walkJson(value, visit) {
    if (!value || typeof value !== "object") return;
    visit(value);
    if (Array.isArray(value)) {
        for (const item of value) walkJson(item, visit);
        return;
    }
    for (const child of Object.values(value)) walkJson(child, visit);
}

function contentText(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
        .map((item) => typeof item === "string" ? item : String(item?.text || item?.content || ""))
        .filter(Boolean)
        .join("");
}

function extractPingOutputDetails(value = "") {
    const rawText = String(value || "").trim();
    const records = parseJsonOutputRecords(rawText);
    if (records.length === 0) {
        const totalMatch = rawText.match(/tokens?\s+used\s*[\r\n:]+\s*([\d,]+)/i);
        return {
            structured: false,
            inputTokens: null,
            outputTokens: null,
            totalTokens: totalMatch ? tokenCount(totalMatch[1]) : null,
            outputText: rawText,
            errorText: "",
            isError: false,
        };
    }

    let inputTokens = null;
    let outputTokens = null;
    let totalTokens = null;
    let finalText = "";
    let errorText = "";
    let isError = false;
    let protocolEventSeen = false;
    const deltaText = [];
    for (const record of records) {
        if (record && typeof record === "object" && !Array.isArray(record) && typeof record.type === "string") {
            protocolEventSeen = true;
        }
        walkJson(record, (node) => {
            const counts = usageCounts(node);
            if (counts) {
                if (counts.inputTokens !== null) inputTokens = counts.inputTokens;
                if (counts.outputTokens !== null) outputTokens = counts.outputTokens;
            }
            const nodeTotal = firstTokenCount(node, ["total_tokens", "totalTokens"]);
            if (nodeTotal !== null) totalTokens = nodeTotal;

            if (node.type === "stream_event"
                && node.event?.type === "content_block_delta"
                && node.event?.delta?.type === "text_delta"
                && node.event.delta.text) {
                deltaText.push(String(node.event.delta.text));
            }
            if (node.type === "item.completed" && node.item?.type === "agent_message") {
                const text = contentText(node.item.text || node.item.content);
                if (text) finalText = text;
            }
            if (node.type === "assistant" && node.message?.role === "assistant") {
                const text = contentText(node.message.content);
                if (text) finalText = text;
            }
            if (node.type === "result" && typeof node.result === "string" && node.result.trim()) {
                finalText = node.result;
                if (node.is_error === true || String(node.subtype || "").includes("error")) {
                    errorText = node.result;
                    isError = true;
                }
            }
            if (Array.isArray(node.choices)) {
                const text = contentText(node.choices.at(-1)?.message?.content || node.choices.at(-1)?.text);
                if (text) finalText = text;
            }
            if (["error", "turn.failed"].includes(String(node.type || "").toLowerCase())) {
                const text = contentText(node.message || node.error?.message || node.error);
                if (text) errorText = text;
                isError = true;
            }
        });
        if (!finalText && record && typeof record === "object" && !Array.isArray(record)) {
            const text = contentText(record.result || record.response || record.output || record.text);
            if (text) finalText = text;
        }
    }

    return {
        structured: true,
        inputTokens,
        outputTokens,
        totalTokens: totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
        outputText: finalText || deltaText.join("") || (!protocolEventSeen ? rawText : ""),
        errorText,
        isError,
    };
}

function jsonRecordHasAssistantText(record) {
    let found = false;
    walkJson(record, (node) => {
        if (found) return;
        if (node.type === "stream_event"
            && node.event?.type === "content_block_delta"
            && node.event?.delta?.type === "text_delta"
            && String(node.event.delta.text || "").length > 0) {
            found = true;
            return;
        }
        if (node.type === "item.completed" && node.item?.type === "agent_message"
            && contentText(node.item.text || node.item.content)) {
            found = true;
            return;
        }
        if (node.type === "assistant" && node.message?.role === "assistant" && contentText(node.message.content)) {
            found = true;
            return;
        }
        if (node.type === "result" && String(node.result || "").length > 0) found = true;
    });
    return found;
}

function firstPingResponseLatency(chunks = [], structured = false) {
    if (!structured) {
        return chunks.find((chunk) => /\S/.test(chunk.text || ""))?.elapsedMs ?? null;
    }
    let buffered = "";
    let latestElapsedMs = null;
    for (const chunk of chunks) {
        buffered += String(chunk.text || "");
        latestElapsedMs = chunk.elapsedMs;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || "";
        for (const line of lines) {
            try {
                if (jsonRecordHasAssistantText(JSON.parse(line))) return chunk.elapsedMs;
            } catch {
                // Ignore CLI notices; only assistant JSON events count as first response text.
            }
        }
    }
    if (buffered.trim()) {
        try {
            if (jsonRecordHasAssistantText(JSON.parse(buffered))) return latestElapsedMs;
        } catch {
            // An incomplete final line does not provide a trustworthy response timestamp.
        }
    }
    return null;
}

function normalizeScheduleMode(value = "", { hasStartAt = false, scheduled = false } = {}) {
    const mode = String(value || "").trim().toLowerCase().replaceAll("-", "_");
    if (["availability", "available", "model_available", "profile_available"].includes(mode)) {
        return SCHEDULE_MODE.profileAvailable;
    }
    if (["time", "fixed", "fixed_time", "scheduled_time"].includes(mode)) {
        return SCHEDULE_MODE.fixedTime;
    }
    if (["immediate", "now"].includes(mode)) return SCHEDULE_MODE.immediate;
    if (hasStartAt || scheduled) return SCHEDULE_MODE.fixedTime;
    return SCHEDULE_MODE.immediate;
}

function normalizedDateString(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createApp(options = {}) {
    const rootDir = path.resolve(options.rootDir || process.cwd());
    const dataDir = path.resolve(options.dataDir || process.env.CLAUDE_LOOP_DATA_DIR || path.join(rootDir, ".claude-loop-data"));
    const publicDir = path.resolve(options.publicDir || path.join(__dirname, "public"));
    const logDir = path.join(dataDir, "logs");
    const stateFile = path.join(dataDir, "state.json");
    const runners = new Map();
    const logEventCounters = new Map();
    let pingTimer = null;
    let pingInProgress = false;
    let runnersClosing = false;

    fs.mkdirSync(logDir, { recursive: true });

    function initialState() {
        const defaultProject = {
            id: "project_default",
            name: path.basename(rootDir) || "默认项目",
            directory: rootDir,
            createdAt: nowISO(),
            updatedAt: nowISO(),
        };
        return {
            version: 3,
            directories: [rootDir],
            projects: [defaultProject],
            profiles: createDefaultProfiles(rootDir),
            tasks: [],
            events: [],
            pingRecords: [],
            pingSettings: { enabled: true },
            createdAt: nowISO(),
            updatedAt: nowISO(),
        };
    }

    function normalizeProfileIdList(value) {
        const values = Array.isArray(value) ? value : [value];
        const seen = new Set();
        const ids = [];
        for (const item of values) {
            const id = String(item || "").trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
        return ids;
    }

    function normalizeProfile(profile) {
        const rawConfigDirectory = String(profile?.configDirectory || "").trim();
        const pingIntervalMinutes = Math.max(1, Number(profile?.pingIntervalMinutes || 60));
        const agentType = String(profile?.agentType || "custom").trim().toLowerCase() || "custom";
        const normalized = {
            ...profile,
            agentType,
            provider: String(profile?.provider || providerForAgentType(agentType)).trim().toLowerCase() || "custom",
            inputModalities: normalizeModalities(profile?.inputModalities, ["text"]),
            outputModalities: normalizeModalities(profile?.outputModalities, ["text"]),
            baseUrl: String(profile?.baseUrl || "").trim(),
            apiToken: String(profile?.apiToken || ""),
            modelName: String(profile?.modelName || "").trim(),
            mediaPromptTemplate: String(profile?.mediaPromptTemplate || ""),
            pingIntervalMinutes,
            pingEnabled: profile?.pingEnabled !== false,
            configDirectory: rawConfigDirectory ? path.resolve(rawConfigDirectory) : "",
            defaultDirectory: path.resolve(profile?.defaultDirectory || rootDir),
        };
        const isLegacyDefaultCodex = normalized.id === "profile_codex_default"
            && normalized.name === "codex-default"
            && String(normalized.agentType || "").toLowerCase() === "codex"
            && String(normalized.command || "") === "codex"
            && String(normalized.args || "") === LEGACY_CODEX_ARGS;
        if (isLegacyDefaultCodex) normalized.args = DEFAULT_CODEX_ARGS;
        if (normalized.promptTemplate === LEGACY_RUN_PROMPT) normalized.promptTemplate = DEFAULT_RUN_PROMPT;
        return normalized;
    }

    function legacyProjectId(directory) {
        return `project_directory_${crypto.createHash("sha1")
            .update(path.resolve(directory || rootDir))
            .digest("hex")
            .slice(0, 12)}`;
    }

    function normalizeProject(project, index = 0) {
        const rawDirectory = String(project?.directory || "").trim();
        const directory = rawDirectory ? path.resolve(rawDirectory) : "";
        const fallbackName = directory ? path.basename(directory) || directory : `项目 ${index + 1}`;
        const fallbackId = directory
            ? legacyProjectId(directory)
            : `project_unbound_${crypto.createHash("sha1").update(`${fallbackName}:${index}`).digest("hex").slice(0, 12)}`;
        return {
            ...project,
            id: String(project?.id || (index === 0 ? "project_default" : fallbackId)).trim(),
            name: String(project?.name || fallbackName).trim() || fallbackName,
            directory,
            createdAt: project?.createdAt ? String(project.createdAt) : nowISO(),
            updatedAt: project?.updatedAt ? String(project.updatedAt) : nowISO(),
        };
    }

    function normalizeTask(task) {
        const directory = path.resolve(task?.directory || rootDir);
        const runProfileIds = normalizeProfileIdList(
            task?.runProfileIds?.length ? task.runProfileIds : [task?.runProfileId, task?.decomposeProfileId],
        );
        const taskType = normalizeTaskType(task?.taskType);
        const requestedOutputFormat = normalizeMediaFormat(taskType, task?.outputFormat);
        const outputFileName = taskType === "text"
            ? ""
            : safeOutputFileName(task?.outputFileName, taskType, requestedOutputFormat);
        const outputFormat = taskType === "text"
            ? ""
            : path.extname(outputFileName).slice(1).toLowerCase() || requestedOutputFormat;
        let artifactDirectoryName = String(task?.artifactDirectoryName || "").trim();
        let artifactDirectory = String(task?.artifactDirectory || "").trim();
        if (taskType !== "text") {
            try {
                const resolved = resolveArtifactDirectory(
                    directory,
                    artifactDirectoryName || (artifactDirectory ? path.relative(directory, artifactDirectory) : ""),
                    task?.id || "task",
                );
                artifactDirectoryName = resolved.name;
                artifactDirectory = resolved.path;
            } catch {
                const resolved = resolveArtifactDirectory(directory, "", task?.id || "task");
                artifactDirectoryName = resolved.name;
                artifactDirectory = resolved.path;
            }
        } else {
            artifactDirectoryName = "";
            artifactDirectory = "";
        }
        const normalizedLogFile = taskLogFileName(task);
        const normalizedLogEventsFile = taskLogEventsFileName({ ...task, logFile: normalizedLogFile });
        const rawLogRuns = Array.isArray(task?.logRuns)
            ? task.logRuns
            : Array.isArray(task?.runs)
                ? task.runs
                : [];
        const logRuns = rawLogRuns
            .map((run) => normalizeTaskLogRun(run, { ...task, logFile: normalizedLogFile }))
            .filter(Boolean);
        const appendedItems = normalizeAppendedTaskItems(
            Array.isArray(task?.appendedItems) && task.appendedItems.length > 0
                ? task.appendedItems
                : task?.appendHistory,
        );
        const rawItemSequence = Number(task?.itemSequence);
        const itemSequence = Number.isFinite(rawItemSequence) && rawItemSequence >= 0
            ? Math.trunc(rawItemSequence)
            : appendedItems.reduce((maximum, item) => Math.max(maximum, Number(item.number) || 0), 0);
        const scheduled = String(task?.status || "") === STATUS.scheduled;
        const scheduleMode = normalizeScheduleMode(task?.scheduleMode, {
            hasStartAt: Boolean(task?.scheduledStartAt || (scheduled && task?.nextRunAt)),
            scheduled,
        });
        const scheduledStartAt = scheduleMode === SCHEDULE_MODE.fixedTime
            ? normalizedDateString(task?.scheduledStartAt || (scheduled ? task?.nextRunAt : null))
            : null;
        const availabilityLastCheckedAt = normalizedDateString(task?.availabilityLastCheckedAt);
        const availabilityNextCheckAt = scheduleMode === SCHEDULE_MODE.profileAvailable && scheduled
            ? normalizedDateString(task?.availabilityNextCheckAt || (scheduled ? task?.nextRunAt : null))
            : null;
        const archived = task?.archived === true || Boolean(task?.archivedAt);
        const archiveRoot = path.resolve(directory, "archive");
        const rawArchiveDirectory = String(task?.archiveDirectory || "").trim();
        const resolvedArchiveDirectory = rawArchiveDirectory ? path.resolve(rawArchiveDirectory) : "";
        const archiveRelative = resolvedArchiveDirectory ? path.relative(archiveRoot, resolvedArchiveDirectory) : "";
        const archiveDirectory = archived
            && resolvedArchiveDirectory
            && archiveRelative !== ".."
            && !archiveRelative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(archiveRelative)
            ? resolvedArchiveDirectory
            : "";
        const queuedStart = task?.queuedStart && typeof task.queuedStart === "object"
            ? {
                profileIds: normalizeProfileIdList(task.queuedStart.profileIds),
                scheduleMode: normalizeScheduleMode(task.queuedStart.scheduleMode, {
                    hasStartAt: Boolean(task.queuedStart.startAt),
                }),
                startAt: normalizedDateString(task.queuedStart.startAt),
            }
            : null;
        return {
            ...task,
            directory,
            logFile: normalizedLogFile,
            logEventsFile: normalizedLogEventsFile,
            logRuns,
            taskType,
            artifactDirectoryName,
            artifactDirectory,
            outputFormat,
            outputFileName,
            aspectRatio: String(task?.aspectRatio || "").trim(),
            resolution: String(task?.resolution || "").trim(),
            durationSeconds: taskType === "video" ? normalizeDurationSeconds(task?.durationSeconds) : null,
            referenceFiles: normalizeReferenceFiles(task?.referenceFiles),
            runProfileIds,
            runProfileId: task?.runProfileId || runProfileIds[0] || "",
            appendedItems,
            appendHistory: appendedItems,
            itemSequence,
            lastAppendedAt: task?.lastAppendedAt ? String(task.lastAppendedAt) : null,
            scheduleMode,
            scheduledStartAt,
            availabilityCheckIntervalMinutes: scheduleMode === SCHEDULE_MODE.profileAvailable
                ? AVAILABILITY_CHECK_INTERVAL_MINUTES
                : null,
            availabilityLastCheckedAt,
            availabilityNextCheckAt,
            projectId: String(task?.projectId || "").trim(),
            archived,
            archivedAt: archived && task?.archivedAt ? String(task.archivedAt) : null,
            archiveDirectory,
            archivedOriginalFilePath: archived && task?.archivedOriginalFilePath
                ? path.resolve(String(task.archivedOriginalFilePath))
                : null,
            logDirectory: archiveDirectory ? path.join(archiveDirectory, "logs") : "",
            queuedAt: String(task?.status || "") === STATUS.queued && task?.queuedAt
                ? String(task.queuedAt)
                : null,
            queueRunId: String(task?.status || "") === STATUS.queued && task?.queueRunId
                ? String(task.queueRunId)
                : null,
            queuedDirectory: String(task?.status || "") === STATUS.queued
                ? path.resolve(task?.queuedDirectory || directory)
                : null,
            queuedStart: String(task?.status || "") === STATUS.queued ? queuedStart : null,
        };
    }

    function normalizeState(state) {
        const normalized = state && typeof state === "object" ? state : initialState();
        normalized.version = 3;
        normalized.directories = Array.isArray(normalized.directories) && normalized.directories.length > 0
            ? normalized.directories.map((item) => path.resolve(item))
            : [rootDir];
        normalized.projects = Array.isArray(normalized.projects) && normalized.projects.length > 0
            ? normalized.projects.map(normalizeProject)
            : [];
        normalized.profiles = Array.isArray(normalized.profiles)
            ? normalized.profiles.map(normalizeProfile)
            : createDefaultProfiles(rootDir);
        normalized.tasks = Array.isArray(normalized.tasks) ? normalized.tasks.map(normalizeTask) : [];
        if (normalized.projects.length === 0) {
            normalized.projects.push(normalizeProject({
                id: "project_default",
                name: path.basename(rootDir) || "默认项目",
                directory: rootDir,
            }));
        }
        const projectIds = new Set(normalized.projects.map((project) => project.id));
        for (const task of normalized.tasks) {
            if (task.projectId && projectIds.has(task.projectId)) continue;
            let project = normalized.projects.find((item) => item.directory && item.directory === task.directory);
            if (!project) {
                const id = legacyProjectId(task.directory);
                project = normalized.projects.find((item) => item.id === id);
                if (!project) {
                    project = normalizeProject({
                        id,
                        name: path.basename(task.directory) || task.directory,
                        directory: task.directory,
                        createdAt: task.createdAt || nowISO(),
                        updatedAt: task.updatedAt || nowISO(),
                    }, normalized.projects.length);
                    normalized.projects.push(project);
                    projectIds.add(project.id);
                }
            }
            task.projectId = project.id;
        }
        normalized.events = Array.isArray(normalized.events) ? normalized.events : [];
        normalized.pingRecords = Array.isArray(normalized.pingRecords) ? normalized.pingRecords : [];
        normalized.pingSettings = {
            enabled: normalized.pingSettings?.enabled !== false,
        };
        normalized.updatedAt = normalized.updatedAt || nowISO();
        return normalized;
    }

    function loadState() {
        if (!fs.existsSync(stateFile)) return initialState();
        try {
            return normalizeState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
        } catch (error) {
            const backup = `${stateFile}.${Date.now()}.broken`;
            fs.copyFileSync(stateFile, backup);
            return initialState();
        }
    }

    function saveState(state) {
        fs.mkdirSync(dataDir, { recursive: true });
        state.updatedAt = nowISO();
        const tmp = `${stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, stateFile);
    }

    if (!fs.existsSync(stateFile)) saveState(initialState());

    function addEvent(state, type, taskId, message) {
        state.events.unshift({
            id: makeId("event"),
            type,
            taskId,
            message,
            createdAt: nowISO(),
        });
        state.events = state.events.slice(0, 200);
    }

    function safeStat(filePath) {
        try {
            return fs.statSync(filePath);
        } catch {
            return null;
        }
    }

    function fileHash(filePath) {
        try {
            return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
        } catch {
            return "";
        }
    }

    function scanTaskArtifacts(task) {
        const taskType = normalizeTaskType(task?.taskType);
        const root = String(task?.artifactDirectory || "").trim();
        const allowedExtensions = MEDIA_FORMATS[taskType];
        if (!root || !allowedExtensions || !safeStat(root)?.isDirectory()) return [];

        const artifacts = [];
        const pending = [{ directory: root, depth: 0 }];
        while (pending.length && artifacts.length < 200) {
            const current = pending.shift();
            let entries = [];
            try {
                entries = fs.readdirSync(current.directory, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (artifacts.length >= 200) break;
                const filePath = path.join(current.directory, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (current.depth < 3) pending.push({ directory: filePath, depth: current.depth + 1 });
                    continue;
                }
                if (!entry.isFile()) continue;
                const extension = path.extname(entry.name).slice(1).toLowerCase();
                if (!allowedExtensions.has(extension)) continue;
                const stat = safeStat(filePath);
                if (!stat?.isFile()) continue;
                const relativePath = path.relative(root, filePath).split(path.sep).join("/");
                artifacts.push({
                    name: entry.name,
                    relativePath,
                    filePath,
                    size: stat.size,
                    mtime: stat.mtime.toISOString(),
                    signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
                    mediaType: taskType,
                    contentType: MEDIA_CONTENT_TYPES[path.extname(entry.name).toLowerCase()] || "application/octet-stream",
                    url: `/api/tasks/${encodeURIComponent(task.id)}/artifact?path=${encodeURIComponent(relativePath)}`,
                });
            }
        }
        return artifacts.sort((left, right) => String(right.mtime).localeCompare(String(left.mtime)));
    }

    function artifactSnapshot(task) {
        return new Map(scanTaskArtifacts(task).map((artifact) => [artifact.relativePath, artifact.signature]));
    }

    function changedArtifacts(before, task) {
        return scanTaskArtifacts(task).filter((artifact) => before.get(artifact.relativePath) !== artifact.signature);
    }

    function findTask(state, id) {
        return state.tasks.find((task) => task.id === id);
    }

    function findProject(state, id) {
        return state.projects.find((project) => project.id === id);
    }

    /**
     * Agent processes operate in a concrete working directory.  Keep queue
     * ownership tied to that directory instead of the presentation project:
     * an unbound project can still choose a directory for each task, and two
     * projects pointing at the same directory must not mutate it concurrently.
     */
    function queueDirectoryForTask(task) {
        return path.resolve(task?.directory || rootDir);
    }

    function queuedTasksForDirectory(state, directory) {
        const queueDirectory = path.resolve(directory || rootDir);
        return state.tasks
            .filter((task) => !task.archived
                && task.status === STATUS.queued
                && queueDirectoryForTask(task) === queueDirectory)
            .sort((left, right) => String(left.queuedAt || left.createdAt || "")
                .localeCompare(String(right.queuedAt || right.createdAt || ""))
                || String(left.id).localeCompare(String(right.id)));
    }

    function directoryActiveTask(state, directory, excludedTaskId = "") {
        const queueDirectory = path.resolve(directory || rootDir);
        return state.tasks.find((task) => {
            if (task.id === excludedTaskId || task.archived || queueDirectoryForTask(task) !== queueDirectory) return false;
            if (runners.has(task.id)) return true;
            return [STATUS.running, STATUS.scheduled, STATUS.retryWait].includes(String(task.status || ""));
        }) || null;
    }

    function queuedTasksForProject(state, projectId) {
        return state.tasks
            .filter((task) => task.projectId === projectId && !task.archived && task.status === STATUS.queued)
            .sort((left, right) => String(left.queuedAt || left.createdAt || "")
                .localeCompare(String(right.queuedAt || right.createdAt || ""))
                || String(left.id).localeCompare(String(right.id)));
    }

    function projectActiveTask(state, projectId, excludedTaskId = "") {
        return state.tasks.find((task) => {
            if (task.id === excludedTaskId || task.projectId !== projectId || task.archived) return false;
            if (runners.has(task.id)) return true;
            return [STATUS.running, STATUS.scheduled, STATUS.retryWait].includes(String(task.status || ""));
        }) || null;
    }

    function findProfile(state, id) {
        return state.profiles.find((profile) => profile.id === id && profile.enabled !== false);
    }

    function profileSupportsOutput(profile, taskType = "text") {
        const modality = normalizeTaskType(taskType);
        return normalizeModalities(profile?.outputModalities, ["text"]).includes(modality);
    }

    function selectUsableProfileIds(state, requestedIds, taskType = "") {
        const usableIds = [];
        for (const id of normalizeProfileIdList(requestedIds)) {
            const profile = findProfile(state, id);
            if (profile && (!taskType || profileSupportsOutput(profile, taskType))) usableIds.push(id);
        }
        return usableIds;
    }

    function orderedUsableProfiles(state, task) {
        const ids = selectUsableProfileIds(state, task.runProfileIds, task.taskType);
        const currentIndex = ids.indexOf(String(task.runProfileId || ""));
        const orderedIds = currentIndex > 0
            ? [...ids.slice(currentIndex), ...ids.slice(0, currentIndex)]
            : ids;
        return orderedIds.map((id) => findProfile(state, id)).filter(Boolean);
    }

    function resolveRunProfile(state, task) {
        let profile = findProfile(state, task.runProfileId);
        if (profile && !profileSupportsOutput(profile, task.taskType)) profile = null;
        if (profile) return profile;
        const list = normalizeProfileIdList(task.runProfileIds);
        for (const id of list) {
            const candidate = findProfile(state, id);
            if (candidate && profileSupportsOutput(candidate, task.taskType)) {
                task.runProfileId = id;
                return candidate;
            }
        }
        return null;
    }

    function isChildActive(child) {
        return Boolean(child && child.exitCode === null && child.signalCode === null);
    }

    function runtimeInfoForTask(task) {
        if (task.status === STATUS.queued) {
            return {
                runtimeState: RUNTIME_STATE.queueWaiting,
                loopActive: false,
                isRunning: false,
                isAgentRunning: false,
                isIdleWaiting: true,
                activeProcess: null,
                loopStartedAt: null,
                idleSince: task.queuedAt || null,
                runtimeNextRunAt: null,
            };
        }
        const runner = runners.get(task.id);
        if (!runner || runner.stopped) {
            return {
                runtimeState: RUNTIME_STATE.loopNotStarted,
                loopActive: false,
                isRunning: false,
                isAgentRunning: false,
                isIdleWaiting: false,
                activeProcess: null,
                loopStartedAt: null,
                idleSince: null,
                runtimeNextRunAt: null,
            };
        }

        const childActive = isChildActive(runner.child);
        if (childActive) {
            return {
                runtimeState: RUNTIME_STATE.agentRunning,
                loopActive: true,
                isRunning: true,
                isAgentRunning: true,
                isIdleWaiting: false,
                activeProcess: runner.activeProcess || {
                    pid: runner.child.pid || null,
                    startedAt: runner.currentRunStartedAt || runner.startedAt || null,
                },
                loopStartedAt: runner.startedAt || null,
                idleSince: null,
                runtimeNextRunAt: null,
            };
        }

        return {
            runtimeState: RUNTIME_STATE.idleWaiting,
            loopActive: true,
            isRunning: true,
            isAgentRunning: false,
            isIdleWaiting: true,
            activeProcess: null,
            loopStartedAt: runner.startedAt || null,
            idleSince: runner.idleSince || runner.startedAt || null,
            runtimeNextRunAt: runner.nextRunAt || task.nextRunAt || null,
        };
    }

    function maskToken(value = "") {
        const text = String(value || "");
        if (!text) return "";
        const tail = text.slice(-4);
        return `${"*".repeat(Math.max(8, text.length - 4))}${tail}`;
    }

    function padLocal(value) {
        return String(value).padStart(2, "0");
    }

    function localMinuteParts(value = new Date()) {
        const date = value instanceof Date ? value : new Date(value);
        const year = date.getFullYear();
        const month = padLocal(date.getMonth() + 1);
        const day = padLocal(date.getDate());
        const hour = padLocal(date.getHours());
        const minute = padLocal(date.getMinutes());
        return {
            date: `${year}-${month}-${day}`,
            minute: `${year}-${month}-${day} ${hour}:${minute}`,
        };
    }

    function selectPingPrompt() {
        const randomFn = typeof options.pingQuestionRandom === "function" ? options.pingQuestionRandom : Math.random;
        const raw = Number(randomFn());
        const normalized = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999999) : 0;
        const index = Math.floor(normalized * PING_QUESTIONS.length);
        return PING_QUESTIONS[index] || PING_QUESTIONS[0];
    }

    function pingDays(records = []) {
        const groups = new Map();
        for (const record of records) {
            const date = record.date || String(record.minute || "").slice(0, 10);
            if (!date) continue;
            if (!groups.has(date)) {
                groups.set(date, {
                    date,
                    total: 0,
                    success: 0,
                    failed: 0,
                    records: [],
                });
            }
            const group = groups.get(date);
            group.total += 1;
            if (record.success) group.success += 1;
            else group.failed += 1;
            group.records.push(record);
        }
        return Array.from(groups.values()).sort((left, right) => right.date.localeCompare(left.date));
    }

    function profileForClient(profile) {
        const { apiToken, ...publicProfile } = profile;
        return {
            ...publicProfile,
            apiTokenConfigured: Boolean(apiToken),
            apiTokenPreview: maskToken(apiToken),
            envPreview: maskEnvText(profile.envText || ""),
            envKeys: Object.keys(parseEnvText(profile.envText || "")),
        };
    }

    function publicState() {
        const state = loadState();
        const directoryQueuePositions = new Map();
        const queueDirectories = new Set(
            state.tasks
                .filter((task) => task.status === STATUS.queued && !task.archived)
                .map((task) => queueDirectoryForTask(task)),
        );
        for (const directory of queueDirectories) {
            queuedTasksForDirectory(state, directory).forEach((task, index) => {
                directoryQueuePositions.set(task.id, index + 1);
            });
        }
        const publicProjects = state.projects.map((project) => ({
            ...project,
            currentTaskCount: state.tasks.filter((task) => task.projectId === project.id && !task.archived).length,
            archivedTaskCount: state.tasks.filter((task) => task.projectId === project.id && task.archived).length,
            activeTaskId: projectActiveTask(state, project.id)?.id || null,
            queuedTaskCount: queuedTasksForProject(state, project.id).length,
        }));
        const publicTasks = state.tasks.map((task) => {
            const project = state.projects.find((item) => item.id === task.projectId);
            const queueActiveTask = task.status === STATUS.queued
                ? directoryActiveTask(state, task.directory, task.id)
                : null;
            const artifacts = scanTaskArtifacts(task).map(({ filePath, signature, ...artifact }) => artifact);
            const logRuns = (task.logRuns || []).map((run) => ({
                ...run,
                logSize: safeStat(taskRunLogPath(task, run, false))?.size || 0,
                eventLogSize: safeStat(taskRunLogPath(task, run, true))?.size || 0,
            }));
            return {
                ...task,
                projectName: project?.name || "",
                projectDirectory: project?.directory || "",
                archivePath: task.archiveDirectory || null,
                queueStatus: task.status === STATUS.queued ? "queued" : null,
                queueDirectory: task.status === STATUS.queued ? queueDirectoryForTask(task) : null,
                queueActiveTaskId: queueActiveTask?.id || null,
                logRuns,
                logRunCount: logRuns.length,
                ...runtimeInfoForTask(task),
                queuePosition: directoryQueuePositions.get(task.id) || null,
                artifacts,
                artifactCount: artifacts.length,
                logSize: task.logFile ? safeStat(taskLogPath(task))?.size || 0 : 0,
                fileMtime: task.filePath ? safeStat(task.filePath)?.mtime?.toISOString() || null : null,
            };
        });
        const projectTaskTree = publicProjects.map((project) => ({
            ...project,
            current: publicTasks.filter((task) => task.projectId === project.id && !task.archived),
            archive: publicTasks.filter((task) => task.projectId === project.id && task.archived),
        }));
        return {
            ...state,
            projects: publicProjects,
            profiles: state.profiles.map(profileForClient),
            tasks: publicTasks,
            projectTaskTree,
            pingDays: pingDays(state.pingRecords),
            pingSettings: state.pingSettings,
            pingQuestionCount: PING_QUESTIONS.length,
            pingRunning: pingInProgress,
        };
    }

    function rotateProfile(state, task) {
        const list = selectUsableProfileIds(state, task.runProfileIds, task.taskType);
        if (list.length <= 1) return null;
        const previousProfileId = task.runProfileId;
        const next = nextProfileId(previousProfileId, list);
        if (!next || next === previousProfileId) return null;
        task.runProfileId = next;
        const profile = findProfile(state, next);
        const previousProfile = findProfile(state, previousProfileId);
        return {
            previousProfileId,
            previousProfileName: previousProfile?.name || previousProfileId,
            profileId: next,
            profileName: profile?.name || next,
            profile: profile || null,
        };
    }

    function resolveDirectory(state, directory) {
        const resolved = path.resolve(directory || rootDir);
        const allowed = state.directories.map((item) => path.resolve(item));
        if (!allowed.includes(resolved)) {
            const error = new Error("工作目录未配置，不能执行任务");
            error.statusCode = 400;
            throw error;
        }
        return resolved;
    }

    function resolveTaskFile(directory, targetFileName) {
        const fileName = safeTaskFileName(targetFileName);
        const resolvedDirectory = path.resolve(directory);
        const filePath = path.resolve(resolvedDirectory, fileName);
        if (filePath !== resolvedDirectory && !filePath.startsWith(`${resolvedDirectory}${path.sep}`)) {
            const error = new Error("目标文件必须位于任务工作目录内");
            error.statusCode = 400;
            throw error;
        }
        return filePath;
    }

    function verifiedTaskFilePath(task) {
        const archived = task?.archived === true;
        if (archived && !String(task?.archiveDirectory || "").trim()) {
            const error = new Error("归档任务文件目录无效");
            error.statusCode = 400;
            throw error;
        }
        let root = path.resolve(task?.directory || rootDir);
        if (archived) root = verifiedArchiveDirectory(task, { allowMissing: true });
        const filePath = task?.filePath
            ? path.resolve(String(task.filePath))
            : archived
                ? path.resolve(root, safeTaskFileName(task?.targetFileName || `${task?.title || "task"}.md`))
                : resolveTaskFile(root, task?.targetFileName || `${task?.title || "task"}.md`);
        const relative = path.relative(root, filePath);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            const error = new Error("任务文件路径无效");
            error.statusCode = 400;
            throw error;
        }
        try {
            const realRoot = fs.realpathSync(root);
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink()) {
                const error = new Error("任务文件不能是符号链接");
                error.statusCode = 400;
                throw error;
            }
            const realFile = fs.realpathSync(filePath);
            const realRelative = path.relative(realRoot, realFile);
            if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
                const error = new Error("任务文件路径越界");
                error.statusCode = 400;
                throw error;
            }
        } catch (error) {
            if (error.statusCode) throw error;
            if (error.code !== "ENOENT") {
                const wrapped = new Error("任务文件路径无法验证");
                wrapped.statusCode = 400;
                throw wrapped;
            }
            if (!fs.existsSync(root)) return filePath;
            try {
                const realRoot = fs.realpathSync(root);
                const realParent = fs.realpathSync(path.dirname(filePath));
                const parentRelative = path.relative(realRoot, realParent);
                if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
                    const wrapped = new Error("任务文件父目录越界");
                    wrapped.statusCode = 400;
                    throw wrapped;
                }
            } catch (parentError) {
                if (parentError.statusCode) throw parentError;
                const wrapped = new Error("任务文件父目录无法验证");
                wrapped.statusCode = 400;
                throw wrapped;
            }
        }
        return filePath;
    }

    function resolveTaskFileForAppend(state, task) {
        const directory = path.resolve(task?.directory || rootDir);
        const allowedDirectories = Array.isArray(state?.directories) ? state.directories : [];
        if (!allowedDirectories.some((item) => path.resolve(item) === directory)) {
            const error = new Error("任务工作目录未配置，不能追加任务项");
            error.statusCode = 400;
            throw error;
        }
        const filePath = task?.filePath
            ? path.resolve(String(task.filePath))
            : resolveTaskFile(directory, task?.targetFileName || "tasks.md");
        if (filePath === directory || !filePath.startsWith(`${directory}${path.sep}`)) {
            const error = new Error("任务文件路径无效，不能追加任务项");
            error.statusCode = 400;
            throw error;
        }
        try {
            const realDirectory = fs.realpathSync(directory);
            const realParent = fs.realpathSync(path.dirname(filePath));
            if (realParent !== realDirectory && !realParent.startsWith(`${realDirectory}${path.sep}`)) {
                const error = new Error("任务文件路径越界，不能追加任务项");
                error.statusCode = 400;
                throw error;
            }
            if (fs.existsSync(filePath)) {
                const stat = fs.lstatSync(filePath);
                if (stat.isSymbolicLink()) {
                    const error = new Error("任务文件不能是符号链接");
                    error.statusCode = 400;
                    throw error;
                }
                const realFile = fs.realpathSync(filePath);
                if (realFile !== realDirectory && !realFile.startsWith(`${realDirectory}${path.sep}`)) {
                    const error = new Error("任务文件路径越界，不能追加任务项");
                    error.statusCode = 400;
                    throw error;
                }
            }
        } catch (error) {
            if (error.statusCode) throw error;
            const wrapped = new Error("任务文件路径无法验证");
            wrapped.statusCode = 400;
            throw wrapped;
        }
        return filePath;
    }

    function extractAppendedTaskItems(body) {
        let rawItems = null;
        if (Array.isArray(body)) {
            rawItems = body;
        } else if (body && typeof body === "object") {
            for (const key of ["items", "taskItems", "tasks", "appendItems", "newItems", "newTasks", "entries", "taskList"]) {
                if (Object.prototype.hasOwnProperty.call(body, key)) {
                    rawItems = Array.isArray(body[key]) ? body[key] : [body[key]];
                    break;
                }
            }
            if (!rawItems && Object.prototype.hasOwnProperty.call(body, "item")) rawItems = Array.isArray(body.item) ? body.item : [body.item];
            if (!rawItems && Object.prototype.hasOwnProperty.call(body, "task")) rawItems = Array.isArray(body.task) ? body.task : [body.task];
            if (!rawItems && Object.prototype.hasOwnProperty.call(body, "text")) rawItems = Array.isArray(body.text) ? body.text : [body.text];
            if (!rawItems && Object.prototype.hasOwnProperty.call(body, "content")) rawItems = Array.isArray(body.content) ? body.content : [body.content];
            if (!rawItems && Object.prototype.hasOwnProperty.call(body, "title")) rawItems = Array.isArray(body.title) ? body.title : [body.title];
        }
        if (!rawItems || rawItems.length === 0) {
            const error = new Error("至少需要提供一个非空任务项");
            error.statusCode = 400;
            throw error;
        }
        if (rawItems.length > 100) {
            const error = new Error("一次最多追加 100 个任务项");
            error.statusCode = 400;
            throw error;
        }
        const sharedCompletionStandard = body && typeof body === "object" && !Array.isArray(body)
            ? body.completionStandard ?? body.completionCriteria ?? body.criteria ?? body.acceptanceCriteria
            : null;
        const items = rawItems.map((item, index) => {
            const isObjectItem = item && typeof item === "object" && !Array.isArray(item);
            const hasTextField = isObjectItem && [
                "text",
                "title",
                "task",
                "taskText",
                "description",
                "requirement",
                "name",
                "label",
                "content",
            ].some((key) => Object.prototype.hasOwnProperty.call(item, key));
            if (typeof item !== "string" && !hasTextField) {
                const error = new Error(`第 ${index + 1} 个任务项必须是文本或带文本字段的对象`);
                error.statusCode = 400;
                throw error;
            }
            const normalized = normalizeTaskItem(
                typeof item === "string" && sharedCompletionStandard
                    ? { text: item, completionStandard: sharedCompletionStandard }
                    : item,
            );
            if (!normalized.text) {
                const error = new Error(`第 ${index + 1} 个任务项不能为空`);
                error.statusCode = 400;
                throw error;
            }
            if (normalized.text.length > 10000) {
                const error = new Error(`第 ${index + 1} 个任务项过长`);
                error.statusCode = 400;
                throw error;
            }
            return normalized;
        });
        return items;
    }

    function appendTaskItems(state, task, inputItems) {
        if (task.archived) {
            const error = new Error("归档任务不能追加任务项");
            error.statusCode = 409;
            throw error;
        }
        const activeStatuses = new Set([STATUS.queued, STATUS.running, STATUS.scheduled, STATUS.retryWait]);
        if (runners.has(task.id) || activeStatuses.has(String(task.status || ""))) {
            const error = new Error("任务正在运行或等待重试，暂不能追加任务项");
            error.statusCode = 409;
            throw error;
        }

        const filePath = resolveTaskFileForAppend(state, task);
        if (!safeStat(filePath)?.isFile()) {
            const error = new Error("任务目标文件不存在，无法追加任务项");
            error.statusCode = 409;
            throw error;
        }
        // Validate the aggregate log destinations before mutating the task file so a
        // damaged or tampered state record cannot leave a half-applied append.
        assertSafeLogFilePath(taskLogPath(task), taskLogRoot(task));
        assertSafeLogFilePath(taskLogPath(task, true), taskLogRoot(task));
        const originalContent = fs.readFileSync(filePath, "utf8");
        const requestedSequence = Number(task.itemSequence);
        const startNumber = Math.max(
            nextTaskItemNumber(originalContent),
            Number.isFinite(requestedSequence) ? Math.trunc(requestedSequence) + 1 : 1,
        );
        const appended = appendTaskItemsToMarkdown(originalContent, inputItems, { startNumber });
        if (!appended.items.length || appended.content === originalContent) {
            const error = new Error("没有可追加的非空任务项");
            error.statusCode = 400;
            throw error;
        }
        const appendedAt = nowISO();
        const records = appended.items.map((item) => ({
            id: makeId("task_item"),
            number: item.number,
            text: item.text,
            completionStandard: item.completionStandard,
            status: STATUS.notStarted,
            appendedAt,
        }));
        const suffix = appended.content.slice(originalContent.length);
        const previousStatus = String(task.status || STATUS.notStarted);
        fs.appendFileSync(filePath, suffix, "utf8");

        const previousItems = normalizeAppendedTaskItems(task.appendedItems || task.appendHistory);
        const allAppendedItems = [...previousItems, ...records];
        task.appendedItems = allAppendedItems;
        task.appendHistory = allAppendedItems;
        task.itemSequence = records[records.length - 1].number;
        task.lastAppendedAt = appendedAt;
        task.nextRunAt = null;
        task.fileMtime = safeStat(filePath)?.mtime?.toISOString() || null;
        task.updatedAt = appendedAt;
        task.status = STATUS.notStarted;
        task.loop = {
            ...(task.loop || {}),
            stallCount: 0,
            lastOutput: "",
            lastHash: fileHash(filePath),
        };

        const itemSummary = records.map((item) => `${item.number}. ${item.text}`).join("；");
        addEvent(state, "task_items_appended", task.id, `追加 ${records.length} 个任务项：${itemSummary}`.slice(0, 4000));
        appendTaskLogEvent(task, "task_items_appended", `追加 ${records.length} 个任务项`, {
            phase: "setup",
            legacyText: `追加任务项（${appendedAt}）：\n${itemSummary}`,
            metadata: {
                previousStatus,
                status: task.status,
                items: records,
                filePath,
            },
        });
        saveState(state);

        return {
            ok: true,
            task,
            items: records,
            appendedItems: records,
            previousStatus,
            status: task.status,
        };
    }

    function safeArchiveDirectoryName(task) {
        const title = safeTaskFileName(task?.title || task?.targetFileName || "task")
            .replace(/\.md$/i, "")
            .replace(/\s+/g, "-")
            .slice(0, 80) || "task";
        return `${title}-${safeLogToken(task?.id, "task")}`;
    }

    function resolveArchiveRoot(directory) {
        const taskDirectory = path.resolve(directory || rootDir);
        const archiveRoot = path.resolve(taskDirectory, "archive");
        const relative = path.relative(taskDirectory, archiveRoot);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            const error = new Error("归档目录无效");
            error.statusCode = 400;
            throw error;
        }
        if (!fs.existsSync(archiveRoot)) return archiveRoot;
        const stat = fs.lstatSync(archiveRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            const error = new Error("archive 必须是任务工作目录内的普通目录");
            error.statusCode = 400;
            throw error;
        }
        const realDirectory = fs.realpathSync(taskDirectory);
        const realArchiveRoot = fs.realpathSync(archiveRoot);
        const realRelative = path.relative(realDirectory, realArchiveRoot);
        if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
            const error = new Error("archive 目录不能越过任务工作目录");
            error.statusCode = 400;
            throw error;
        }
        return archiveRoot;
    }

    function verifiedArchiveDirectory(task, options = {}) {
        const rawArchiveDirectory = String(task?.archiveDirectory || "").trim();
        if (!rawArchiveDirectory) {
            const error = new Error("归档任务目录无效");
            error.statusCode = 400;
            throw error;
        }
        const archiveRoot = resolveArchiveRoot(task?.directory || rootDir);
        const archiveDirectory = path.resolve(rawArchiveDirectory);
        const archiveRelative = path.relative(archiveRoot, archiveDirectory);
        if (!archiveRelative || archiveRelative === ".." || archiveRelative.startsWith(`..${path.sep}`) || path.isAbsolute(archiveRelative)) {
            const error = new Error("归档任务目录无效");
            error.statusCode = 400;
            throw error;
        }
        if (!fs.existsSync(archiveDirectory) && options.allowMissing === true) return archiveDirectory;
        try {
            const archiveStat = fs.lstatSync(archiveDirectory);
            if (archiveStat.isSymbolicLink() || !archiveStat.isDirectory()) {
                const error = new Error("归档任务目录必须是普通目录");
                error.statusCode = 400;
                throw error;
            }
            const realArchiveRoot = fs.realpathSync(archiveRoot);
            const realArchiveDirectory = fs.realpathSync(archiveDirectory);
            const realArchiveRelative = path.relative(realArchiveRoot, realArchiveDirectory);
            if (!realArchiveRelative
                || realArchiveRelative === ".."
                || realArchiveRelative.startsWith(`..${path.sep}`)
                || path.isAbsolute(realArchiveRelative)) {
                const error = new Error("归档任务目录越界");
                error.statusCode = 400;
                throw error;
            }
        } catch (error) {
            if (error.statusCode) throw error;
            const wrapped = new Error("归档任务目录无法验证");
            wrapped.statusCode = 400;
            throw wrapped;
        }
        return archiveDirectory;
    }

    function moveFileSync(source, destination) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try {
            fs.renameSync(source, destination);
        } catch (error) {
            if (error?.code !== "EXDEV") throw error;
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            fs.unlinkSync(source);
        }
    }

    function archiveTask(state, task) {
        if (task.archived) {
            const error = new Error("任务已经归档");
            error.statusCode = 409;
            throw error;
        }
        if (runners.has(task.id) || [STATUS.queued, STATUS.running, STATUS.scheduled, STATUS.retryWait].includes(task.status)) {
            const error = new Error("运行中、预约中或排队中的任务不能归档");
            error.statusCode = 409;
            throw error;
        }

        const archiveRoot = resolveArchiveRoot(task.directory);
        const archiveDirectory = path.resolve(archiveRoot, safeArchiveDirectoryName(task));
        const archiveRelative = path.relative(archiveRoot, archiveDirectory);
        if (!archiveRelative || archiveRelative === ".." || archiveRelative.startsWith(`..${path.sep}`) || path.isAbsolute(archiveRelative)) {
            const error = new Error("归档目录无效");
            error.statusCode = 400;
            throw error;
        }
        if (fs.existsSync(archiveDirectory)) {
            const error = new Error("任务归档目录已存在");
            error.statusCode = 409;
            throw error;
        }

        const originalFilePath = verifiedTaskFilePath(task);
        const archivedAt = nowISO();
        appendTaskLogEvent(task, "task_archived", `归档任务：${task.title}`, {
            phase: "setup",
            runStatus: task.status,
            metadata: { archiveDirectory },
        });
        const originalLogRoot = taskLogRoot(task);
        const fileMoves = [];
        if (safeStat(originalFilePath)?.isFile()) {
            fileMoves.push({
                source: originalFilePath,
                destination: path.join(archiveDirectory, path.basename(originalFilePath)),
                kind: "task",
            });
        }
        const logPaths = new Set([taskLogPath(task), taskLogPath(task, true)]);
        for (const run of task.logRuns || []) {
            logPaths.add(taskRunLogPath(task, run));
            logPaths.add(taskRunLogPath(task, run, true));
        }
        for (const source of logPaths) {
            if (!logFilePathIsSafe(source, originalLogRoot) || !safeStat(source)?.isFile()) continue;
            fileMoves.push({
                source,
                destination: path.join(archiveDirectory, "logs", path.basename(source)),
                kind: "log",
            });
        }

        const moved = [];
        try {
            fs.mkdirSync(path.join(archiveDirectory, "logs"), { recursive: true });
            for (const entry of fileMoves) {
                moveFileSync(entry.source, entry.destination);
                moved.push(entry);
            }
            const archivedFile = fileMoves.find((entry) => entry.kind === "task")?.destination
                || path.join(archiveDirectory, safeTaskFileName(task.targetFileName || `${task.title}.md`));
            if (!safeStat(archivedFile)?.isFile()) {
                fs.writeFileSync(archivedFile, String(task.requirement || ""), "utf8");
            }
            fs.writeFileSync(path.join(archiveDirectory, "task.json"), JSON.stringify({
                id: task.id,
                projectId: task.projectId,
                title: task.title,
                requirement: task.requirement,
                status: task.status,
                targetFileName: task.targetFileName,
                workingDirectory: task.directory,
                originalFilePath,
                archivedFilePath: archivedFile,
                logFiles: fileMoves
                    .filter((entry) => entry.kind === "log")
                    .map((entry) => path.relative(archiveDirectory, entry.destination).split(path.sep).join("/")),
                archivedAt,
            }, null, 2), "utf8");

            task.archived = true;
            task.archivedAt = archivedAt;
            task.archiveDirectory = archiveDirectory;
            task.archivedOriginalFilePath = originalFilePath;
            task.filePath = archivedFile;
            task.logDirectory = path.join(archiveDirectory, "logs");
            task.queuedAt = null;
            task.queueRunId = null;
            task.queuedDirectory = null;
            task.queuedStart = null;
            task.updatedAt = archivedAt;
            addEvent(state, "archive", task.id, `归档任务：${task.title}`);
            saveState(state);
            return task;
        } catch (error) {
            for (const entry of moved.reverse()) {
                try {
                    if (fs.existsSync(entry.destination) && !fs.existsSync(entry.source)) {
                        moveFileSync(entry.destination, entry.source);
                    }
                } catch {
                    // Preserve the original error; rollback is best-effort.
                }
            }
            try {
                fs.rmSync(archiveDirectory, { recursive: true, force: true });
            } catch {
                // Preserve the original error.
            }
            throw error;
        }
    }

    function resolveArtifactDirectory(directory, artifactDirectoryName, taskId) {
        const resolvedDirectory = path.resolve(directory || rootDir);
        const fallback = path.join(".agent-output", String(taskId || "task"));
        const rawName = String(artifactDirectoryName || fallback).trim() || fallback;
        if (path.isAbsolute(rawName)) {
            const error = new Error("产物目录必须使用工作目录内的相对路径");
            error.statusCode = 400;
            throw error;
        }
        const artifactPath = path.resolve(resolvedDirectory, rawName);
        if (artifactPath === resolvedDirectory || !artifactPath.startsWith(`${resolvedDirectory}${path.sep}`)) {
            const error = new Error("产物目录必须位于任务工作目录内");
            error.statusCode = 400;
            throw error;
        }
        return {
            name: path.relative(resolvedDirectory, artifactPath),
            path: artifactPath,
        };
    }

    function resolveReferenceFiles(directory, value) {
        const resolvedDirectory = path.resolve(directory || rootDir);
        return normalizeReferenceFiles(value).map((item) => {
            if (path.isAbsolute(item)) {
                const error = new Error("参考文件必须使用工作目录内的相对路径");
                error.statusCode = 400;
                throw error;
            }
            const filePath = path.resolve(resolvedDirectory, item);
            if (filePath === resolvedDirectory || !filePath.startsWith(`${resolvedDirectory}${path.sep}`)) {
                const error = new Error("参考文件必须位于任务工作目录内");
                error.statusCode = 400;
                throw error;
            }
            return path.relative(resolvedDirectory, filePath);
        });
    }

    function normalizeTaskSourceMode(value, body = {}) {
        if (body.loadExisting === true) return "existing";
        const mode = String(value || "").trim().toLowerCase();
        if (["agent", "existing", "upload", "template"].includes(mode)) return mode;
        return "agent";
    }

    function taskTemplateContext(task, profile = null, prompt = "") {
        const outputFile = task?.artifactDirectory && task?.outputFileName
            ? path.join(task.artifactDirectory, task.outputFileName)
            : "";
        return {
            prompt,
            targetFile: task?.targetFileName || "",
            taskFile: task?.targetFileName || "",
            title: task?.title || "",
            requirement: task?.requirement || "",
            workingDirectory: task?.directory || "",
            taskId: task?.id || "",
            taskType: normalizeTaskType(task?.taskType),
            outputModality: normalizeTaskType(task?.taskType),
            artifactDirectory: task?.artifactDirectory || "",
            outputDirectory: task?.artifactDirectory || "",
            outputFile,
            outputFileName: task?.outputFileName || "",
            outputFormat: task?.outputFormat || "",
            aspectRatio: task?.aspectRatio || "",
            resolution: task?.resolution || "",
            durationSeconds: task?.durationSeconds || "",
            referenceFiles: normalizeReferenceFiles(task?.referenceFiles).join("\n"),
            provider: profile?.provider || "",
            agentType: profile?.agentType || "",
            model: profile?.modelName || "",
            modelName: profile?.modelName || "",
            baseUrl: profile?.baseUrl || "",
        };
    }

    function buildTaskGenerationPrompt(task) {
        return fillTemplate(DEFAULT_GENERATE_PROMPT, taskTemplateContext(task));
    }

    function safeLogFileName(value, fallback) {
        const baseName = path.basename(String(value || "").trim()).replace(/[\\/]/g, "-");
        if (!baseName || baseName === "." || baseName === "..") return fallback;
        return baseName.replace(/[\0<>:"|?*]/g, "-") || fallback;
    }

    function safeLogToken(value, fallback = "item") {
        const raw = String(value || "").trim();
        const token = raw
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .replace(/^\.+/, "")
            .slice(0, 96);
        if (token) return token;
        if (!raw) return fallback;
        return `${fallback}-${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12)}`;
    }

    function taskLogRoot(task = {}) {
        const archiveDirectory = String(task?.archiveDirectory || "").trim();
        if (task?.archived === true && archiveDirectory) {
            return path.resolve(verifiedArchiveDirectory(task, { allowMissing: true }), "logs");
        }
        return logDir;
    }

    function logPathWithinDirectory(fileName, fallback, directory = logDir) {
        const root = path.resolve(directory);
        const safeName = safeLogFileName(fileName, fallback);
        const resolved = path.resolve(root, safeName);
        const relative = path.relative(root, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            const error = new Error("日志路径无效");
            error.statusCode = 400;
            throw error;
        }
        return resolved;
    }

    function logFilePathIsSafe(filePath, directory = logDir) {
        const root = path.resolve(directory);
        const resolved = path.resolve(filePath);
        const relative = path.relative(root, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
        try {
            const stat = fs.lstatSync(resolved);
            if (stat.isSymbolicLink()) return false;
            const realRoot = fs.realpathSync(root);
            const realFile = fs.realpathSync(resolved);
            const realRelative = path.relative(realRoot, realFile);
            return realRelative !== ".."
                && !realRelative.startsWith(`..${path.sep}`)
                && !path.isAbsolute(realRelative);
        } catch (error) {
            return error?.code === "ENOENT";
        }
    }

    function assertSafeLogFilePath(filePath, directory = logDir) {
        if (logFilePathIsSafe(filePath, directory)) return filePath;
        const error = new Error("日志文件路径无效");
        error.statusCode = 400;
        throw error;
    }

    function taskLogFileName(task = {}) {
        const fallback = `${safeLogToken(task.id, "task")}.log`;
        return safeLogFileName(task.logFile, fallback);
    }

    function taskLogEventsFileName(task = {}) {
        const logFile = taskLogFileName(task);
        const fallback = `${logFile.replace(/\.log$/i, "")}.events.jsonl`;
        return safeLogFileName(task.logEventsFile, fallback);
    }

    function taskLogPath(task, eventLog = false) {
        const fallback = eventLog
            ? `${taskLogFileName(task).replace(/\.log$/i, "")}.events.jsonl`
            : `${safeLogToken(task?.id, "task")}.log`;
        return logPathWithinDirectory(
            eventLog ? taskLogEventsFileName(task) : taskLogFileName(task),
            fallback,
            taskLogRoot(task),
        );
    }

    function taskRunLogFileName(task, runId, eventLog = false) {
        const taskToken = safeLogToken(task?.id, "task");
        const runToken = safeLogToken(runId, "run");
        return `${taskToken}.${runToken}${eventLog ? ".events.jsonl" : ".log"}`;
    }

    function taskRunLogPath(task, run, eventLog = false) {
        const fallback = taskRunLogFileName(task, run?.runId, eventLog);
        const fileName = eventLog ? run?.eventLogFile : run?.logFile;
        return logPathWithinDirectory(fileName, fallback, taskLogRoot(task));
    }

    function normalizeTaskLogRun(run, task = {}) {
        const runId = String(run?.runId || "").trim();
        if (!runId) return null;
        const defaultLogFile = taskRunLogFileName(task, runId, false);
        const defaultEventsFile = taskRunLogFileName(task, runId, true);
        const status = String(run?.status || "running").trim().toLowerCase() || "running";
        const aggregateLogFile = taskLogFileName(task);
        const aggregateEventsFile = taskLogEventsFileName(task);
        const logFile = safeLogFileName(run?.logFile, defaultLogFile);
        const eventLogFile = safeLogFileName(run?.eventLogFile, defaultEventsFile);
        return {
            ...run,
            runId,
            status,
            startedAt: run?.startedAt ? String(run.startedAt) : null,
            scheduledAt: run?.scheduledAt ? String(run.scheduledAt) : null,
            endedAt: run?.endedAt ? String(run.endedAt) : null,
            lastEventAt: run?.lastEventAt ? String(run.lastEventAt) : null,
            logFile: logFile === aggregateLogFile ? defaultLogFile : logFile,
            eventLogFile: eventLogFile === aggregateEventsFile ? defaultEventsFile : eventLogFile,
            eventCount: Math.max(0, Math.trunc(Number(run?.eventCount) || 0)),
            firstSequence: run?.firstSequence === null || run?.firstSequence === undefined
                ? null
                : Number.isFinite(Number(run.firstSequence)) ? Number(run.firstSequence) : null,
            lastSequence: run?.lastSequence === null || run?.lastSequence === undefined
                ? null
                : Number.isFinite(Number(run.lastSequence)) ? Number(run.lastSequence) : null,
        };
    }

    function ensureTaskRunLog(task, runId, options = {}) {
        const normalizedRunId = String(runId || "").trim();
        if (!task?.id || !normalizedRunId) return null;
        if (!Array.isArray(task.logRuns)) task.logRuns = [];
        let run = task.logRuns.find((item) => String(item?.runId || "") === normalizedRunId);
        if (!run) {
            run = normalizeTaskLogRun({
                runId: normalizedRunId,
                startedAt: options.startedAt || nowISO(),
                scheduledAt: options.scheduledAt || null,
                status: options.status || "running",
            }, task);
            task.logRuns.push(run);
        } else {
            run = normalizeTaskLogRun(run, task);
            const index = task.logRuns.findIndex((item) => String(item?.runId || "") === normalizedRunId);
            task.logRuns[index] = run;
            if (options.status && !run.endedAt) run.status = String(options.status);
            if (options.startedAt && !run.startedAt) run.startedAt = String(options.startedAt);
            if (options.scheduledAt && !run.scheduledAt) run.scheduledAt = String(options.scheduledAt);
        }
        const root = taskLogRoot(task);
        fs.mkdirSync(root, { recursive: true });
        for (const filePath of [taskRunLogPath(task, run), taskRunLogPath(task, run, true)]) {
            assertSafeLogFilePath(filePath, root);
            const descriptor = fs.openSync(filePath, "a");
            fs.closeSync(descriptor);
        }
        return run;
    }

    function updateTaskRunLog(task, runId, updates = {}) {
        const run = ensureTaskRunLog(task, runId, updates);
        if (!run) return null;
        Object.assign(run, updates);
        const storedEvents = inspectTaskLogFile(taskRunLogPath(task, run, true), taskLogRoot(task)).events;
        if (storedEvents.length > 0) {
            run.eventCount = storedEvents.length;
            run.firstSequence = Number(storedEvents[0].sequence || 0);
            run.lastSequence = Number(storedEvents[storedEvents.length - 1].sequence || 0);
            run.lastEventAt = storedEvents[storedEvents.length - 1].timestamp || run.lastEventAt || null;
        }
        if (updates.status && ["all_done", "failed", "stopped"].includes(String(updates.status))) {
            run.endedAt = String(updates.endedAt || run.endedAt || nowISO());
        }
        return run;
    }

    function profileLogContext(profile) {
        if (!profile) return null;
        return {
            id: profile.id || "",
            name: profile.name || "",
            agentType: profile.agentType || "",
            provider: profile.provider || providerForAgentType(profile.agentType),
            modelName: profile.modelName || "",
        };
    }

    function currentTaskRunId(task, explicitRunId = "") {
        return String(
            explicitRunId
            || runners.get(task.id)?.runId
            || `${task.id || "task"}:lifecycle`,
        );
    }

    function nextTaskLogEventSequence(task) {
        const key = String(task.id || taskLogEventsFileName(task));
        if (!logEventCounters.has(key)) {
            const eventPath = taskLogPath(task, true);
            let existingEvents = [];
            try {
                existingEvents = logFilePathIsSafe(eventPath, taskLogRoot(task)) && fs.existsSync(eventPath)
                    ? parseTaskLogEvents(fs.readFileSync(eventPath, "utf8"))
                    : [];
            } catch {
                existingEvents = [];
            }
            const lastSequence = existingEvents.reduce(
                (maximum, event) => Math.max(maximum, Number(event.sequence || 0)),
                0,
            );
            logEventCounters.set(key, lastSequence);
        }
        const sequence = logEventCounters.get(key) + 1;
        logEventCounters.set(key, sequence);
        return sequence;
    }

    function appendLegacyLogFile(filePath, message, timestamp, directory = logDir) {
        const text = String(message ?? "").replace(/\s+$/g, "");
        if (!text) return;
        fs.appendFileSync(assertSafeLogFilePath(filePath, directory), `[${timestamp}] ${text}\n`, "utf8");
    }

    function appendLegacyTaskLog(task, message, timestamp, filePath = null) {
        appendLegacyLogFile(filePath || taskLogPath(task), message, timestamp, taskLogRoot(task));
    }

    function shouldPersistRunLog(options, runId) {
        if (options.persistRun === true) return true;
        if (options.persistRun === false) return false;
        return Boolean(options.runId && runId && !String(runId).endsWith(":lifecycle"));
    }

    function appendTaskLogEvent(task, type, text, options = {}) {
        if (!task?.id) return null;
        const timestamp = String(options.timestamp || nowISO());
        const sequence = nextTaskLogEventSequence(task);
        const runId = currentTaskRunId(task, options.runId);
        const event = createTaskLogEvent({
            id: `${task.id}:${sequence}`,
            sequence,
            taskId: task.id,
            runId,
            timestamp,
            type,
            phase: options.phase || "run",
            text,
            stream: options.stream || null,
            profile: profileLogContext(options.profile),
            metadata: options.metadata || {},
        });
        const persistRun = shouldPersistRunLog(options, runId);
        const run = persistRun
            ? ensureTaskRunLog(task, runId, {
                startedAt: options.startedAt || timestamp,
                scheduledAt: options.scheduledAt || null,
                status: options.runStatus || "running",
            })
            : null;
        const root = taskLogRoot(task);
        const aggregateEventPath = assertSafeLogFilePath(taskLogPath(task, true), root);
        fs.mkdirSync(root, { recursive: true });
        fs.appendFileSync(aggregateEventPath, `${JSON.stringify(event)}\n`, "utf8");
        if (run) {
            fs.appendFileSync(assertSafeLogFilePath(taskRunLogPath(task, run, true), root), `${JSON.stringify(event)}\n`, "utf8");
            run.eventCount = Math.max(0, Number(run.eventCount || 0)) + 1;
            run.firstSequence = run.firstSequence === null || run.firstSequence === undefined
                ? sequence
                : Math.min(Number(run.firstSequence), sequence);
            run.lastSequence = sequence;
            run.lastEventAt = timestamp;
        }
        if (options.legacyText !== false) {
            const legacyText = options.legacyText === undefined ? text : options.legacyText;
            appendLegacyTaskLog(task, legacyText, timestamp);
            if (run) appendLegacyLogFile(taskRunLogPath(task, run), legacyText, timestamp, root);
        }
        return event;
    }

    function readTaskLogEvents(task, afterSequence = 0) {
        return inspectTaskLogFile(taskLogPath(task, true), taskLogRoot(task)).events
            .filter((event) => Number(event.sequence || 0) > afterSequence);
    }

    function inspectTaskLogFile(filePath, directory = logDir) {
        if (!logFilePathIsSafe(filePath, directory)) {
            return {
                exists: true,
                content: "",
                events: [],
                malformedLines: 0,
                readError: "日志文件路径无效",
            };
        }
        if (!fs.existsSync(filePath)) {
            return {
                exists: false,
                content: "",
                events: [],
                malformedLines: 0,
                readError: null,
            };
        }
        let content = "";
        try {
            content = fs.readFileSync(filePath, "utf8");
        } catch (error) {
            return {
                exists: true,
                content: "",
                events: [],
                malformedLines: 0,
                readError: error?.message || String(error),
            };
        }
        let malformedLines = 0;
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const value = JSON.parse(line);
                if (!value || typeof value !== "object" || Array.isArray(value)) malformedLines += 1;
            } catch {
                malformedLines += 1;
            }
        }
        return {
            exists: true,
            content,
            events: parseTaskLogEvents(content),
            malformedLines,
            readError: null,
        };
    }

    function readLegacyLogFile(filePath, options = {}, directory = logDir) {
        const emptyMetadata = {
            totalBytes: 0,
            returnedBytes: 0,
            omittedBytes: 0,
            truncated: false,
        };
        if (!logFilePathIsSafe(filePath, directory)) {
            return {
                exists: true,
                content: "",
                readError: "日志文件路径无效",
                ...emptyMetadata,
            };
        }
        if (!fs.existsSync(filePath)) {
            return {
                exists: false,
                content: "",
                readError: null,
                ...emptyMetadata,
            };
        }
        const configuredLimit = options.maxBytes === null
            ? null
            : Number.isFinite(Number(options.maxBytes))
                ? Math.max(0, Math.trunc(Number(options.maxBytes)))
                : DEFAULT_LEGACY_LOG_PREVIEW_BYTES;
        let totalBytes = 0;
        try {
            totalBytes = fs.statSync(filePath).size;
            let content = "";
            if (configuredLimit === null || totalBytes <= configuredLimit) {
                content = fs.readFileSync(filePath, "utf8");
            } else if (configuredLimit > 0) {
                const readLength = Math.min(configuredLimit, totalBytes);
                const buffer = Buffer.allocUnsafe(readLength);
                const handle = fs.openSync(filePath, "r");
                let offset = 0;
                try {
                    while (offset < readLength) {
                        const bytesRead = fs.readSync(
                            handle,
                            buffer,
                            offset,
                            readLength - offset,
                            totalBytes - readLength + offset,
                        );
                        if (bytesRead === 0) break;
                        offset += bytesRead;
                    }
                } finally {
                    fs.closeSync(handle);
                }
                content = buffer.subarray(0, offset).toString("utf8").replace(/^\uFFFD+/, "");
            }
            const returnedBytes = Buffer.byteLength(content);
            return {
                exists: true,
                content,
                readError: null,
                totalBytes,
                returnedBytes,
                omittedBytes: Math.max(0, totalBytes - returnedBytes),
                truncated: returnedBytes < totalBytes,
            };
        } catch (error) {
            return {
                exists: true,
                content: "",
                readError: error?.message || String(error),
                totalBytes,
                returnedBytes: 0,
                omittedBytes: totalBytes,
                truncated: false,
            };
        }
    }

    function inferRunStatus(events, fallback = "running") {
        const last = events[events.length - 1];
        if (!last) return fallback;
        const map = {
            task_all_done: "all_done",
            task_failed: "failed",
            task_stopped: "stopped",
            user_stopped: "stopped",
            generation_completed: "completed",
            generation_failed: "failed",
            retry_wait: "retry_wait",
            task_completed: "completed",
            process_exit: fallback,
        };
        return map[last.type] || fallback;
    }

    function taskLogRuns(task, aggregateEvents = []) {
        const explicitRuns = (Array.isArray(task?.logRuns) ? task.logRuns : [])
            .map((run) => normalizeTaskLogRun(run, task))
            .filter(Boolean);
        const byId = new Map(explicitRuns.map((run) => [run.runId, run]));
        const grouped = new Map();
        for (const event of aggregateEvents) {
            const runId = String(event.runId || "");
            if (!runId || runId.endsWith(":lifecycle")) continue;
            if (!grouped.has(runId)) grouped.set(runId, []);
            grouped.get(runId).push(event);
        }
        for (const [runId, events] of grouped) {
            const existing = byId.get(runId);
            if (existing) {
                existing.eventCount = Math.max(Number(existing.eventCount || 0), events.length);
                existing.firstSequence = existing.firstSequence ?? Number(events[0]?.sequence || 0);
                existing.lastSequence = Number(events.at(-1)?.sequence || existing.lastSequence || 0);
                existing.lastEventAt = existing.lastEventAt || events.at(-1)?.timestamp || null;
                if (!existing.status || existing.status === "running") existing.status = inferRunStatus(events, existing.status || "running");
                continue;
            }
            const first = events[0];
            const last = events.at(-1);
            const inferredStatus = inferRunStatus(events);
            byId.set(runId, {
                ...normalizeTaskLogRun({
                    runId,
                    startedAt: first?.timestamp || null,
                    endedAt: ["all_done", "failed", "stopped"].includes(inferredStatus)
                        || last?.type === "generation_completed"
                        ? last?.timestamp || null
                        : null,
                    status: inferredStatus,
                    eventCount: events.length,
                    firstSequence: Number(first?.sequence || 0),
                    lastSequence: Number(last?.sequence || 0),
                    lastEventAt: last?.timestamp || null,
                }, task),
                inferred: true,
            });
        }
        return Array.from(byId.values()).sort((left, right) => {
            const leftTime = String(left.startedAt || "");
            const rightTime = String(right.startedAt || "");
            return rightTime.localeCompare(leftTime) || String(right.runId).localeCompare(String(left.runId));
        });
    }

    function logRunForClient(task, run) {
        if (!run) return null;
        const normalized = normalizeTaskLogRun(run, task);
        return {
            ...normalized,
            logPath: normalized.inferred ? null : taskRunLogPath(task, normalized, false),
            eventLogPath: normalized.inferred ? null : taskRunLogPath(task, normalized, true),
        };
    }

    function taskLogFormat(structured, legacy) {
        if (structured.readError || legacy.readError) return "unreadable";
        if (structured.exists) return structured.malformedLines > 0 ? "structured_partial" : "structured";
        if (legacy.exists && (legacy.content || legacy.totalBytes > 0)) return "legacy";
        return "empty";
    }

    function buildTaskLogPayload(task, options = {}) {
        const afterSequence = Number.isFinite(Number(options.afterSequence)) && Number(options.afterSequence) > 0
            ? Math.trunc(Number(options.afterSequence))
            : 0;
        const legacyMaxBytes = options.fullContent === true ? null : DEFAULT_LEGACY_LOG_PREVIEW_BYTES;
        const root = taskLogRoot(task);
        const aggregateStructured = inspectTaskLogFile(taskLogPath(task, true), root);
        const aggregateLegacy = readLegacyLogFile(taskLogPath(task), { maxBytes: legacyMaxBytes }, root);
        const allRuns = taskLogRuns(task, aggregateStructured.events);
        const requestedRunId = String(options.runId || "").trim();
        const selectedRun = requestedRunId ? allRuns.find((run) => run.runId === requestedRunId) : null;
        if (requestedRunId && !selectedRun) return null;
        let structured = aggregateStructured;
        let legacy = aggregateLegacy;
        let events = aggregateStructured.events;
        if (selectedRun) {
            const runEventPath = taskRunLogPath(task, selectedRun, true);
            const runLegacyPath = taskRunLogPath(task, selectedRun, false);
            const runStructured = inspectTaskLogFile(runEventPath, root);
            const runLegacy = readLegacyLogFile(runLegacyPath, { maxBytes: legacyMaxBytes }, root);
            if (runStructured.exists || runStructured.readError) {
                structured = runStructured;
                events = runStructured.events;
            } else {
                events = aggregateStructured.events.filter((event) => event.runId === selectedRun.runId);
            }
            legacy = runLegacy;
        }
        const filteredEvents = events.filter((event) => Number(event.sequence || 0) > afterSequence);
        const warnings = [];
        if (structured.malformedLines > 0) {
            warnings.push({ code: "malformed_jsonl", count: structured.malformedLines, message: "结构化日志包含无法解析的行，已跳过损坏行" });
        }
        if (!structured.exists && legacy.exists && legacy.content) {
            warnings.push({ code: "legacy_format", message: "当前日志为旧版纯文本格式，未提供结构化事件" });
        }
        if (structured.readError || legacy.readError) {
            warnings.push({ code: "read_error", message: structured.readError || legacy.readError });
        }
        if (legacy.truncated) {
            warnings.push({
                code: "content_truncated",
                message: `日志较大，界面仅加载末尾 ${Math.ceil(legacy.returnedBytes / 1024)} KB；完整日志仍保存在文件中`,
                totalBytes: legacy.totalBytes,
                returnedBytes: legacy.returnedBytes,
                omittedBytes: legacy.omittedBytes,
            });
        }
        const format = taskLogFormat(structured, legacy);
        return {
            taskId: task.id,
            runId: selectedRun?.runId || null,
            run: logRunForClient(task, selectedRun),
            runs: allRuns.map((run) => logRunForClient(task, run)),
            content: legacy.content,
            logPath: selectedRun ? taskRunLogPath(task, selectedRun, false) : taskLogPath(task),
            eventLogPath: selectedRun ? taskRunLogPath(task, selectedRun, true) : taskLogPath(task, true),
            events: filteredEvents,
            contentBytes: legacy.totalBytes,
            contentReturnedBytes: legacy.returnedBytes,
            contentOmittedBytes: legacy.omittedBytes,
            contentTruncated: legacy.truncated,
            nextCursor: filteredEvents.length
                ? Number(filteredEvents[filteredEvents.length - 1].sequence || afterSequence)
                : afterSequence,
            format,
            status: format === "empty" ? "missing" : format === "unreadable" || format === "structured_partial" ? "partial" : "ok",
            legacy: format === "legacy",
            corrupted: structured.malformedLines > 0,
            warnings,
        };
    }

    function quoteCommandArg(arg) {
        const value = String(arg ?? "");
        if (value && !/[\s"'\\]/.test(value)) return value;
        return JSON.stringify(value);
    }

    function stripCommandQuotes(command) {
        const value = String(command || "").trim();
        if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
            return value.slice(1, -1);
        }
        return value;
    }

    function windowsPathValue(env) {
        const keys = Object.keys(env || {}).filter((name) => name.toLowerCase() === "path");
        const key = keys[keys.length - 1];
        return key ? String(env[key] || "") : "";
    }

    function windowsCommandCandidates(command) {
        const ext = path.extname(command).toLowerCase();
        if (ext === ".cmd") {
            return [`${command.slice(0, -4)}.ps1`, command];
        }
        if (ext) return [command];
        return [".exe", ".ps1", ".cmd", ".bat", ".com", ""].map((suffix) => `${command}${suffix}`);
    }

    function resolveWindowsCommandPath(command, env, cwd) {
        const commandText = stripCommandQuotes(command);
        if (process.platform !== "win32" || !commandText) return commandText;

        const isPathLike = /[\\/]/.test(commandText);
        const directories = [];
        if (isPathLike) {
            const directory = path.dirname(commandText);
            directories.push(path.resolve(cwd || rootDir, directory));
        } else {
            directories.push(path.dirname(process.execPath));
            directories.push(...windowsPathValue(env).split(path.delimiter));
        }

        const seenDirectories = new Set();
        for (const rawDirectory of directories) {
            if (!rawDirectory) continue;
            const directory = path.resolve(cwd || rootDir, rawDirectory);
            const key = directory.toLowerCase();
            if (seenDirectories.has(key)) continue;
            seenDirectories.add(key);

            const baseName = isPathLike ? path.basename(commandText) : commandText;
            for (const candidate of windowsCommandCandidates(baseName)) {
                const filePath = path.join(directory, candidate);
                if (safeStat(filePath)?.isFile()) return filePath;
            }
        }

        return commandText;
    }

    function powershellHostPath() {
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        return safeStat(powershell)?.isFile() ? powershell : "powershell.exe";
    }

    function quoteCmdArgument(value) {
        const text = String(value ?? "").replace(/\r?\n/g, " ");
        if (!text) return "\"\"";
        return `"${text.replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
    }

    function prepareSpawnSpecForPlatform(spawnSpec, env, cwd) {
        if (spawnSpec.platformPrepared) return spawnSpec;
        if (process.platform !== "win32") return spawnSpec;

        const resolvedCommand = resolveWindowsCommandPath(spawnSpec.command, env, cwd);
        const ext = path.extname(resolvedCommand).toLowerCase();
        if (ext === ".ps1") {
            const command = powershellHostPath();
            const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...spawnSpec.args];
            return {
                command,
                args,
                summary: [command, ...args].map(quoteCommandArg).join(" ").trim(),
                platformPrepared: true,
            };
        }
        if (ext === ".cmd" || ext === ".bat") {
            const command = process.env.ComSpec || "cmd.exe";
            const line = [resolvedCommand, ...spawnSpec.args].map(quoteCmdArgument).join(" ");
            const args = ["/d", "/s", "/c", line];
            return {
                command,
                args,
                summary: [command, ...args].map(quoteCommandArg).join(" ").trim(),
                platformPrepared: true,
            };
        }

        return {
            command: resolvedCommand,
            args: spawnSpec.args,
            summary: [resolvedCommand, ...spawnSpec.args].map(quoteCommandArg).join(" ").trim(),
            platformPrepared: true,
        };
    }

    function modelTestEnvForProfile(profile) {
        const baseUrl = String(profile?.baseUrl || "").trim();
        const apiToken = String(profile?.apiToken || "");
        const modelName = String(profile?.modelName || "").trim();
        const agentType = String(profile?.agentType || "").trim().toLowerCase();
        const provider = String(profile?.provider || providerForAgentType(agentType)).trim().toLowerCase();
        const env = {};
        if (baseUrl) env.AGENT_BASE_URL = baseUrl;
        if (apiToken) env.AGENT_TOKEN = apiToken;
        if (modelName) env.AGENT_MODEL = modelName;
        if (provider) env.AGENT_PROVIDER = provider;
        env.AGENT_INPUT_MODALITIES = normalizeModalities(profile?.inputModalities, ["text"]).join(",");
        env.AGENT_OUTPUT_MODALITIES = normalizeModalities(profile?.outputModalities, ["text"]).join(",");
        if (provider === "openai" || agentType === "codex") {
            if (baseUrl) {
                env.CODEX_BASE_URL = baseUrl;
                env.OPENAI_BASE_URL = baseUrl;
            }
            if (apiToken) {
                env.CODEX_API_KEY = apiToken;
                env.OPENAI_API_KEY = apiToken;
            }
            if (modelName) {
                env.CODEX_MODEL = modelName;
                env.OPENAI_MODEL = modelName;
            }
        }
        if (provider === "anthropic" || agentType === "claude" || agentType === "claudecode") {
            if (baseUrl) {
                env.CLAUDE_BASE_URL = baseUrl;
                env.CLAUDE_CODE_BASE_URL = baseUrl;
                env.ANTHROPIC_BASE_URL = baseUrl;
            }
            if (apiToken) {
                env.CLAUDE_TOKEN = apiToken;
                env.CLAUDE_CODE_TOKEN = apiToken;
                env.ANTHROPIC_AUTH_TOKEN = apiToken;
                env.ANTHROPIC_API_KEY = apiToken;
            }
            if (modelName) {
                env.CLAUDE_MODEL = modelName;
                env.CLAUDE_CODE_MODEL = modelName;
                env.ANTHROPIC_MODEL = modelName;
            }
        }
        if (provider === "google" || agentType === "gemini") {
            if (baseUrl) env.GOOGLE_GEMINI_BASE_URL = baseUrl;
            if (apiToken) {
                env.GEMINI_API_KEY = apiToken;
                env.GOOGLE_API_KEY = apiToken;
            }
            if (modelName) env.GEMINI_MODEL = modelName;
        }
        if (provider === "replicate") {
            if (apiToken) env.REPLICATE_API_TOKEN = apiToken;
            if (modelName) env.REPLICATE_MODEL = modelName;
        }
        if (provider === "fal") {
            if (apiToken) env.FAL_KEY = apiToken;
            if (modelName) env.FAL_MODEL = modelName;
        }
        if (provider === "runway") {
            if (apiToken) env.RUNWAYML_API_SECRET = apiToken;
            if (modelName) env.RUNWAY_MODEL = modelName;
        }
        if (provider === "stability") {
            if (apiToken) env.STABILITY_API_KEY = apiToken;
            if (modelName) env.STABILITY_MODEL = modelName;
        }
        return env;
    }

    function taskEnvForTask(task = {}) {
        const context = taskTemplateContext(task);
        const env = {
            AGENT_TASK_ID: context.taskId,
            AGENT_TASK_TYPE: context.taskType,
            AGENT_OUTPUT_MODALITY: context.outputModality,
            AGENT_WORKING_DIRECTORY: context.workingDirectory,
            AGENT_TASK_FILE: context.targetFile,
        };
        if (context.artifactDirectory) env.AGENT_OUTPUT_DIR = context.artifactDirectory;
        if (context.outputFile) env.AGENT_OUTPUT_FILE = context.outputFile;
        if (context.outputFormat) env.AGENT_OUTPUT_FORMAT = context.outputFormat;
        if (context.aspectRatio) env.AGENT_ASPECT_RATIO = context.aspectRatio;
        if (context.resolution) env.AGENT_RESOLUTION = context.resolution;
        if (context.durationSeconds) env.AGENT_DURATION_SECONDS = String(context.durationSeconds);
        if (context.referenceFiles) env.AGENT_REFERENCE_FILES = context.referenceFiles;
        return env;
    }

    function environmentForProfile(profile, task = {}) {
        return {
            ...process.env,
            ...parseEnvText(profile.envText || ""),
            ...configEnvForProfile(profile),
            ...modelTestEnvForProfile(profile),
            ...taskEnvForTask(task),
        };
    }

    function formatOutputChunk(stream, text) {
        const normalized = String(text || "").replace(/\s+$/g, "");
        if (!normalized) return `${stream}: <empty chunk>`;
        return normalized
            .split(/\r?\n/)
            .map((line) => `${stream}: ${line}`)
            .join("\n");
    }

    function isAllDoneOutput(output) {
        const text = String(output || "");
        return [ALL_DONE_MARKER + ALL_DONE_MARKER, ALL_DONE_MARKER, ...LEGACY_ALL_DONE_MARKERS]
            .some((marker) => marker && text.includes(marker));
    }

    function profileConfigDescription(profile) {
        const keys = Object.keys(configEnvForProfile(profile));
        return [
            `提供者：${profile.provider || providerForAgentType(profile.agentType)}`,
            `模型：${profile.modelName || "-"}`,
            `输出模态：${normalizeModalities(profile.outputModalities, ["text"]).join(", ")}`,
            `配置目录：${profile.configDirectory || "-"}${keys.length ? ` (${keys.join(", ")})` : ""}`,
        ].join("\n");
    }

    function promptBlock(prompt) {
        return `Prompt 开始\n${prompt}\nPrompt 结束`;
    }

    function buildPrompt(profile, task, overridePrompt = "") {
        if (overridePrompt) return overridePrompt;
        const template = normalizeTaskType(task.taskType) === "text"
            ? profile.promptTemplate || DEFAULT_RUN_PROMPT
            : profile.mediaPromptTemplate || DEFAULT_MEDIA_RUN_PROMPT;
        return fillTemplate(template, taskTemplateContext(task, profile));
    }

    function isCodexCommand(profile) {
        const baseName = path.basename(stripCommandQuotes(profile.command || "")).toLowerCase();
        return baseName === "codex" || baseName === "codex.exe" || baseName === "codex.cmd" || baseName === "codex.ps1";
    }

    function isClaudeCommand(profile) {
        const baseName = path.basename(stripCommandQuotes(profile.command || "")).toLowerCase();
        return baseName === "claude" || baseName === "claude.exe" || baseName === "claude.cmd" || baseName === "claude.ps1";
    }

    function addNonInteractiveArgs(profile, args) {
        if (profile.nonInteractive === false) return args;
        const agentType = String(profile.agentType || "").trim().toLowerCase();
        if (agentType === "codex" && isCodexCommand(profile) && args[0] === "exec" && !args.includes(CODEX_AUTO_CONFIRM_FLAG)) {
            return ["exec", CODEX_AUTO_CONFIRM_FLAG, ...args.slice(1)];
        }
        return args;
    }

    function buildSpawn(profile, prompt, task = {}) {
        const args = addNonInteractiveArgs(profile, parseArgs(profile.args || ""));
        const context = taskTemplateContext(task, profile, prompt);
        let hasPrompt = false;
        const renderedArgs = args.map((arg) => {
            if (arg.includes("{prompt}") || arg.includes("${prompt}") || arg.includes("{{prompt}}")) {
                hasPrompt = true;
                return fillTemplate(arg, context);
            }
            return fillTemplate(arg, context);
        });
        if (!hasPrompt) renderedArgs.push("-p", prompt);
        return {
            command: stripCommandQuotes(profile.command),
            args: renderedArgs,
            summary: [stripCommandQuotes(profile.command), ...renderedArgs].map(quoteCommandArg).join(" ").trim(),
        };
    }

    function buildPingSpawn(profile, prompt, task = {}) {
        const spawnSpec = buildSpawn(profile, prompt, task);
        const args = [...spawnSpec.args];
        let structuredOutput = false;

        if (isCodexCommand(profile)) {
            const execIndex = args.indexOf("exec");
            if (execIndex >= 0) {
                if (!args.includes("--json")) args.splice(execIndex + 1, 0, "--json");
                structuredOutput = true;
            }
        } else if (isClaudeCommand(profile)) {
            const outputFormatArg = args.find((arg, index) => arg.startsWith("--output-format=")
                || (arg === "--output-format" && args[index + 1]));
            if (!outputFormatArg) {
                args.unshift("--output-format", "stream-json", "--include-partial-messages", "--verbose");
                structuredOutput = true;
            } else {
                const format = outputFormatArg.includes("=")
                    ? outputFormatArg.split("=").slice(1).join("=")
                    : args[args.indexOf(outputFormatArg) + 1];
                structuredOutput = ["json", "stream-json"].includes(String(format || "").toLowerCase());
            }
        }

        return {
            ...spawnSpec,
            args,
            summary: [spawnSpec.command, ...args].map(quoteCommandArg).join(" ").trim(),
            structuredOutput,
        };
    }

    function runProfileCommand({ profile, task, prompt, spawnSpec = null, onOutput = () => {}, onLifecycle = null }) {
        return new Promise((resolve) => {
            const emitLifecycle = (type, text, metadata = {}) => {
                if (onLifecycle) onLifecycle(type, text, metadata);
            };
            const env = environmentForProfile(profile, task);
            const actualSpawnSpec = prepareSpawnSpecForPlatform(spawnSpec || buildSpawn(profile, prompt, task), env, task.directory);
            const timeoutMs = Math.max(1, Number(profile.timeoutSeconds || 1800)) * 1000;
            const startedAt = Date.now();
            const processStartedAt = nowISO();
            let child;
            try {
                child = childProcess.spawn(actualSpawnSpec.command, actualSpawnSpec.args, {
                    cwd: task.directory,
                    env,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch (error) {
                const message = error?.message || String(error);
                emitLifecycle("process_error", `Agent 启动错误：${message}`, { error: message });
                onOutput(message, "error");
                resolve({
                    exitCode: 127,
                    signal: null,
                    timedOut: false,
                    output: `\n${message}`,
                    stdout: "",
                    stderr: message,
                    commandSummary: actualSpawnSpec.summary,
                    durationMs: Date.now() - startedAt,
                    firstOutputAt: null,
                    firstOutputLatencyMs: null,
                    lastOutputAt: nowISO(),
                    outputChunks: 1,
                    stderrBytes: 0,
                    stdoutBytes: 0,
                });
                return;
            }
            const runner = runners.get(task.id);
            if (runner) {
                runner.child = child;
                runner.currentRunStartedAt = processStartedAt;
                runner.idleSince = null;
                runner.nextRunAt = null;
                runner.activeProcess = {
                    pid: child.pid || null,
                    command: actualSpawnSpec.command,
                    args: actualSpawnSpec.args,
                    commandSummary: actualSpawnSpec.summary,
                    cwd: task.directory,
                    profileId: profile.id,
                    profileName: profile.name,
                    agentType: profile.agentType,
                    provider: profile.provider || providerForAgentType(profile.agentType),
                    modelName: profile.modelName || "",
                    taskType: normalizeTaskType(task.taskType),
                    startedAt: processStartedAt,
                    lastOutputAt: null,
                    outputChunks: 0,
                };
            }
            emitLifecycle(
                "process_started",
                `Agent 进程已启动：profile=${profile.name} provider=${profile.provider || providerForAgentType(profile.agentType)} type=${profile.agentType} modality=${normalizeTaskType(task.taskType)} pid=${child.pid || "-"} cwd=${task.directory}`,
                {
                    pid: child.pid || null,
                    cwd: task.directory,
                    command: actualSpawnSpec.command,
                    commandSummary: actualSpawnSpec.summary,
                },
            );

            let output = "";
            let stdout = "";
            let stderr = "";
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let outputChunks = 0;
            let firstOutputAt = null;
            let firstOutputLatencyMs = null;
            let lastOutputAt = null;
            let settled = false;
            const settle = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const currentRunner = runners.get(task.id);
                const durationMs = Date.now() - startedAt;
                if (currentRunner && currentRunner.child === child) {
                    currentRunner.child = null;
                    currentRunner.activeProcess = null;
                    currentRunner.currentRunStartedAt = null;
                    currentRunner.lastAgentExitAt = nowISO();
                    currentRunner.lastAgentExitCode = result.exitCode ?? null;
                    currentRunner.lastAgentSignal = result.signal || null;
                }
                if (outputChunks === 0) emitLifecycle("no_output", "Agent 运行结束：未收到 stdout/stderr 输出");
                emitLifecycle(
                    "process_exit",
                    [
                        `Agent 进程结束：exitCode=${result.exitCode ?? "-"} signal=${result.signal || "-"} durationMs=${durationMs}`,
                        `输出统计：chunks=${outputChunks} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`,
                    ].join("\n"),
                    {
                        exitCode: result.exitCode ?? null,
                        signal: result.signal || null,
                        timedOut: result.timedOut === true,
                        durationMs,
                        outputChunks,
                        stdoutBytes,
                        stderrBytes,
                    },
                );
                resolve({
                    ...result,
                    output,
                    stdout,
                    stderr,
                    commandSummary: actualSpawnSpec.summary,
                    durationMs,
                    firstOutputAt,
                    firstOutputLatencyMs,
                    lastOutputAt,
                    outputChunks,
                    stderrBytes,
                    stdoutBytes,
                });
            };

            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 3000).unref();
                output += `\n[timeout] command exceeded ${profile.timeoutSeconds || 1800}s`;
                emitLifecycle("timeout", `Agent 超时：超过 ${profile.timeoutSeconds || 1800}s，发送 SIGTERM`, {
                    timeoutSeconds: profile.timeoutSeconds || 1800,
                });
                settle({ exitCode: 124, signal: "TIMEOUT", timedOut: true });
            }, timeoutMs);
            timer.unref();

            child.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                output += text;
                stdout += text;
                stdoutBytes += chunk.length;
                outputChunks += 1;
                lastOutputAt = nowISO();
                if (!firstOutputAt) {
                    firstOutputAt = lastOutputAt;
                    firstOutputLatencyMs = Date.now() - startedAt;
                    emitLifecycle("first_output", `Agent 首次输出：stdout ${chunk.length} bytes`, {
                        stream: "stdout",
                        bytes: chunk.length,
                    });
                }
                const runner = runners.get(task.id);
                if (runner?.activeProcess) {
                    runner.activeProcess.lastOutputAt = lastOutputAt;
                    runner.activeProcess.outputChunks = outputChunks;
                }
                onOutput(text, "stdout");
            });
            child.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                output += text;
                stderr += text;
                stderrBytes += chunk.length;
                outputChunks += 1;
                lastOutputAt = nowISO();
                if (!firstOutputAt) {
                    firstOutputAt = lastOutputAt;
                    firstOutputLatencyMs = Date.now() - startedAt;
                    emitLifecycle("first_output", `Agent 首次输出：stderr ${chunk.length} bytes`, {
                        stream: "stderr",
                        bytes: chunk.length,
                    });
                }
                const runner = runners.get(task.id);
                if (runner?.activeProcess) {
                    runner.activeProcess.lastOutputAt = lastOutputAt;
                    runner.activeProcess.outputChunks = outputChunks;
                }
                onOutput(text, "stderr");
            });
            child.on("error", (error) => {
                output += `\n${error.message}`;
                emitLifecycle("process_error", `Agent 启动错误：${error.message}`, { error: error.message });
                onOutput(error.message, "error");
                settle({ exitCode: 127, signal: null, timedOut: false });
            });
            child.on("close", (exitCode, signal) => {
                setImmediate(() => settle({ exitCode, signal, timedOut: false }));
            });
        });
    }

    function isPingProfile(profile) {
        const agentType = String(profile?.agentType || "").trim().toLowerCase();
        return profile?.enabled !== false && profile?.pingEnabled !== false && ["claude", "claudecode", "codex"].includes(agentType);
    }

    function lastPingRecordForProfile(records, profileId) {
        return (records || [])
            .filter((record) => record.profileId === profileId && record.createdAt)
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
    }

    function isProfileDueForPing(profile, records, now = new Date()) {
        const lastRecord = lastPingRecordForProfile(records, profile.id);
        if (!lastRecord) return true;
        const lastTime = new Date(lastRecord.createdAt).getTime();
        if (Number.isNaN(lastTime)) return true;
        const intervalMs = Math.max(1, Number(profile.pingIntervalMinutes || 60)) * 60 * 1000;
        return now.getTime() - lastTime >= intervalMs;
    }

    async function pingProfile(profile, { source = "scheduled", taskId = null } = {}) {
        const timestamp = new Date();
        const { date, minute } = localMinuteParts(timestamp);
        const task = {
            id: makeId("ping"),
            title: `ping ${profile.name}`,
            targetFileName: "",
            requirement: "",
            directory: path.resolve(profile.defaultDirectory || rootDir),
        };
        runners.set(task.id, {
            stopped: false,
            child: null,
            timer: null,
            startedAt: nowISO(),
            idleSince: null,
            nextRunAt: null,
            activeProcess: null,
            currentRunStartedAt: null,
            lastAgentExitAt: null,
            lastAgentExitCode: null,
            lastAgentSignal: null,
        });
        try {
            const prompt = selectPingPrompt();
            const spawnSpec = buildPingSpawn(profile, prompt, task);
            const pingStartedAt = Date.now();
            const stdoutChunks = [];
            const result = await runProfileCommand({
                profile,
                task,
                prompt,
                spawnSpec,
                onOutput(text, stream) {
                    if (stream === "stdout") {
                        stdoutChunks.push({
                            text,
                            elapsedMs: Date.now() - pingStartedAt,
                        });
                    }
                },
            });
            const output = String(result.output || "");
            const outputDetails = extractPingOutputDetails(result.stdout || output);
            const responseText = String(outputDetails.outputText || "").trim();
            const success = result.exitCode === 0 && outputDetails.isError !== true && responseText.length > 0;
            const outputReason = output.trim().slice(-1000);
            const structuredFailureReason = String(outputDetails.errorText || (!success ? responseText : "")).trim().slice(-1000);
            const failureReason = success
                ? ""
                : result.timedOut
                    ? `超时：超过 ${profile.timeoutSeconds || 1800} 秒`
                    : structuredFailureReason || outputReason || (result.signal ? `进程被信号 ${result.signal} 终止` : `进程退出码 ${result.exitCode ?? "-"}`);
            const firstOutputLatencyMs = firstPingResponseLatency(stdoutChunks, spawnSpec.structuredOutput)
                ?? result.firstOutputLatencyMs
                ?? null;
            const outputTruncated = responseText.length > PING_DETAIL_MAX_CHARS;
            return {
                id: makeId("ping_record"),
                createdAt: timestamp.toISOString(),
                date,
                minute,
                prompt,
                profileId: profile.id,
                profileName: profile.name,
                agentType: profile.agentType,
                modelName: profile.modelName || "",
                model: profile.modelName || `${profile.name} (${profile.agentType})`,
                baseUrl: profile.baseUrl || "",
                pingIntervalMinutes: Math.max(1, Number(profile.pingIntervalMinutes || 60)),
                success,
                exitCode: result.exitCode,
                signal: result.signal || null,
                durationMs: result.durationMs,
                firstOutputLatencyMs,
                firstOutputAt: result.firstOutputAt || null,
                lastOutputAt: result.lastOutputAt || null,
                inputTokens: outputDetails.inputTokens,
                outputTokens: outputDetails.outputTokens,
                totalTokens: outputDetails.totalTokens,
                inputText: prompt,
                outputText: responseText.slice(0, PING_DETAIL_MAX_CHARS),
                outputTruncated,
                failureReason,
                outputTail: output.slice(-1000),
                command: result.commandSummary,
                source,
                taskId,
            };
        } finally {
            runners.delete(task.id);
        }
    }

    async function pingProfilesInOrder(profiles, { source, taskId, cancelled = () => false } = {}) {
        const records = [];
        let availableRecord = null;
        for (const profile of profiles) {
            if (cancelled()) break;
            const record = await pingProfile(profile, { source, taskId });
            records.push(record);
            if (record.success) {
                availableRecord = record;
                break;
            }
        }
        return { records, availableRecord };
    }

    async function runPingRound(runOptions = {}) {
        if (pingInProgress) {
            const error = new Error("Ping 正在运行");
            error.statusCode = 409;
            throw error;
        }
        pingInProgress = true;
        try {
            let state = loadState();
            if (state.pingSettings?.enabled === false) {
                if (runOptions.manual === true) {
                    const error = new Error("Ping feature is disabled");
                    error.statusCode = 409;
                    throw error;
                }
                return [];
            }
            const now = new Date();
            const profiles = state.profiles
                .filter(isPingProfile)
                .filter((profile) => runOptions.dueOnly !== true || isProfileDueForPing(profile, state.pingRecords, now));
            const records = [];
            for (const profile of profiles) {
                records.push(await pingProfile(profile));
            }
            if (records.length === 0) return records;
            state = loadState();
            state.pingRecords = [...records, ...(state.pingRecords || [])].slice(0, 5000);
            addEvent(state, "ping", null, `Ping Profiles：${records.filter((record) => record.success).length}/${records.length} 成功`);
            saveState(state);
            return records;
        } finally {
            pingInProgress = false;
        }
    }

    async function runSingleProfilePing(profile) {
        if (pingInProgress) {
            const error = new Error("Ping 正在运行");
            error.statusCode = 409;
            throw error;
        }
        pingInProgress = true;
        try {
            // A direct profile test is explicit user intent, so it remains
            // available even when scheduled/global Ping is disabled.
            const record = await pingProfile(profile, { source: "manual" });
            const state = loadState();
            state.pingRecords = [record, ...(state.pingRecords || [])].slice(0, 5000);
            addEvent(
                state,
                "ping",
                profile.id,
                `Ping Profile：${profile.name} ${record.success ? "成功" : "失败"}`,
            );
            saveState(state);
            return record;
        } finally {
            pingInProgress = false;
        }
    }

    function startPingScheduler() {
        if (options.disablePingScheduler === true) return;
        const intervalMs = Math.max(1000, Number(options.pingSchedulerTickMs || PING_SCHEDULER_TICK_MS));
        pingTimer = setInterval(() => {
            runPingRound({ dueOnly: true }).catch((error) => {
                const state = loadState();
                addEvent(state, "ping", null, `Ping 失败：${error.message}`);
                saveState(state);
            });
        }, intervalMs);
        pingTimer.unref();
    }

    async function runTaskFileGeneration(taskId, profileId, options = {}) {
        const requireNonEmpty = options.requireNonEmpty !== false;
        let state = loadState();
        let task = findTask(state, taskId);
        if (!task) {
            const error = new Error("任务不存在");
            error.statusCode = 404;
            throw error;
        }
        const profile = findProfile(state, profileId || task.decomposeProfileId);
        if (!profile || !profileSupportsOutput(profile, "text")) {
            const error = new Error("请选择可用的生成 Profile");
            error.statusCode = 400;
            throw error;
        }

        const runId = makeId("run");
        const runStartedAt = nowISO();
        task.lastRunId = runId;
        ensureTaskRunLog(task, runId, {
            startedAt: runStartedAt,
            status: STATUS.running,
        });
        saveState(state);
        const beforeHash = fileHash(task.filePath);
        const prompt = buildTaskGenerationPrompt(task);
        let spawnSpec = null;
        try {
            spawnSpec = prepareSpawnSpecForPlatform(buildSpawn(profile, prompt, task), environmentForProfile(profile, task), task.directory);
        } catch (error) {
            task.status = STATUS.failed;
            task.lastOutput = error.message;
            task.updatedAt = nowISO();
            addEvent(state, "failed", task.id, `生成启动失败：${error.message}`);
            appendTaskLogEvent(task, "generation_failed", `生成启动失败：${error.message}`, {
                runId,
                phase: "generate",
                profile,
                startedAt: runStartedAt,
                runStatus: STATUS.failed,
                metadata: { error: error.message },
            });
            updateTaskRunLog(task, runId, { status: STATUS.failed, endedAt: nowISO() });
            saveState(state);
            error.statusCode = 400;
            throw error;
        }

        task.status = STATUS.running;
        task.nextRunAt = null;
        task.lastPrompt = prompt;
        task.lastCommand = spawnSpec.summary;
        task.lastProfileId = profile.id;
        task.lastProfileName = profile.name;
        task.lastProfileAgentType = profile.agentType;
        task.lastProfileProvider = profile.provider || providerForAgentType(profile.agentType);
        task.lastProfileModelName = profile.modelName || "";
        task.lastRunId = runId;
        task.decomposeProfileId = profile.id;
        task.updatedAt = nowISO();
        saveState(state);

        appendTaskLogEvent(task, "generation_started", `开始生成目标文件：${profile.name} (${profile.agentType})`, {
            runId,
            phase: "generate",
            profile,
            metadata: { directory: task.directory },
        });
        appendTaskLogEvent(task, "profile_config", profileConfigDescription(profile), {
            runId,
            phase: "generate",
            profile,
        });
        appendTaskLogEvent(task, "command", spawnSpec.summary, {
            runId,
            phase: "generate",
            profile,
            legacyText: `工作目录：${task.directory}\n命令：${spawnSpec.summary}`,
            metadata: { directory: task.directory },
        });
        appendTaskLogEvent(task, "prompt", prompt, {
            runId,
            phase: "generate",
            profile,
            legacyText: promptBlock(prompt),
        });
        saveState(state);

        const result = await runProfileCommand({
            profile,
            task,
            prompt,
            spawnSpec,
            onLifecycle: (type, text, metadata) => appendTaskLogEvent(task, type, text, {
                runId,
                phase: "generate",
                profile,
                metadata,
                legacyText: `generate ${text}`,
            }),
            onOutput: (text, stream) => appendTaskLogEvent(task, stream === "error" ? "error" : stream, text, {
                runId,
                phase: "generate",
                profile,
                stream,
                legacyText: formatOutputChunk(`generate ${stream}`, text),
            }),
        });

        state = loadState();
        task = findTask(state, taskId);
        if (!task) {
            return { ok: false, failed: true, result, task: null };
        }

        const stat = safeStat(task.filePath);
        const content = stat?.isFile() ? fs.readFileSync(task.filePath, "utf8") : "";
        const afterHash = fileHash(task.filePath);
        const fileMissing = !stat?.isFile();
        const fileEmpty = requireNonEmpty && content.trim().length === 0;
        const failed = result.exitCode !== 0 || fileMissing || fileEmpty;

        task.status = failed ? STATUS.failed : STATUS.notStarted;
        task.nextRunAt = null;
        task.lastExitCode = result.exitCode;
        task.lastOutput = result.output.slice(-4000);
        task.lastCommand = result.commandSummary;
        task.lastPrompt = prompt;
        task.lastProfileId = profile.id;
        task.lastProfileName = profile.name;
        task.lastProfileAgentType = profile.agentType;
        task.lastProfileProvider = profile.provider || providerForAgentType(profile.agentType);
        task.lastProfileModelName = profile.modelName || "";
        task.lastOutputAt = result.lastOutputAt || null;
        task.lastRunDurationMs = result.durationMs;
        task.lastOutputChunks = result.outputChunks;
        task.lastStdoutBytes = result.stdoutBytes;
        task.lastStderrBytes = result.stderrBytes;
        task.decomposeProfileId = profile.id;
        task.fileMtime = stat?.mtime?.toISOString() || null;
        task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: "", lastHash: afterHash };
        task.updatedAt = nowISO();

        if (failed) {
            const reason = result.exitCode !== 0
                ? `exitCode=${result.exitCode ?? "-"}`
                : fileMissing
                    ? "目标文件未生成"
                    : "目标文件为空";
            addEvent(state, "failed", task.id, `生成目标文件失败：${reason}`);
            appendTaskLogEvent(task, "generation_failed", `生成目标文件失败：${reason}`, {
                runId,
                phase: "generate",
                profile,
                metadata: { reason, exitCode: result.exitCode ?? null },
            });
        } else {
            const changed = beforeHash !== afterHash ? "已更新" : "未检测到内容变化";
            addEvent(state, "generate", task.id, `生成目标文件完成：${task.title}`);
            appendTaskLogEvent(task, "generation_completed", `生成目标文件完成：${changed}`, {
                runId,
                phase: "generate",
                profile,
                metadata: { fileChanged: beforeHash !== afterHash },
            });
        }
        updateTaskRunLog(task, runId, {
            status: failed ? STATUS.failed : STATUS.completed,
            endedAt: nowISO(),
        });
        saveState(state);

        return {
            ok: !failed,
            failed,
            fileChanged: beforeHash !== afterHash,
            result,
            task,
        };
    }

    function scheduleNext(taskId, delayMs) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped) return;
        runner.idleSince = nowISO();
        runner.nextRunAt = new Date(Date.now() + delayMs).toISOString();
        runner.timer = setTimeout(() => {
            runner.timer = null;
            runner.nextRunAt = null;
            runner.idleSince = null;
            runTaskLoop(taskId);
        }, delayMs);
        runner.timer.unref();
    }

    function scheduleInitialRun(taskId, startAt) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped) return;
        const delayMs = Math.max(0, startAt.getTime() - Date.now());
        runner.idleSince = nowISO();
        runner.nextRunAt = startAt.toISOString();
        runner.timer = setTimeout(() => {
            runner.timer = null;
            runner.nextRunAt = null;
            runner.idleSince = null;
            runTaskLoop(taskId);
        }, delayMs);
        runner.timer.unref();
    }

    function availabilityCheckIntervalMs() {
        const configured = Number(options.availabilityCheckIntervalMs);
        return Number.isFinite(configured) && configured > 0
            ? Math.max(1, configured)
            : AVAILABILITY_CHECK_INTERVAL_MS;
    }

    function profileSelectionRetryMs() {
        const configured = Number(options.profileSelectionRetryMs);
        return Number.isFinite(configured) && configured > 0 ? Math.max(1, configured) : 60 * 1000;
    }

    async function selectAvailableProfileForRun(taskId) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped || runner.profileSelecting) return null;
        runner.profileSelecting = true;

        try {
            let state = loadState();
            let task = findTask(state, taskId);
            if (!task || [STATUS.allDone, STATUS.failed, STATUS.stopped].includes(task.status)) return null;

            const profiles = orderedUsableProfiles(state, task);
            if (profiles.length <= 1) {
                runner.profileSelectionRequired = false;
                return { state, task };
            }

            const runId = runner.runId || task.lastRunId || makeId("run");
            runner.runId = runId;
            appendTaskLogEvent(task, "availability_check", "按配置顺序检测执行 Profile 是否可用", {
                runId,
                runStatus: task.status,
                metadata: {
                    source: "task_selection",
                    profileIds: profiles.map((profile) => profile.id),
                },
            });
            saveState(state);

            const { records, availableRecord } = await pingProfilesInOrder(profiles, {
                source: "task_selection",
                taskId,
                cancelled: () => {
                    const activeRunner = runners.get(taskId);
                    return !activeRunner || activeRunner !== runner || activeRunner.stopped;
                },
            });

            state = loadState();
            task = findTask(state, taskId);
            if (records.length > 0) {
                state.pingRecords = [...records].reverse().concat(state.pingRecords || []).slice(0, 5000);
            }
            const activeRunner = runners.get(taskId);
            if (!task || !activeRunner || activeRunner !== runner || activeRunner.stopped
                || [STATUS.allDone, STATUS.failed, STATUS.stopped].includes(task.status)) {
                if (records.length > 0) saveState(state);
                return null;
            }

            task.availabilityLastCheckedAt = nowISO();
            task.updatedAt = nowISO();
            const availableProfile = availableRecord
                ? findProfile(state, availableRecord.profileId)
                : null;
            if (availableProfile && profileSupportsOutput(availableProfile, task.taskType)) {
                task.runProfileId = availableProfile.id;
                activeRunner.profileSelectionRequired = false;
                addEvent(state, "profile_selected", task.id, `按顺序选择可用 Profile：${availableProfile.name}`);
                appendTaskLogEvent(task, "profile_available", `已选择首个可用 Profile：${availableProfile.name}`, {
                    runId,
                    profile: availableProfile,
                    runStatus: STATUS.running,
                    metadata: {
                        source: "task_selection",
                        profileId: availableProfile.id,
                        pingRecordId: availableRecord.id,
                        durationMs: availableRecord.durationMs,
                        attemptedProfileIds: records.map((record) => record.profileId),
                    },
                });
                saveState(state);
                return { state, task };
            }

            const delayMs = profileSelectionRetryMs();
            const nextRunAt = new Date(Date.now() + delayMs).toISOString();
            const failureSummary = records.length > 0
                ? records.map((record) => `${record.profileName}: ${record.failureReason || "不可用"}`).join("；")
                : "没有可检测的执行 Profile";
            task.status = STATUS.retryWait;
            task.retryCount = (task.retryCount || 0) + 1;
            task.nextRunAt = nextRunAt;
            activeRunner.nextRunAt = nextRunAt;
            activeRunner.idleSince = nowISO();
            addEvent(state, "retry", task.id, `执行 Profile 均不可用，稍后按顺序重试：${task.title}`);
            appendTaskLogEvent(task, "availability_wait", `执行 Profile 均不可用：${failureSummary}`, {
                runId,
                runStatus: STATUS.retryWait,
                metadata: {
                    source: "task_selection",
                    reason: "profiles_unavailable",
                    delayMs,
                    nextCheckAt: nextRunAt,
                    pingRecordIds: records.map((record) => record.id),
                },
            });
            updateTaskRunLog(task, runId, { status: STATUS.retryWait, endedAt: null });
            saveState(state);
            scheduleNext(taskId, delayMs);
            return null;
        } finally {
            const activeRunner = runners.get(taskId);
            if (activeRunner === runner) activeRunner.profileSelecting = false;
        }
    }

    function scheduleAvailabilityCheck(taskId, checkAt = new Date()) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped) return;
        if (runner.timer) clearTimeout(runner.timer);
        const scheduledAt = checkAt instanceof Date ? checkAt : new Date(checkAt);
        const validCheckAt = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
        const delayMs = Math.max(0, validCheckAt.getTime() - Date.now());
        runner.scheduleMode = SCHEDULE_MODE.profileAvailable;
        runner.idleSince = nowISO();
        runner.nextRunAt = validCheckAt.toISOString();
        runner.timer = setTimeout(() => {
            runner.timer = null;
            checkTaskProfileAvailability(taskId).catch((error) => {
                const activeRunner = runners.get(taskId);
                if (!activeRunner || activeRunner.stopped) return;
                const state = loadState();
                const task = findTask(state, taskId);
                if (!task || task.status !== STATUS.scheduled
                    || task.scheduleMode !== SCHEDULE_MODE.profileAvailable) return;
                const nextCheckAt = new Date(Date.now() + availabilityCheckIntervalMs()).toISOString();
                task.nextRunAt = nextCheckAt;
                task.availabilityNextCheckAt = nextCheckAt;
                task.updatedAt = nowISO();
                addEvent(state, "availability_wait", task.id, `模型可用性检测失败，30 分钟后重试：${error.message}`);
                appendTaskLogEvent(task, "availability_wait", `模型可用性检测失败：${error.message}`, {
                    runId: activeRunner.runId,
                    runStatus: STATUS.scheduled,
                    metadata: {
                        reason: "check_error",
                        error: error.message,
                        delayMs: availabilityCheckIntervalMs(),
                        nextCheckAt,
                    },
                });
                updateTaskRunLog(task, activeRunner.runId, { status: STATUS.scheduled, endedAt: null });
                saveState(state);
                scheduleAvailabilityCheck(taskId, new Date(nextCheckAt));
            });
        }, delayMs);
        runner.timer.unref();
    }

    async function checkTaskProfileAvailability(taskId) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped || runner.availabilityChecking) return;
        runner.availabilityChecking = true;
        runner.nextRunAt = null;
        runner.idleSince = nowISO();

        try {
            let state = loadState();
            let task = findTask(state, taskId);
            if (!task || task.status !== STATUS.scheduled
                || task.scheduleMode !== SCHEDULE_MODE.profileAvailable) {
                if (task) releaseTaskRunner(task);
                else runners.delete(taskId);
                return;
            }

            const runId = runner.runId || task.lastRunId || makeId("run");
            runner.runId = runId;
            const checkedAt = nowISO();
            const currentCheckAt = task.availabilityNextCheckAt || task.nextRunAt || checkedAt;
            task.availabilityLastCheckedAt = checkedAt;
            task.availabilityNextCheckAt = currentCheckAt;
            task.nextRunAt = currentCheckAt;
            task.updatedAt = checkedAt;
            addEvent(state, "availability_check", task.id, `检测任务 Profile 是否可用：${task.title}`);
            appendTaskLogEvent(task, "availability_check", "开始检测执行 Profile 是否可用", {
                runId,
                runStatus: STATUS.scheduled,
                metadata: {
                    runProfileIds: task.runProfileIds,
                    intervalMinutes: AVAILABILITY_CHECK_INTERVAL_MINUTES,
                },
            });
            saveState(state);

            const profiles = orderedUsableProfiles(state, task);
            const { records, availableRecord } = await pingProfilesInOrder(profiles, {
                source: "task_availability",
                taskId,
                cancelled: () => {
                    const activeRunner = runners.get(taskId);
                    return !activeRunner || activeRunner !== runner || activeRunner.stopped;
                },
            });

            state = loadState();
            task = findTask(state, taskId);
            if (records.length > 0) {
                state.pingRecords = [...records].reverse().concat(state.pingRecords || []).slice(0, 5000);
            }
            const activeRunner = runners.get(taskId);
            if (!task || !activeRunner || activeRunner !== runner || activeRunner.stopped
                || task.status !== STATUS.scheduled
                || task.scheduleMode !== SCHEDULE_MODE.profileAvailable) {
                if (records.length > 0) saveState(state);
                return;
            }

            task.availabilityLastCheckedAt = nowISO();
            task.updatedAt = nowISO();
            if (availableRecord) {
                const profile = state.profiles.find((item) => item.id === availableRecord.profileId) || null;
                task.runProfileId = availableRecord.profileId;
                task.status = STATUS.running;
                task.nextRunAt = null;
                task.availabilityNextCheckAt = null;
                activeRunner.nextRunAt = null;
                activeRunner.idleSince = null;
                activeRunner.profileSelectionRequired = false;
                addEvent(state, "started", task.id, `Profile 可用，启动任务：${task.title}`);
                appendTaskLogEvent(task, "profile_available", `Profile 可用，开始执行：${availableRecord.profileName}`, {
                    runId,
                    profile,
                    runStatus: STATUS.running,
                    metadata: {
                        profileId: availableRecord.profileId,
                        pingRecordId: availableRecord.id,
                        durationMs: availableRecord.durationMs,
                    },
                });
                updateTaskRunLog(task, runId, { status: STATUS.running, endedAt: null });
                saveState(state);
                setImmediate(() => runTaskLoop(taskId));
                return;
            }

            const nextCheckAt = new Date(Date.now() + availabilityCheckIntervalMs()).toISOString();
            const failureSummary = records.length > 0
                ? records.map((record) => `${record.profileName}: ${record.failureReason || "不可用"}`).join("；")
                : "没有可探测的执行 Profile";
            task.status = STATUS.scheduled;
            task.nextRunAt = nextCheckAt;
            task.availabilityNextCheckAt = nextCheckAt;
            activeRunner.nextRunAt = nextCheckAt;
            activeRunner.idleSince = nowISO();
            addEvent(state, "availability_wait", task.id, `Profile 暂不可用，30 分钟后重试：${task.title}`);
            appendTaskLogEvent(task, "availability_wait", `Profile 暂不可用：${failureSummary}`, {
                runId,
                runStatus: STATUS.scheduled,
                metadata: {
                    reason: "profile_unavailable",
                    delayMs: availabilityCheckIntervalMs(),
                    intervalMinutes: AVAILABILITY_CHECK_INTERVAL_MINUTES,
                    nextCheckAt,
                    pingRecordIds: records.map((record) => record.id),
                },
            });
            updateTaskRunLog(task, runId, { status: STATUS.scheduled, endedAt: null });
            saveState(state);
            scheduleAvailabilityCheck(taskId, new Date(nextCheckAt));
        } finally {
            runner.availabilityChecking = false;
        }
    }

    function restoreScheduledTasks() {
        const state = loadState();
        let changed = false;
        for (const task of state.tasks) {
            if (task.status !== STATUS.scheduled || runners.has(task.id)) continue;
            const runId = task.lastRunId || makeId("run");
            const existingRun = (task.logRuns || []).find((run) => run.runId === runId);
            const startedAt = existingRun?.startedAt || task.updatedAt || nowISO();
            const scheduleMode = normalizeScheduleMode(task.scheduleMode, {
                hasStartAt: Boolean(task.scheduledStartAt || task.nextRunAt),
                scheduled: true,
            });
            const nextRunAt = scheduleMode === SCHEDULE_MODE.profileAvailable
                ? task.availabilityNextCheckAt || task.nextRunAt || nowISO()
                : task.scheduledStartAt || task.nextRunAt || nowISO();
            task.lastRunId = runId;
            task.scheduleMode = scheduleMode;
            task.nextRunAt = normalizedDateString(nextRunAt) || nowISO();
            if (scheduleMode === SCHEDULE_MODE.fixedTime) task.scheduledStartAt = task.nextRunAt;
            if (scheduleMode === SCHEDULE_MODE.profileAvailable) {
                task.availabilityCheckIntervalMinutes = AVAILABILITY_CHECK_INTERVAL_MINUTES;
                task.availabilityNextCheckAt = task.nextRunAt;
            }
            ensureTaskRunLog(task, runId, {
                startedAt,
                scheduledAt: task.scheduledStartAt || startedAt,
                status: STATUS.scheduled,
            });
            runners.set(task.id, {
                stopped: false,
                child: null,
                timer: null,
                startedAt,
                idleSince: nowISO(),
                nextRunAt: task.nextRunAt,
                activeProcess: null,
                currentRunStartedAt: null,
                lastAgentExitAt: null,
                lastAgentExitCode: null,
                lastAgentSignal: null,
                runId,
                scheduleMode,
                availabilityChecking: false,
                profileSelectionRequired: selectUsableProfileIds(state, task.runProfileIds, task.taskType).length > 1,
                profileSelecting: false,
            });
            if (scheduleMode === SCHEDULE_MODE.profileAvailable) {
                scheduleAvailabilityCheck(task.id, new Date(task.nextRunAt));
            } else {
                scheduleInitialRun(task.id, new Date(task.nextRunAt));
            }
            changed = true;
        }
        if (changed) saveState(state);
    }

    function beginTaskRun(state, task, options = {}) {
        const usableIds = normalizeProfileIdList(options.usableIds);
        let scheduleMode = normalizeScheduleMode(options.scheduleMode, {
            hasStartAt: Boolean(options.startAt),
        });
        let startAt = options.startAt instanceof Date
            ? options.startAt
            : options.startAt ? new Date(options.startAt) : null;
        if (scheduleMode === SCHEDULE_MODE.fixedTime
            && (!startAt || Number.isNaN(startAt.getTime()) || startAt.getTime() <= Date.now())) {
            scheduleMode = SCHEDULE_MODE.immediate;
            startAt = null;
        }
        const shouldSchedule = scheduleMode !== SCHEDULE_MODE.immediate;
        const scheduledStartAt = scheduleMode === SCHEDULE_MODE.fixedTime ? startAt.toISOString() : null;
        const startedAt = nowISO();
        const availabilityNextCheckAt = scheduleMode === SCHEDULE_MODE.profileAvailable ? startedAt : null;
        const nextRunAt = scheduledStartAt || availabilityNextCheckAt;
        const runId = makeId("run");
        task.runProfileIds = usableIds;
        task.runProfileId = usableIds[0];
        task.lastRunId = runId;
        task.status = shouldSchedule ? STATUS.scheduled : STATUS.running;
        task.retryCount = task.retryCount || 0;
        task.nextRunAt = nextRunAt;
        task.scheduleMode = scheduleMode;
        task.scheduledStartAt = scheduledStartAt;
        task.availabilityCheckIntervalMinutes = scheduleMode === SCHEDULE_MODE.profileAvailable
            ? AVAILABILITY_CHECK_INTERVAL_MINUTES
            : null;
        task.availabilityLastCheckedAt = null;
        task.availabilityNextCheckAt = availabilityNextCheckAt;
        task.queuedAt = null;
        task.queueRunId = null;
        task.queuedDirectory = null;
        task.queuedStart = null;
        task.updatedAt = startedAt;
        ensureTaskRunLog(task, runId, {
            startedAt,
            scheduledAt: shouldSchedule ? scheduledStartAt || startedAt : null,
            status: task.status,
        });
        const scheduleMessage = scheduleMode === SCHEDULE_MODE.profileAvailable
            ? `预约 Profile 可用时启动任务：${task.title}`
            : `预约定时启动任务：${task.title}`;
        const startMessage = options.fromQueue
            ? `从目录队列启动任务：${task.title}`
            : `启动任务：${task.title}`;
        addEvent(
            state,
            shouldSchedule ? "scheduled" : "started",
            task.id,
            shouldSchedule ? scheduleMessage : startMessage,
        );
        saveState(state);
        runners.set(task.id, {
            stopped: false,
            child: null,
            timer: null,
            startedAt,
            idleSince: startedAt,
            nextRunAt,
            activeProcess: null,
            currentRunStartedAt: null,
            lastAgentExitAt: null,
            lastAgentExitCode: null,
            lastAgentSignal: null,
            runId,
            scheduleMode,
            availabilityChecking: false,
            profileSelectionRequired: usableIds.length > 1,
            profileSelecting: false,
        });
        const initialProfile = findProfile(state, usableIds[0]);
        appendTaskLogEvent(
            task,
            shouldSchedule ? "task_scheduled" : "task_started",
            shouldSchedule ? scheduleMessage : startMessage,
            {
                runId,
                profile: initialProfile,
                startedAt,
                scheduledAt: shouldSchedule ? scheduledStartAt || startedAt : null,
                runStatus: task.status,
                metadata: {
                    fromQueue: options.fromQueue === true,
                    queueDirectory: options.fromQueue === true ? queueDirectoryForTask(task) : null,
                    scheduleMode,
                    scheduledStartAt,
                    availabilityNextCheckAt,
                    availabilityCheckIntervalMinutes: task.availabilityCheckIntervalMinutes,
                    runProfileIds: usableIds,
                },
            },
        );
        saveState(state);
        if (scheduleMode === SCHEDULE_MODE.fixedTime) {
            scheduleInitialRun(task.id, startAt);
        } else if (scheduleMode === SCHEDULE_MODE.profileAvailable) {
            scheduleAvailabilityCheck(task.id, new Date(availabilityNextCheckAt));
        } else {
            setImmediate(() => runTaskLoop(task.id));
        }
        return {
            ok: true,
            queued: false,
            runId,
            runProfileIds: usableIds,
            scheduleMode,
            scheduledStartAt,
            availabilityNextCheckAt,
        };
    }

    function enqueueTaskRun(state, task, options = {}) {
        const queuedAt = nowISO();
        const scheduleMode = normalizeScheduleMode(options.scheduleMode, {
            hasStartAt: Boolean(options.startAt),
        });
        const startAt = scheduleMode === SCHEDULE_MODE.fixedTime
            ? normalizedDateString(options.startAt)
            : null;
        task.runProfileIds = normalizeProfileIdList(options.usableIds);
        task.runProfileId = task.runProfileIds[0] || task.runProfileId;
        task.status = STATUS.queued;
        task.queuedAt = queuedAt;
        task.queueRunId = makeId("queue");
        task.queuedStart = {
            profileIds: task.runProfileIds,
            scheduleMode,
            startAt,
        };
        task.queuedDirectory = queueDirectoryForTask(task);
        task.nextRunAt = null;
        task.scheduleMode = scheduleMode;
        task.scheduledStartAt = startAt;
        task.availabilityNextCheckAt = null;
        task.updatedAt = queuedAt;
        const activeTask = directoryActiveTask(state, task.directory, task.id);
        addEvent(state, "queued", task.id, `任务进入目录队列：${task.title}`);
        appendTaskLogEvent(task, "task_queued", `任务进入目录队列，等待 ${activeTask?.title || "前序任务"}`, {
            phase: "setup",
            runStatus: STATUS.queued,
            metadata: {
                projectId: task.projectId,
                directory: task.queuedDirectory,
                activeTaskId: activeTask?.id || null,
                scheduleMode,
                scheduledStartAt: startAt,
                runProfileIds: task.runProfileIds,
            },
        });
        saveState(state);
        const queuePosition = queuedTasksForDirectory(state, task.directory)
            .findIndex((item) => item.id === task.id) + 1;
        return {
            ok: true,
            queued: true,
            runId: task.queueRunId,
            status: STATUS.queued,
            queuePosition,
            projectId: task.projectId,
            queueDirectory: task.queuedDirectory,
            activeTaskId: activeTask?.id || null,
            runProfileIds: task.runProfileIds,
            scheduleMode,
            scheduledStartAt: startAt,
            availabilityNextCheckAt: null,
        };
    }

    function startNextQueuedTask(directory) {
        const state = loadState();
        const queueDirectory = path.resolve(directory || rootDir);
        if (directoryActiveTask(state, queueDirectory)) return null;
        const task = queuedTasksForDirectory(state, queueDirectory)[0];
        if (!task) return null;
        const queuedStart = task.queuedStart || {};
        const usableIds = selectUsableProfileIds(state, queuedStart.profileIds || task.runProfileIds, task.taskType);
        if (usableIds.length === 0) {
            task.status = STATUS.failed;
            task.queuedAt = null;
            task.queueRunId = null;
            task.queuedDirectory = null;
            task.queuedStart = null;
            task.lastOutput = "排队任务没有可用的执行 Profile";
            task.updatedAt = nowISO();
            addEvent(state, "failed", task.id, task.lastOutput);
            appendTaskLogEvent(task, "task_failed", task.lastOutput, {
                runStatus: STATUS.failed,
                metadata: {
                    reason: "queued_profiles_unavailable",
                    directory: queueDirectory,
                },
            });
            saveState(state);
            // Skip unusable queued entries in the same directory without
            // leaving later tasks blocked behind a permanently failed item.
            return startNextQueuedTask(queueDirectory);
        }
        return beginTaskRun(state, task, {
            usableIds,
            scheduleMode: queuedStart.scheduleMode,
            startAt: queuedStart.startAt,
            fromQueue: true,
        });
    }

    const queueAdvancing = new Set();

    function advanceDirectoryQueue(directory) {
        const queueDirectory = path.resolve(directory || rootDir);
        if (runnersClosing || queueAdvancing.has(queueDirectory)) return;
        queueAdvancing.add(queueDirectory);
        setImmediate(() => {
            try {
                if (!runnersClosing) startNextQueuedTask(queueDirectory);
            } catch (error) {
                const state = loadState();
                addEvent(state, "queue_error", null, `目录队列启动失败：${error.message}`);
                saveState(state);
            } finally {
                queueAdvancing.delete(queueDirectory);
            }
        });
    }

    function releaseTaskRunner(task, { advanceQueue = true } = {}) {
        if (!task) return;
        runners.delete(task.id);
        if (advanceQueue) advanceDirectoryQueue(queueDirectoryForTask(task));
    }

    function restoreQueuedTasks() {
        const state = loadState();
        const queueDirectories = new Set(
            state.tasks
                .filter((task) => task.status === STATUS.queued && !task.archived)
                .map((task) => queueDirectoryForTask(task)),
        );
        for (const directory of queueDirectories) {
            if (!directoryActiveTask(state, directory) && queuedTasksForDirectory(state, directory).length > 0) {
                advanceDirectoryQueue(directory);
            }
        }
    }

    async function runTaskLoop(taskId) {
        const runner = runners.get(taskId);
        if (!runner || runner.stopped) return;
        runner.timer = null;
        runner.nextRunAt = null;
        runner.idleSince = null;
        runner.activeProcess = null;

        let state = loadState();
        let task = findTask(state, taskId);
        if (!task) {
            runners.delete(taskId);
            return;
        }
        const runId = runner.runId || makeId("run");
        runner.runId = runId;
        if (runner.profileSelectionRequired === true) {
            const selected = await selectAvailableProfileForRun(taskId);
            if (!selected) return;
            state = selected.state;
            task = selected.task;
        }
        updateTaskRunLog(task, runId, { status: STATUS.running });
        const profile = resolveRunProfile(state, task);
        if (!profile) {
            task.status = STATUS.failed;
            task.lastOutput = "执行 Profile 不存在或已禁用";
            task.lastRunId = runId;
            addEvent(state, "failed", taskId, task.lastOutput);
            appendTaskLogEvent(task, "task_failed", task.lastOutput, {
                runId,
                runStatus: STATUS.failed,
                metadata: { reason: "profile_unavailable" },
            });
            updateTaskRunLog(task, runId, { status: STATUS.failed, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }

        task.status = STATUS.running;
        task.lastRunAt = nowISO();
        task.lastRunId = runId;
        task.nextRunAt = null;

        if (normalizeTaskType(task.taskType) !== "text" && task.artifactDirectory) {
            fs.mkdirSync(task.artifactDirectory, { recursive: true });
        }
        const beforeHash = fileHash(task.filePath);
        const beforeArtifacts = artifactSnapshot(task);
        let prompt = "";
        let spawnSpec = null;
        try {
            prompt = buildPrompt(profile, task);
            spawnSpec = prepareSpawnSpecForPlatform(buildSpawn(profile, prompt, task), environmentForProfile(profile, task), task.directory);
        } catch (error) {
            task.status = STATUS.failed;
            task.lastOutput = error.message;
            task.updatedAt = nowISO();
            addEvent(state, "failed", taskId, `启动失败：${error.message}`);
            appendTaskLogEvent(task, "task_failed", `启动失败：${error.message}`, {
                runId,
                profile,
                runStatus: STATUS.failed,
                metadata: { reason: "spawn_prepare_failed", error: error.message },
            });
            updateTaskRunLog(task, runId, { status: STATUS.failed, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }
        task.lastPrompt = prompt;
        task.lastCommand = spawnSpec.summary;
        task.lastProfileId = profile.id;
        task.lastProfileName = profile.name;
        task.lastProfileAgentType = profile.agentType;
        task.lastProfileProvider = profile.provider || providerForAgentType(profile.agentType);
        task.lastProfileModelName = profile.modelName || "";
        task.updatedAt = nowISO();
        saveState(state);

        appendTaskLogEvent(task, "agent_selected", `Agent 激活：${profile.name} (${profile.agentType})`, {
            runId,
            profile,
            metadata: {
                directory: task.directory,
                retryCount: task.retryCount || 0,
            },
        });
        appendTaskLogEvent(task, "profile_config", profileConfigDescription(profile), {
            runId,
            profile,
        });
        appendTaskLogEvent(task, "command", spawnSpec.summary, {
            runId,
            profile,
            legacyText: `工作目录：${task.directory}\n命令：${spawnSpec.summary}`,
            metadata: { directory: task.directory },
        });
        appendTaskLogEvent(task, "prompt", prompt, {
            runId,
            profile,
            legacyText: promptBlock(prompt),
        });
        saveState(state);

        const result = await runProfileCommand({
            profile,
            task,
            prompt,
            spawnSpec,
            onLifecycle: (type, text, metadata) => appendTaskLogEvent(task, type, text, {
                runId,
                profile,
                metadata,
            }),
            onOutput: (text, stream) => appendTaskLogEvent(task, stream === "error" ? "error" : stream, text, {
                runId,
                profile,
                stream,
                legacyText: formatOutputChunk(stream, text),
            }),
        });

        state = loadState();
        task = findTask(state, taskId);
        if (!task) {
            runners.delete(taskId);
            return;
        }

        task.lastExitCode = result.exitCode;
        task.lastOutput = result.output.slice(-4000);
        task.lastCommand = result.commandSummary;
        task.lastOutputAt = result.lastOutputAt || null;
        task.lastRunDurationMs = result.durationMs;
        task.lastOutputChunks = result.outputChunks;
        task.lastStdoutBytes = result.stdoutBytes;
        task.lastStderrBytes = result.stderrBytes;
        task.fileMtime = safeStat(task.filePath)?.mtime?.toISOString() || null;
        task.updatedAt = nowISO();

        const output = result.output || "";
        const afterHash = fileHash(task.filePath);
        const generatedArtifacts = changedArtifacts(beforeArtifacts, task);

        if (runner.stopped) {
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            addEvent(state, "stopped", taskId, "任务已停止");
            appendTaskLogEvent(task, "task_stopped", "任务已停止", {
                runId,
                profile,
                runStatus: STATUS.stopped,
                metadata: { reason: "user_stop" },
            });
            updateTaskRunLog(task, runId, { status: STATUS.stopped, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }

        if (/429/i.test(output)) {
            task.status = STATUS.retryWait;
            task.retryCount = (task.retryCount || 0) + 1;
            const switched = rotateProfile(state, task);
            if (switched) runner.profileSelectionRequired = true;
            task.nextRunAt = new Date(Date.now() + 300000).toISOString();
            const note = switched ? `检测到 429，切换 Profile：${switched.profileName}，5 分钟后重试` : "检测到 429，5 分钟后重试";
            addEvent(state, "retry", taskId, note);
            if (switched) {
                appendTaskLogEvent(task, "profile_switched", `切换 Profile：${switched.previousProfileName} → ${switched.profileName}`, {
                    runId,
                    profile: switched.profile,
                    metadata: {
                        reason: "429",
                        previousProfileId: switched.previousProfileId,
                        previousProfileName: switched.previousProfileName,
                        profileId: switched.profileId,
                        profileName: switched.profileName,
                    },
                });
            }
            appendTaskLogEvent(task, "retry_wait", note, {
                runId,
                profile: switched?.profile || profile,
                metadata: { reason: "429", delayMs: 300000, retryCount: task.retryCount },
            });
            updateTaskRunLog(task, runId, { status: STATUS.retryWait, endedAt: null });
            saveState(state);
            scheduleNext(taskId, 300000);
            return;
        }

        if (normalizeTaskType(task.taskType) !== "text" && result.exitCode === 0 && generatedArtifacts.length > 0) {
            task.status = STATUS.allDone;
            task.nextRunAt = null;
            task.lastArtifactPaths = generatedArtifacts.map((artifact) => artifact.relativePath);
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: "", lastHash: afterHash };
            addEvent(state, "all_done", taskId, `已生成 ${generatedArtifacts.length} 个${task.taskType}产物`);
            appendTaskLogEvent(task, "task_all_done", `媒体产物生成完成：${generatedArtifacts.map((artifact) => artifact.relativePath).join(", ")}`, {
                runId,
                profile,
                runStatus: STATUS.allDone,
                metadata: { artifacts: generatedArtifacts.map((artifact) => artifact.relativePath) },
            });
            updateTaskRunLog(task, runId, { status: STATUS.allDone, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }

        if (normalizeTaskType(task.taskType) === "text" && isAllDoneOutput(output)) {
            task.status = STATUS.allDone;
            task.nextRunAt = null;
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: "", lastHash: afterHash };
            addEvent(state, "all_done", taskId, "目标文件中任务全部完成");
            appendTaskLogEvent(task, "task_all_done", "全部完成，停止循环", {
                runId,
                profile,
                runStatus: STATUS.allDone,
            });
            updateTaskRunLog(task, runId, { status: STATUS.allDone, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }

        if (normalizeTaskType(task.taskType) === "text" && output.includes("任务完成")) {
            task.status = STATUS.completed;
            task.nextRunAt = new Date(Date.now() + 10000).toISOString();
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: output, lastHash: afterHash };
            addEvent(state, "completed", taskId, "单轮任务完成，10 秒后继续");
            appendTaskLogEvent(task, "task_completed", "任务完成，10 秒后继续下一轮", {
                runId,
                profile,
                runStatus: STATUS.completed,
                metadata: { delayMs: 10000 },
            });
            updateTaskRunLog(task, runId, { status: STATUS.completed, endedAt: null });
            saveState(state);
            scheduleNext(taskId, 10000);
            return;
        }

        const previousLoop = task.loop || {};
        const sameOutput = output === previousLoop.lastOutput;
        const unchangedResult = normalizeTaskType(task.taskType) === "text"
            ? afterHash === beforeHash
            : generatedArtifacts.length === 0;
        const stallCount = sameOutput && unchangedResult ? (previousLoop.stallCount || 1) + 1 : 1;

        task.loop = {
            lastOutput: output,
            lastHash: afterHash,
            stallCount,
        };

        if (stallCount >= 3) {
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            const stallMessage = normalizeTaskType(task.taskType) === "text"
                ? "连续 3 次输出相同且任务文件无改动，停止循环"
                : "连续 3 次输出相同且未生成新媒体产物，停止循环";
            addEvent(state, "stopped", taskId, stallMessage);
            appendTaskLogEvent(task, "task_stopped", stallMessage, {
                runId,
                profile,
                runStatus: STATUS.stopped,
                metadata: { reason: "stalled", stallCount },
            });
            updateTaskRunLog(task, runId, { status: STATUS.stopped, endedAt: nowISO() });
            saveState(state);
            releaseTaskRunner(task);
            return;
        }

        task.status = STATUS.retryWait;
        task.retryCount = (task.retryCount || 0) + 1;
        const switched = rotateProfile(state, task);
        if (switched) runner.profileSelectionRequired = true;
        task.nextRunAt = new Date(Date.now() + 60000).toISOString();
        const missingArtifact = normalizeTaskType(task.taskType) !== "text" && generatedArtifacts.length === 0;
        const retryReason = missingArtifact ? "未检测到新媒体产物" : "其他输出";
        const retryNote = switched
            ? `${retryReason}，切换 Profile：${switched.profileName}，1 分钟后重试`
            : `${retryReason}，1 分钟后重试`;
        addEvent(state, "retry", taskId, retryNote);
        if (switched) {
            appendTaskLogEvent(task, "profile_switched", `切换 Profile：${switched.previousProfileName} → ${switched.profileName}`, {
                runId,
                profile: switched.profile,
                metadata: {
                    reason: retryReason,
                    previousProfileId: switched.previousProfileId,
                    previousProfileName: switched.previousProfileName,
                    profileId: switched.profileId,
                    profileName: switched.profileName,
                },
            });
        }
        appendTaskLogEvent(task, "retry_wait", `${retryNote}。停滞计数：${stallCount}/3`, {
            runId,
            profile: switched?.profile || profile,
            metadata: {
                reason: retryReason,
                delayMs: 60000,
                retryCount: task.retryCount,
                stallCount,
            },
        });
        updateTaskRunLog(task, runId, { status: STATUS.retryWait, endedAt: null });
        saveState(state);
        scheduleNext(taskId, 60000);
    }

    async function readJson(request) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body.trim()) return {};
        return JSON.parse(body);
    }

    function sendJson(response, statusCode, payload) {
        response.writeHead(statusCode, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        });
        response.end(JSON.stringify(payload));
    }

    function decodePathSegment(value, label = "路径参数") {
        try {
            return decodeURIComponent(String(value || ""));
        } catch {
            const error = new Error(`${label}编码无效`);
            error.statusCode = 400;
            throw error;
        }
    }

    function sendText(response, statusCode, text, type = "text/plain; charset=utf-8") {
        response.writeHead(statusCode, {
            "content-type": type,
            "cache-control": "no-store",
        });
        response.end(text);
    }

    function sendFile(response, filePath, contentType) {
        const stat = fs.statSync(filePath);
        response.writeHead(200, {
            "content-type": contentType || "application/octet-stream",
            "content-length": stat.size,
            "content-disposition": `inline; filename=${JSON.stringify(path.basename(filePath))}`,
            "cache-control": "no-store",
        });
        response.end(fs.readFileSync(filePath));
    }

    function serveStatic(request, response, pathname) {
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        const filePath = path.resolve(publicDir, relative);
        if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
            sendText(response, 403, "Forbidden");
            return;
        }
        const stat = safeStat(filePath);
        if (!stat || !stat.isFile()) {
            sendText(response, 404, "Not found");
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
        };
        sendText(response, 200, fs.readFileSync(filePath), types[ext] || "application/octet-stream");
    }

    async function handleApi(request, response, url) {
        const method = request.method || "GET";
        const pathname = url.pathname;

        if (method === "GET" && pathname === "/api/state") {
            sendJson(response, 200, publicState());
            return;
        }

        if (method === "POST" && pathname === "/api/pings/run") {
            const records = await runPingRound({ manual: true });
            sendJson(response, 200, {
                ok: true,
                records,
                pingDays: pingDays(records),
            });
            return;
        }

        if (method === "POST" && pathname === "/api/pings/settings") {
            const body = await readJson(request);
            const state = loadState();
            state.pingSettings = {
                ...(state.pingSettings || {}),
                enabled: body.enabled !== false,
            };
            addEvent(state, "ping", null, state.pingSettings.enabled ? "Ping enabled" : "Ping disabled");
            saveState(state);
            sendJson(response, 200, { ok: true, pingSettings: state.pingSettings });
            return;
        }

        const profilePingMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/ping$/);
        if (method === "POST" && profilePingMatch) {
            const state = loadState();
            const id = decodePathSegment(profilePingMatch[1], "Profile ID");
            const profile = state.profiles.find((item) => item.id === id);
            if (!profile) {
                sendJson(response, 404, { error: "Profile 不存在" });
                return;
            }
            const record = await runSingleProfilePing(profile);
            sendJson(response, 200, {
                ok: true,
                record,
            });
            return;
        }

        if (method === "POST" && pathname === "/api/profiles") {
            const body = await readJson(request);
            const state = loadState();
            const existing = body.id ? state.profiles.find((profile) => profile.id === body.id) : null;
            const rawConfigDirectory = String(body.configDirectory ?? existing?.configDirectory ?? "").trim();
            const rawApiToken = String(body.apiToken ?? "");
            const apiToken = existing && rawApiToken === "" ? String(existing.apiToken || "") : rawApiToken;
            const profile = {
                id: existing?.id || makeId("profile"),
                name: String(body.name || existing?.name || "new-profile").trim(),
                agentType: String(body.agentType || existing?.agentType || "claude").trim(),
                provider: String(body.provider || existing?.provider || providerForAgentType(body.agentType || existing?.agentType || "claude")).trim().toLowerCase(),
                inputModalities: normalizeModalities(body.inputModalities ?? existing?.inputModalities, ["text"]),
                outputModalities: normalizeModalities(body.outputModalities ?? existing?.outputModalities, ["text"]),
                command: String(body.command || existing?.command || "claude").trim(),
                args: String(body.args ?? existing?.args ?? "-p {prompt}"),
                envText: String(body.envText ?? existing?.envText ?? ""),
                promptTemplate: String(body.promptTemplate || existing?.promptTemplate || DEFAULT_RUN_PROMPT),
                mediaPromptTemplate: String(body.mediaPromptTemplate ?? existing?.mediaPromptTemplate ?? ""),
                timeoutSeconds: Math.max(1, Number(body.timeoutSeconds || existing?.timeoutSeconds || 1800)),
                baseUrl: String(body.baseUrl ?? existing?.baseUrl ?? "").trim(),
                apiToken,
                modelName: String(body.modelName ?? existing?.modelName ?? "").trim(),
                pingIntervalMinutes: Math.max(1, Number(body.pingIntervalMinutes || existing?.pingIntervalMinutes || 60)),
                pingEnabled: body.pingEnabled !== false,
                enabled: body.enabled !== false,
                nonInteractive: body.nonInteractive !== false,
                defaultDirectory: path.resolve(body.defaultDirectory || existing?.defaultDirectory || rootDir),
                configDirectory: rawConfigDirectory ? path.resolve(rawConfigDirectory) : "",
                createdAt: existing?.createdAt || nowISO(),
                updatedAt: nowISO(),
            };
            if (!profile.name || !profile.command) {
                sendJson(response, 400, { error: "Profile 名称和运行命令不能为空" });
                return;
            }
            if (!profile.inputModalities.includes("text")) {
                sendJson(response, 400, { error: "当前任务调用至少需要支持文本输入" });
                return;
            }
            if (existing) {
                Object.assign(existing, profile);
            } else {
                state.profiles.push(profile);
            }
            addEvent(state, "profile", null, `保存 Profile：${profile.name}`);
            saveState(state);
            sendJson(response, 200, { ok: true, profile: profileForClient(profile) });
            return;
        }

        const deleteProfileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
        if (method === "DELETE" && deleteProfileMatch) {
            const state = loadState();
            const id = decodeURIComponent(deleteProfileMatch[1]);
            state.profiles = state.profiles.filter((profile) => profile.id !== id);
            addEvent(state, "profile", null, `删除 Profile：${id}`);
            saveState(state);
            sendJson(response, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/projects") {
            const body = await readJson(request);
            const state = loadState();
            const existing = body.id ? findProject(state, String(body.id)) : null;
            if (body.id && !existing) {
                sendJson(response, 404, { error: "项目不存在" });
                return;
            }
            const name = String(body.name || existing?.name || "").trim();
            if (!name) {
                sendJson(response, 400, { error: "项目名称不能为空" });
                return;
            }
            const rawDirectory = String(body.directory ?? existing?.directory ?? "").trim();
            let directory = "";
            if (rawDirectory) {
                try {
                    directory = resolveDirectory(state, rawDirectory);
                } catch (error) {
                    sendJson(response, error.statusCode || 400, { error: error.message });
                    return;
                }
            }
            if (existing && existing.directory !== directory
                && state.tasks.some((task) => task.projectId === existing.id)) {
                sendJson(response, 409, { error: "项目已有任务，不能更换绑定目录" });
                return;
            }
            const duplicate = state.projects.find((project) => project.id !== existing?.id && project.name === name);
            if (duplicate) {
                sendJson(response, 409, { error: "项目名称已存在" });
                return;
            }
            const project = normalizeProject({
                ...existing,
                id: existing?.id || makeId("project"),
                name,
                directory,
                createdAt: existing?.createdAt || nowISO(),
                updatedAt: nowISO(),
            }, state.projects.length);
            if (existing) Object.assign(existing, project);
            else state.projects.push(project);
            addEvent(state, "project", null, `${existing ? "更新" : "创建"}项目：${project.name}`);
            saveState(state);
            sendJson(response, 200, { ok: true, project });
            return;
        }

        const deleteProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (method === "DELETE" && deleteProjectMatch) {
            const state = loadState();
            const id = decodePathSegment(deleteProjectMatch[1], "项目 ID");
            const project = findProject(state, id);
            if (!project) {
                sendJson(response, 404, { error: "项目不存在" });
                return;
            }
            if (state.tasks.some((task) => task.projectId === id)) {
                sendJson(response, 409, { error: "项目仍包含任务，不能删除" });
                return;
            }
            if (state.projects.length <= 1) {
                sendJson(response, 409, { error: "至少保留一个项目" });
                return;
            }
            state.projects = state.projects.filter((item) => item.id !== id);
            addEvent(state, "project", null, `删除项目：${project.name}`);
            saveState(state);
            sendJson(response, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/directories") {
            const body = await readJson(request);
            const directory = path.resolve(String(body.directory || ""));
            if (!safeStat(directory)?.isDirectory()) {
                sendJson(response, 400, { error: "目录不存在或不可访问" });
                return;
            }
            const state = loadState();
            if (!state.directories.includes(directory)) state.directories.push(directory);
            addEvent(state, "directory", null, `添加工作目录：${directory}`);
            saveState(state);
            sendJson(response, 200, { ok: true, directory });
            return;
        }

        const deleteDirectoryMatch = pathname.match(/^\/api\/directories\/(.+)$/);
        if (method === "DELETE" && deleteDirectoryMatch) {
            const directory = path.resolve(decodeURIComponent(deleteDirectoryMatch[1]));
            const state = loadState();
            if (directory === rootDir) {
                sendJson(response, 400, { error: "默认目录不能删除" });
                return;
            }
            const boundProject = state.projects.find((project) => project.directory === directory);
            if (boundProject) {
                sendJson(response, 409, { error: `目录已绑定项目：${boundProject.name}` });
                return;
            }
            const directoryTask = state.tasks.find((task) => path.resolve(task.directory || rootDir) === directory);
            if (directoryTask) {
                sendJson(response, 409, { error: `目录仍包含任务：${directoryTask.title}` });
                return;
            }
            state.directories = state.directories.filter((item) => path.resolve(item) !== directory);
            addEvent(state, "directory", null, `删除工作目录：${directory}`);
            saveState(state);
            sendJson(response, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/tasks") {
            const body = await readJson(request);
            const state = loadState();
            const requestedDirectory = String(body.directory || rootDir);
            const requestedProjectId = String(body.projectId || body.project || "").trim();
            let project = requestedProjectId ? findProject(state, requestedProjectId) : null;
            if (requestedProjectId && !project) {
                sendJson(response, 400, { error: "请选择有效项目" });
                return;
            }
            if (!project) {
                const resolvedRequestedDirectory = resolveDirectory(state, requestedDirectory);
                project = state.projects.find((item) => item.directory === resolvedRequestedDirectory);
                if (!project) {
                    const baseProjectName = path.basename(resolvedRequestedDirectory) || resolvedRequestedDirectory;
                    const projectName = state.projects.some((item) => item.name === baseProjectName)
                        ? `${baseProjectName} · ${resolvedRequestedDirectory}`
                        : baseProjectName;
                    project = normalizeProject({
                        id: legacyProjectId(resolvedRequestedDirectory),
                        name: projectName,
                        directory: resolvedRequestedDirectory,
                        createdAt: nowISO(),
                        updatedAt: nowISO(),
                    }, state.projects.length);
                    state.projects.push(project);
                    addEvent(state, "project", null, `为工作目录创建项目：${project.name}`);
                }
            }
            const directory = project?.directory
                ? resolveDirectory(state, project.directory)
                : resolveDirectory(state, requestedDirectory);
            const title = String(body.title || "任务目标").trim();
            const requirement = String(body.requirement || "").trim();
            const taskType = normalizeTaskType(body.taskType);
            const sourceMode = normalizeTaskSourceMode(body.sourceMode, body);
            const targetFileName = safeTaskFileName(body.targetFileName || `${title}.md`);
            const filePath = resolveTaskFile(directory, targetFileName);
            const explicitRunProfileIds = normalizeProfileIdList(body.runProfileIds);
            const requestedRunProfileIds = explicitRunProfileIds.length
                ? explicitRunProfileIds
                : normalizeProfileIdList([body.runProfileId, body.decomposeProfileId]);
            const runProfileIds = selectUsableProfileIds(state, requestedRunProfileIds, taskType);
            if (requestedRunProfileIds.length > 0 && runProfileIds.length === 0) {
                sendJson(response, 400, { error: `请选择支持 ${taskType} 输出的执行 Profile` });
                return;
            }
            const generationProfile = sourceMode === "agent" ? findProfile(state, body.decomposeProfileId || runProfileIds[0]) : null;
            if (sourceMode === "agent" && (!generationProfile || !profileSupportsOutput(generationProfile, "text"))) {
                sendJson(response, 400, { error: "请选择可用的生成 Profile" });
                return;
            }
            if (sourceMode === "agent" && !requirement) {
                sendJson(response, 400, { error: "Agent 生成模式需要填写任务需求" });
                return;
            }

            const existingStat = safeStat(filePath);
            const hasExistingFile = Boolean(existingStat?.isFile());
            if (sourceMode === "existing") {
                if (!hasExistingFile) {
                    sendJson(response, 400, { error: "目标任务文件不存在，无法载入" });
                    return;
                }
            } else if (hasExistingFile && body.overwrite !== true) {
                sendJson(response, 409, { error: "目标任务文件已存在，请换一个文件名或确认覆盖" });
                return;
            }

            const taskId = makeId("task");
            const requestedOutputFormat = normalizeMediaFormat(taskType, body.outputFormat);
            const outputFileName = taskType === "text"
                ? ""
                : safeOutputFileName(body.outputFileName, taskType, requestedOutputFormat);
            const outputFormat = taskType === "text"
                ? ""
                : path.extname(outputFileName).slice(1).toLowerCase() || requestedOutputFormat;
            const artifact = taskType === "text"
                ? { name: "", path: "" }
                : resolveArtifactDirectory(directory, body.artifactDirectoryName, taskId);
            const aspectRatio = taskType === "text" ? "" : String(body.aspectRatio || "").trim();
            const resolution = taskType === "text" ? "" : String(body.resolution || "").trim();
            const durationSeconds = taskType === "video" ? normalizeDurationSeconds(body.durationSeconds) : null;
            const referenceFiles = taskType === "text" ? [] : resolveReferenceFiles(directory, body.referenceFiles);
            if (artifact.path) fs.mkdirSync(artifact.path, { recursive: true });
            const outputFile = artifact.path && outputFileName ? path.join(artifact.path, outputFileName) : "";

            if (sourceMode === "upload") {
                if (!Object.prototype.hasOwnProperty.call(body, "sourceContent")) {
                    sendJson(response, 400, { error: "请先选择要导入的任务目标文件" });
                    return;
                }
                fs.writeFileSync(filePath, String(body.sourceContent ?? ""), "utf8");
            } else if (sourceMode === "template") {
                fs.writeFileSync(filePath, generateTaskMarkdown({
                    title,
                    requirement,
                    taskType,
                    artifactDirectory: artifact.path,
                    outputFile,
                    outputFormat,
                    aspectRatio,
                    resolution,
                    durationSeconds,
                    referenceFiles,
                }), "utf8");
            } else if (sourceMode === "agent") {
                fs.writeFileSync(filePath, "", "utf8");
            }

            const logTitle = (safeTaskFileName(title).replace(/\.md$/i, "").slice(0, 120) || "task");
            const logFile = `${taskId}-${Date.now()}-${logTitle}.log`;
            const task = {
                id: taskId,
                title,
                requirement,
                taskType,
                sourceMode,
                targetFileName,
                filePath,
                directory,
                artifactDirectoryName: artifact.name,
                artifactDirectory: artifact.path,
                outputFileName,
                outputFormat,
                aspectRatio,
                resolution,
                durationSeconds,
                referenceFiles,
                projectId: project.id,
                decomposeProfileId: generationProfile?.id || body.decomposeProfileId || "",
                runProfileId: runProfileIds[0] || "",
                runProfileIds,
                status: STATUS.notStarted,
                retryCount: 0,
                lastExitCode: null,
                lastOutput: "",
                lastCommand: "",
                lastPrompt: "",
                nextRunAt: null,
                scheduleMode: SCHEDULE_MODE.immediate,
                scheduledStartAt: null,
                availabilityCheckIntervalMinutes: null,
                availabilityLastCheckedAt: null,
                availabilityNextCheckAt: null,
                logFile,
                logEventsFile: taskLogEventsFileName({ id: taskId, logFile }),
                logRuns: [],
                loop: { stallCount: 0, lastOutput: "", lastHash: fileHash(filePath) },
                createdAt: nowISO(),
                updatedAt: nowISO(),
            };
            state.tasks.unshift(task);
            const createMessages = {
                agent: `创建任务并准备 Agent 生成：${task.title}`,
                existing: `载入任务文件：${task.title}`,
                upload: `导入任务文件：${task.title}`,
                template: `创建任务：${task.title}`,
            };
            addEvent(state, "task", task.id, createMessages[sourceMode] || `创建任务：${task.title}`);
            saveState(state);
            appendTaskLogEvent(task, "task_created", createMessages[sourceMode] || "创建任务", {
                phase: "setup",
                legacyText: `${createMessages[sourceMode] || "创建任务"}\n目标文件：${filePath}`,
                metadata: { filePath, sourceMode },
            });

            if (sourceMode === "agent") {
                const generation = await runTaskFileGeneration(task.id, generationProfile.id);
                sendJson(response, 200, {
                    ok: generation.ok,
                    task: generation.task || task,
                    generation: {
                        ok: generation.ok,
                        failed: generation.failed,
                        exitCode: generation.result.exitCode,
                        fileChanged: generation.fileChanged,
                        output: generation.result.output,
                    },
                });
                return;
            }

            sendJson(response, 200, { ok: true, task });
            return;
        }

        const taskAppendMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(?:items|append|append-item|append-items|append-task|append-tasks|append-task-items|add|add-item|add-items|add-task|add-tasks|task-items|tasks)\/?$/);
        if (["POST", "PATCH", "PUT"].includes(method) && taskAppendMatch) {
            let body;
            try {
                body = await readJson(request);
            } catch {
                sendJson(response, 400, { error: "请求体必须是有效的 JSON" });
                return;
            }
            const state = loadState();
            const task = findTask(state, decodePathSegment(taskAppendMatch[1], "任务 ID"));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const items = extractAppendedTaskItems(body);
            const result = appendTaskItems(state, task, items);
            sendJson(response, 200, {
                ...result,
                taskItems: result.items,
                addedItems: result.items,
                newItems: result.items,
            });
            return;
        }

        const taskArchiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
        if (method === "POST" && taskArchiveMatch) {
            const state = loadState();
            const task = findTask(state, decodePathSegment(taskArchiveMatch[1], "任务 ID"));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const archivedTask = archiveTask(state, task);
            sendJson(response, 200, {
                ok: true,
                task: archivedTask,
                archiveDirectory: archivedTask.archiveDirectory,
                filePath: archivedTask.filePath,
            });
            return;
        }

        const taskArtifactMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/artifact$/);
        if (method === "GET" && taskArtifactMatch) {
            const state = loadState();
            const task = findTask(state, decodeURIComponent(taskArtifactMatch[1]));
            if (!task || normalizeTaskType(task.taskType) === "text" || !task.artifactDirectory) {
                sendJson(response, 404, { error: "媒体产物不存在" });
                return;
            }
            const relativePath = String(url.searchParams.get("path") || "").trim();
            const requestedPath = path.resolve(task.artifactDirectory, relativePath);
            if (!relativePath || requestedPath === task.artifactDirectory || !requestedPath.startsWith(`${task.artifactDirectory}${path.sep}`)) {
                sendJson(response, 400, { error: "产物路径无效" });
                return;
            }
            const extension = path.extname(requestedPath).slice(1).toLowerCase();
            if (!MEDIA_FORMATS[normalizeTaskType(task.taskType)]?.has(extension) || !safeStat(requestedPath)?.isFile()) {
                sendJson(response, 404, { error: "媒体产物不存在" });
                return;
            }
            const realRoot = fs.realpathSync(task.artifactDirectory);
            const realFile = fs.realpathSync(requestedPath);
            if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
                sendJson(response, 403, { error: "产物路径越界" });
                return;
            }
            sendFile(response, realFile, MEDIA_CONTENT_TYPES[path.extname(realFile).toLowerCase()]);
            return;
        }

        const taskFileMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/file$/);
        if (taskFileMatch) {
            const state = loadState();
            const task = findTask(state, decodeURIComponent(taskFileMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            if (method === "GET") {
                const verifiedFilePath = verifiedTaskFilePath(task);
                sendJson(response, 200, {
                    content: fs.existsSync(verifiedFilePath) ? fs.readFileSync(verifiedFilePath, "utf8") : "",
                    filePath: verifiedFilePath,
                });
                return;
            }
            if (method === "PUT") {
                if (task.archived) {
                    sendJson(response, 409, { error: "归档任务为只读，不能编辑" });
                    return;
                }
                const verifiedFilePath = verifiedTaskFilePath(task);
                const body = await readJson(request);
                fs.writeFileSync(verifiedFilePath, String(body.content || ""), "utf8");
                task.updatedAt = nowISO();
                task.fileMtime = safeStat(verifiedFilePath)?.mtime?.toISOString() || null;
                addEvent(state, "task", task.id, `保存任务文件：${task.targetFileName}`);
                saveState(state);
                appendTaskLogEvent(task, "task_file_saved", `保存任务文件：${verifiedFilePath}`, {
                    phase: "setup",
                    metadata: { filePath: verifiedFilePath },
                });
                sendJson(response, 200, { ok: true });
                return;
            }
        }

        const taskLogMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs?(?:\/([^/]+))?\/?$/);
        if (method === "GET" && taskLogMatch) {
            const state = loadState();
            const task = findTask(state, decodePathSegment(taskLogMatch[1], "任务 ID"));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const afterValue = Number(url.searchParams.get("after") || 0);
            const afterSequence = Number.isFinite(afterValue) && afterValue > 0 ? Math.trunc(afterValue) : 0;
            const pathRunId = taskLogMatch[2] ? decodePathSegment(taskLogMatch[2], "运行 ID") : "";
            const queryRunId = String(url.searchParams.get("runId") || "").trim();
            const fullContent = ["1", "true"].includes(String(url.searchParams.get("full") || "").toLowerCase());
            const payload = buildTaskLogPayload(task, {
                afterSequence,
                runId: pathRunId || queryRunId,
                fullContent,
            });
            if (!payload) {
                sendJson(response, 404, { error: "任务运行日志不存在" });
                return;
            }
            sendJson(response, 200, payload);
            return;
        }

        const taskStartMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/start$/);
        if (method === "POST" && taskStartMatch) {
            const body = await readJson(request);
            const state = loadState();
            const task = findTask(state, decodeURIComponent(taskStartMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            if (task.archived) {
                sendJson(response, 409, { error: "归档任务不能启动" });
                return;
            }
            if (task.status === STATUS.queued) {
                sendJson(response, 409, { error: "任务已经在目录队列中" });
                return;
            }
            if (runners.has(task.id)) {
                sendJson(response, 409, { error: "任务已经在运行" });
                return;
            }
            const requestedIds = normalizeProfileIdList(body.profileIds).length
                ? normalizeProfileIdList(body.profileIds)
                : normalizeProfileIdList(body.runProfileIds).length
                    ? normalizeProfileIdList(body.runProfileIds)
                    : normalizeProfileIdList([body.profileId, task.runProfileId, ...(task.runProfileIds || [])]);
            const usableIds = selectUsableProfileIds(state, requestedIds, task.taskType);
            if (usableIds.length === 0) {
                sendJson(response, 400, { error: `请选择支持 ${task.taskType} 输出的执行 Profile` });
                return;
            }
            const rawStartAt = String(body.startAt || "").trim();
            const hasExplicitScheduleMode = String(body.scheduleMode || "").trim().length > 0;
            let scheduleMode = normalizeScheduleMode(body.scheduleMode, { hasStartAt: Boolean(rawStartAt) });
            const startAt = rawStartAt ? new Date(rawStartAt) : null;
            if (rawStartAt && Number.isNaN(startAt.getTime())) {
                sendJson(response, 400, { error: "预约启动时间无效" });
                return;
            }
            if (scheduleMode === SCHEDULE_MODE.fixedTime && !startAt) {
                sendJson(response, 400, { error: "请选择预约启动时间" });
                return;
            }
            if (scheduleMode === SCHEDULE_MODE.fixedTime && startAt.getTime() <= Date.now()) {
                if (hasExplicitScheduleMode) {
                    sendJson(response, 400, { error: "请选择未来的预约时间" });
                    return;
                }
                scheduleMode = SCHEDULE_MODE.immediate;
            }
            const activeTask = directoryActiveTask(state, task.directory, task.id);
            const result = activeTask
                ? enqueueTaskRun(state, task, { usableIds, scheduleMode, startAt })
                : beginTaskRun(state, task, { usableIds, scheduleMode, startAt });
            sendJson(response, 200, result);
            return;
        }

        const taskStopMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
        if (method === "POST" && taskStopMatch) {
            const state = loadState();
            const task = findTask(state, decodeURIComponent(taskStopMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const runner = runners.get(task.id);
            const runId = runner?.runId || `${task.id}:lifecycle`;
            let queueAdvanceAttached = false;
            if (runner) {
                runner.stopped = true;
                if (runner.timer) clearTimeout(runner.timer);
                if (runner.child && isChildActive(runner.child)) {
                    queueAdvanceAttached = true;
                    runner.child.once("close", () => advanceDirectoryQueue(queueDirectoryForTask(task)));
                    runner.child.kill("SIGTERM");
                }
                runners.delete(task.id);
            }
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            task.availabilityNextCheckAt = null;
            task.queuedAt = null;
            task.queueRunId = null;
            task.queuedDirectory = null;
            task.queuedStart = null;
            addEvent(state, "stopped", task.id, `停止任务：${task.title}`);
            appendTaskLogEvent(task, "user_stopped", "用户停止任务", {
                runId,
                profile: findProfile(state, task.runProfileId),
                persistRun: Boolean(runner),
                runStatus: STATUS.stopped,
                metadata: { hadActiveRunner: Boolean(runner) },
            });
            if (runner) updateTaskRunLog(task, runId, { status: STATUS.stopped, endedAt: nowISO() });
            saveState(state);
            if (!queueAdvanceAttached) advanceDirectoryQueue(queueDirectoryForTask(task));
            sendJson(response, 200, { ok: true });
            return;
        }

        const generateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(?:decompose|generate)$/);
        if (method === "POST" && generateMatch) {
            const body = await readJson(request);
            const state = loadState();
            const task = findTask(state, decodeURIComponent(generateMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            if (task.archived) {
                sendJson(response, 409, { error: "归档任务不能重新生成目标文件" });
                return;
            }
            const generation = await runTaskFileGeneration(task.id, body.profileId || task.decomposeProfileId);
            sendJson(response, 200, {
                ok: generation.ok,
                failed: generation.failed,
                exitCode: generation.result.exitCode,
                output: generation.result.output,
                fileChanged: generation.fileChanged,
                task: generation.task,
            });
            return;
        }

        sendJson(response, 404, { error: "API 不存在" });
    }

    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url || "/", "http://localhost");
            if (url.pathname.startsWith("/api/")) {
                await handleApi(request, response, url);
                return;
            }
            serveStatic(request, response, url.pathname);
        } catch (error) {
            sendJson(response, error.statusCode || 500, { error: error.message || "服务器错误" });
        }
    });

    server.inject = async ({ method = "GET", path: requestPath = "/", body = null } = {}) => {
        const payload = body === null ? "" : JSON.stringify(body);
        const request = {
            method,
            url: requestPath,
            async *[Symbol.asyncIterator]() {
                if (payload) yield Buffer.from(payload);
            },
        };
        return new Promise((resolve) => {
            const response = {
                statusCode: 200,
                headers: {},
                writeHead(statusCode, headers) {
                    this.statusCode = statusCode;
                    this.headers = headers || {};
                },
                end(content = "") {
                    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
                    resolve({
                        statusCode: this.statusCode,
                        headers: this.headers,
                        body: text,
                        json: () => JSON.parse(text),
                    });
                },
            };
            Promise.resolve()
                .then(async () => {
                    const url = new URL(requestPath, "http://localhost");
                    if (url.pathname.startsWith("/api/")) {
                        await handleApi(request, response, url);
                    } else {
                        serveStatic(request, response, url.pathname);
                    }
                })
                .catch((error) => {
                    sendJson(response, error.statusCode || 500, { error: error.message || "服务器错误" });
                });
        });
    };

    server.closeRunners = () => {
        runnersClosing = true;
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        const activeRunners = Array.from(runners.entries());
        for (const [taskId, runner] of activeRunners) {
            runner.stopped = true;
            if (runner.timer) clearTimeout(runner.timer);
            if (runner.child) runner.child.kill("SIGTERM");
            if (!runner.runId) continue;
            try {
                const state = loadState();
                const task = findTask(state, taskId);
                if (!task || [STATUS.allDone, STATUS.failed, STATUS.stopped].includes(task.status)) continue;
                task.status = STATUS.stopped;
                task.nextRunAt = null;
                task.availabilityNextCheckAt = null;
                addEvent(state, "stopped", task.id, "服务关闭，任务已停止");
                appendTaskLogEvent(task, "task_stopped", "服务关闭，任务已停止", {
                    runId: runner.runId,
                    persistRun: true,
                    runStatus: STATUS.stopped,
                    metadata: { reason: "server_shutdown" },
                });
                updateTaskRunLog(task, runner.runId, { status: STATUS.stopped, endedAt: nowISO() });
                saveState(state);
            } catch {
                // Shutdown should continue even if a damaged log/state file cannot be updated.
            }
        }
        runners.clear();
    };

    startPingScheduler();
    restoreScheduledTasks();
    restoreQueuedTasks();

    return server;
}

if (require.main === module) {
    const config = resolveServerConfig();
    const server = createApp();
    server.listen(config.port, config.host, () => {
        console.log(formatStartupMessage(config));
    });
    process.on("SIGINT", () => {
        server.closeRunners();
        server.close(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
        server.closeRunners();
        server.close(() => process.exit(0));
    });
}

module.exports = {
    AVAILABILITY_CHECK_INTERVAL_MINUTES,
    DEFAULT_HOST,
    DEFAULT_PORT,
    RUNTIME_STATE,
    SCHEDULE_MODE,
    STATUS,
    createApp,
    formatStartupMessage,
    resolveServerConfig,
};
