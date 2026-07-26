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
    scheduled: "scheduled",
    running: "running",
    retryWait: "retry_wait",
    completed: "completed",
    allDone: "all_done",
    stopped: "stopped",
    failed: "failed",
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

    fs.mkdirSync(logDir, { recursive: true });

    function initialState() {
        return {
            version: 2,
            directories: [rootDir],
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

    function normalizeTask(task) {
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
                    task?.directory || rootDir,
                    artifactDirectoryName || (artifactDirectory ? path.relative(task?.directory || rootDir, artifactDirectory) : ""),
                    task?.id || "task",
                );
                artifactDirectoryName = resolved.name;
                artifactDirectory = resolved.path;
            } catch {
                const resolved = resolveArtifactDirectory(task?.directory || rootDir, "", task?.id || "task");
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
        return {
            ...task,
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
        };
    }

    function normalizeState(state) {
        const normalized = state && typeof state === "object" ? state : initialState();
        normalized.version = 2;
        normalized.directories = Array.isArray(normalized.directories) && normalized.directories.length > 0
            ? normalized.directories.map((item) => path.resolve(item))
            : [rootDir];
        normalized.profiles = Array.isArray(normalized.profiles)
            ? normalized.profiles.map(normalizeProfile)
            : createDefaultProfiles(rootDir);
        normalized.tasks = Array.isArray(normalized.tasks) ? normalized.tasks.map(normalizeTask) : [];
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
        return {
            ...state,
            profiles: state.profiles.map(profileForClient),
            tasks: state.tasks.map((task) => {
                const artifacts = scanTaskArtifacts(task).map(({ filePath, signature, ...artifact }) => artifact);
                const logRuns = (task.logRuns || []).map((run) => ({
                    ...run,
                    logSize: safeStat(taskRunLogPath(task, run, false))?.size || 0,
                    eventLogSize: safeStat(taskRunLogPath(task, run, true))?.size || 0,
                }));
                return {
                    ...task,
                    logRuns,
                    logRunCount: logRuns.length,
                    ...runtimeInfoForTask(task),
                    artifacts,
                    artifactCount: artifacts.length,
                    logSize: task.logFile ? safeStat(taskLogPath(task))?.size || 0 : 0,
                    fileMtime: task.filePath ? safeStat(task.filePath)?.mtime?.toISOString() || null : null,
                };
            }),
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
        const activeStatuses = new Set([STATUS.running, STATUS.scheduled, STATUS.retryWait]);
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
        assertSafeLogFilePath(taskLogPath(task));
        assertSafeLogFilePath(taskLogPath(task, true));
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

    function logPathWithinDirectory(fileName, fallback) {
        const safeName = safeLogFileName(fileName, fallback);
        const resolved = path.resolve(logDir, safeName);
        const relative = path.relative(logDir, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            const error = new Error("日志路径无效");
            error.statusCode = 400;
            throw error;
        }
        return resolved;
    }

    function logFilePathIsSafe(filePath) {
        const resolved = path.resolve(filePath);
        const relative = path.relative(path.resolve(logDir), resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
        try {
            const stat = fs.lstatSync(resolved);
            if (stat.isSymbolicLink()) return false;
            const realRoot = fs.realpathSync(logDir);
            const realFile = fs.realpathSync(resolved);
            const realRelative = path.relative(realRoot, realFile);
            return realRelative !== ".."
                && !realRelative.startsWith(`..${path.sep}`)
                && !path.isAbsolute(realRelative);
        } catch (error) {
            return error?.code === "ENOENT";
        }
    }

    function assertSafeLogFilePath(filePath) {
        if (logFilePathIsSafe(filePath)) return filePath;
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
        return logPathWithinDirectory(fileName, fallback);
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
        fs.mkdirSync(logDir, { recursive: true });
        for (const filePath of [taskRunLogPath(task, run), taskRunLogPath(task, run, true)]) {
            assertSafeLogFilePath(filePath);
            const descriptor = fs.openSync(filePath, "a");
            fs.closeSync(descriptor);
        }
        return run;
    }

    function updateTaskRunLog(task, runId, updates = {}) {
        const run = ensureTaskRunLog(task, runId, updates);
        if (!run) return null;
        Object.assign(run, updates);
        const storedEvents = inspectTaskLogFile(taskRunLogPath(task, run, true)).events;
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
                existingEvents = logFilePathIsSafe(eventPath) && fs.existsSync(eventPath)
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

    function appendLegacyLogFile(filePath, message, timestamp) {
        const text = String(message ?? "").replace(/\s+$/g, "");
        if (!text) return;
        fs.appendFileSync(assertSafeLogFilePath(filePath), `[${timestamp}] ${text}\n`, "utf8");
    }

    function appendLegacyTaskLog(task, message, timestamp, filePath = null) {
        appendLegacyLogFile(filePath || taskLogPath(task), message, timestamp);
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
        const aggregateEventPath = assertSafeLogFilePath(taskLogPath(task, true));
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(aggregateEventPath, `${JSON.stringify(event)}\n`, "utf8");
        if (run) {
            fs.appendFileSync(assertSafeLogFilePath(taskRunLogPath(task, run, true)), `${JSON.stringify(event)}\n`, "utf8");
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
            if (run) appendLegacyLogFile(assertSafeLogFilePath(taskRunLogPath(task, run)), legacyText, timestamp);
        }
        return event;
    }

    function readTaskLogEvents(task, afterSequence = 0) {
        return inspectTaskLogFile(taskLogPath(task, true)).events
            .filter((event) => Number(event.sequence || 0) > afterSequence);
    }

    function inspectTaskLogFile(filePath) {
        if (!logFilePathIsSafe(filePath)) {
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

    function readLegacyLogFile(filePath, options = {}) {
        const emptyMetadata = {
            totalBytes: 0,
            returnedBytes: 0,
            omittedBytes: 0,
            truncated: false,
        };
        if (!logFilePathIsSafe(filePath)) {
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
        const aggregateStructured = inspectTaskLogFile(taskLogPath(task, true));
        const aggregateLegacy = readLegacyLogFile(taskLogPath(task), { maxBytes: legacyMaxBytes });
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
            const runStructured = inspectTaskLogFile(runEventPath);
            const runLegacy = readLegacyLogFile(runLegacyPath, { maxBytes: legacyMaxBytes });
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
                    commandSummary: actualSpawnSpec.summary,
                    durationMs: Date.now() - startedAt,
                    firstOutputAt: null,
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
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let outputChunks = 0;
            let firstOutputAt = null;
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
                    commandSummary: actualSpawnSpec.summary,
                    durationMs,
                    firstOutputAt,
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
                stdoutBytes += chunk.length;
                outputChunks += 1;
                lastOutputAt = nowISO();
                if (!firstOutputAt) {
                    firstOutputAt = lastOutputAt;
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
                stderrBytes += chunk.length;
                outputChunks += 1;
                lastOutputAt = nowISO();
                if (!firstOutputAt) {
                    firstOutputAt = lastOutputAt;
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

    async function pingProfile(profile) {
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
            const result = await runProfileCommand({
                profile,
                task,
                prompt,
            });
            const output = String(result.output || "");
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
                success: result.exitCode === 0 && output.trim().length > 0,
                exitCode: result.exitCode,
                signal: result.signal || null,
                durationMs: result.durationMs,
                outputTail: output.slice(-1000),
                command: result.commandSummary,
            };
        } finally {
            runners.delete(task.id);
        }
    }

    async function runPingRound(runOptions = {}) {
        if (pingInProgress) {
            const error = new Error("Ping 姝ｅ湪杩愯");
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
            addEvent(state, "ping", null, `Ping Profiles锛?{records.filter((record) => record.success).length}/${records.length} 鎴愬姛`);
            saveState(state);
            return records;
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
                addEvent(state, "ping", null, `Ping 澶辫触锛?{error.message}`);
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
            runners.delete(taskId);
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
            runners.delete(taskId);
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
            runners.delete(taskId);
            return;
        }

        if (/429/i.test(output)) {
            task.status = STATUS.retryWait;
            task.retryCount = (task.retryCount || 0) + 1;
            const switched = rotateProfile(state, task);
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
            runners.delete(taskId);
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
            runners.delete(taskId);
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
            runners.delete(taskId);
            return;
        }

        task.status = STATUS.retryWait;
        task.retryCount = (task.retryCount || 0) + 1;
        const switched = rotateProfile(state, task);
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
            state.directories = state.directories.filter((item) => path.resolve(item) !== directory);
            addEvent(state, "directory", null, `删除工作目录：${directory}`);
            saveState(state);
            sendJson(response, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/tasks") {
            const body = await readJson(request);
            const state = loadState();
            const directory = resolveDirectory(state, body.directory || rootDir);
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
                sendJson(response, 200, {
                    content: fs.existsSync(task.filePath) ? fs.readFileSync(task.filePath, "utf8") : "",
                    filePath: task.filePath,
                });
                return;
            }
            if (method === "PUT") {
                const body = await readJson(request);
                fs.writeFileSync(task.filePath, String(body.content || ""), "utf8");
                task.updatedAt = nowISO();
                task.fileMtime = safeStat(task.filePath)?.mtime?.toISOString() || null;
                addEvent(state, "task", task.id, `保存任务文件：${task.targetFileName}`);
                saveState(state);
                appendTaskLogEvent(task, "task_file_saved", `保存任务文件：${task.filePath}`, {
                    phase: "setup",
                    metadata: { filePath: task.filePath },
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
            const startAt = rawStartAt ? new Date(rawStartAt) : null;
            if (rawStartAt && Number.isNaN(startAt.getTime())) {
                sendJson(response, 400, { error: "预约启动时间无效" });
                return;
            }
            const shouldSchedule = startAt && startAt.getTime() > Date.now();
            const scheduledStartAt = shouldSchedule ? startAt.toISOString() : null;
            const startedAt = nowISO();
            const runId = makeId("run");
            task.runProfileIds = usableIds;
            task.runProfileId = usableIds[0];
            task.lastRunId = runId;
            task.status = shouldSchedule ? STATUS.scheduled : STATUS.running;
            task.retryCount = task.retryCount || 0;
            task.nextRunAt = scheduledStartAt;
            ensureTaskRunLog(task, runId, {
                startedAt,
                scheduledAt: scheduledStartAt,
                status: task.status,
            });
            addEvent(
                state,
                shouldSchedule ? "scheduled" : "started",
                task.id,
                shouldSchedule ? `预约启动任务：${task.title}` : `启动任务：${task.title}`,
            );
            saveState(state);
            runners.set(task.id, {
                stopped: false,
                child: null,
                timer: null,
                startedAt,
                idleSince: startedAt,
                nextRunAt: scheduledStartAt,
                activeProcess: null,
                currentRunStartedAt: null,
                lastAgentExitAt: null,
                lastAgentExitCode: null,
                lastAgentSignal: null,
                runId,
            });
            const initialProfile = findProfile(state, usableIds[0]);
            appendTaskLogEvent(
                task,
                shouldSchedule ? "task_scheduled" : "task_started",
                shouldSchedule ? `预约启动任务：${task.title}` : `启动任务：${task.title}`,
                {
                    runId,
                    profile: initialProfile,
                    startedAt,
                    scheduledAt: scheduledStartAt,
                    runStatus: task.status,
                    metadata: {
                        scheduledStartAt,
                        runProfileIds: usableIds,
                    },
                },
            );
            saveState(state);
            if (shouldSchedule) {
                scheduleInitialRun(task.id, startAt);
                sendJson(response, 200, { ok: true, runId, runProfileIds: usableIds, scheduledStartAt });
                return;
            }
            setImmediate(() => runTaskLoop(task.id));
            sendJson(response, 200, { ok: true, runId, runProfileIds: usableIds, scheduledStartAt: null });
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
            if (runner) {
                runner.stopped = true;
                if (runner.timer) clearTimeout(runner.timer);
                if (runner.child) runner.child.kill("SIGTERM");
                runners.delete(task.id);
            }
            task.status = STATUS.stopped;
            task.nextRunAt = null;
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
    DEFAULT_HOST,
    DEFAULT_PORT,
    RUNTIME_STATE,
    STATUS,
    createApp,
    formatStartupMessage,
    resolveServerConfig,
};
