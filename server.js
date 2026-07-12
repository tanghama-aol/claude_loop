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
    DEFAULT_CODEX_ARGS,
    DEFAULT_RUN_PROMPT,
    LEGACY_ALL_DONE_MARKERS,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
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

const RUNTIME_STATE = {
    agentRunning: "agent_running",
    idleWaiting: "idle_waiting",
    loopNotStarted: "loop_not_started",
};

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
    let pingTimer = null;
    let pingInProgress = false;

    fs.mkdirSync(logDir, { recursive: true });

    function initialState() {
        return {
            version: 1,
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
        const normalized = {
            ...profile,
            baseUrl: String(profile?.baseUrl || "").trim(),
            apiToken: String(profile?.apiToken || ""),
            modelName: String(profile?.modelName || "").trim(),
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
        return {
            ...task,
            runProfileIds,
            runProfileId: task?.runProfileId || runProfileIds[0] || "",
        };
    }

    function normalizeState(state) {
        const normalized = state && typeof state === "object" ? state : initialState();
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

    function findTask(state, id) {
        return state.tasks.find((task) => task.id === id);
    }

    function findProfile(state, id) {
        return state.profiles.find((profile) => profile.id === id && profile.enabled !== false);
    }

    function selectUsableProfileIds(state, requestedIds) {
        const usableIds = [];
        for (const id of normalizeProfileIdList(requestedIds)) {
            if (findProfile(state, id)) usableIds.push(id);
        }
        return usableIds;
    }

    function resolveRunProfile(state, task) {
        let profile = findProfile(state, task.runProfileId);
        if (profile) return profile;
        const list = normalizeProfileIdList(task.runProfileIds);
        for (const id of list) {
            const candidate = findProfile(state, id);
            if (candidate) {
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
            tasks: state.tasks.map((task) => ({
                ...task,
                ...runtimeInfoForTask(task),
                logSize: task.logFile ? safeStat(path.join(logDir, task.logFile))?.size || 0 : 0,
                fileMtime: task.filePath ? safeStat(task.filePath)?.mtime?.toISOString() || null : null,
            })),
            pingDays: pingDays(state.pingRecords),
            pingSettings: state.pingSettings,
            pingQuestionCount: PING_QUESTIONS.length,
            pingRunning: pingInProgress,
        };
    }

    function rotateProfile(state, task) {
        const list = selectUsableProfileIds(state, task.runProfileIds);
        if (list.length <= 1) return null;
        const next = nextProfileId(task.runProfileId, list);
        if (!next || next === task.runProfileId) return null;
        task.runProfileId = next;
        const profile = findProfile(state, next);
        return profile ? profile.name : next;
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

    function normalizeTaskSourceMode(value, body = {}) {
        if (body.loadExisting === true) return "existing";
        const mode = String(value || "").trim().toLowerCase();
        if (["agent", "existing", "upload", "template"].includes(mode)) return mode;
        return "agent";
    }

    function buildTaskGenerationPrompt(task) {
        return fillTemplate(DEFAULT_GENERATE_PROMPT, {
            targetFile: task.targetFileName,
            taskFile: task.targetFileName,
            requirement: task.requirement,
            title: task.title,
            workingDirectory: task.directory,
        });
    }

    function appendTaskLog(task, message) {
        if (!task.logFile) return;
        const logPath = path.join(logDir, task.logFile);
        const text = String(message || "").replace(/\s+$/g, "");
        if (!text) return;
        fs.appendFileSync(logPath, `[${nowISO()}] ${text}\n`);
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
        const env = {};
        if (baseUrl) env.AGENT_BASE_URL = baseUrl;
        if (apiToken) env.AGENT_TOKEN = apiToken;
        if (modelName) env.AGENT_MODEL = modelName;
        if (agentType === "codex") {
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
        if (agentType === "claude" || agentType === "claudecode") {
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
        return env;
    }

    function environmentForProfile(profile) {
        return {
            ...process.env,
            ...parseEnvText(profile.envText || ""),
            ...configEnvForProfile(profile),
            ...modelTestEnvForProfile(profile),
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
        return [ALL_DONE_MARKER+ALL_DONE_MARKER].some((marker) => marker && text.includes(marker));
    }

    function profileConfigDescription(profile) {
        if (!profile.configDirectory) return "配置目录：-";
        const keys = Object.keys(configEnvForProfile(profile));
        return `配置目录：${profile.configDirectory}${keys.length ? ` (${keys.join(", ")})` : ""}`;
    }

    function promptBlock(prompt) {
        return `Prompt 开始\n${prompt}\nPrompt 结束`;
    }

    function buildPrompt(profile, task, overridePrompt = "") {
        if (overridePrompt) return overridePrompt;
        const template = profile.promptTemplate || DEFAULT_RUN_PROMPT;
        return fillTemplate(template, {
            targetFile: task.targetFileName,
            taskFile: task.targetFileName,
            title: task.title,
            requirement: task.requirement,
            workingDirectory: task.directory,
        });
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

    function buildSpawn(profile, prompt) {
        const args = addNonInteractiveArgs(profile, parseArgs(profile.args || ""));
        let hasPrompt = false;
        const renderedArgs = args.map((arg) => {
            if (arg.includes("{prompt}") || arg.includes("${prompt}") || arg.includes("{{prompt}}")) {
                hasPrompt = true;
                return fillTemplate(arg, { prompt });
            }
            return fillTemplate(arg, { prompt });
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
            const env = environmentForProfile(profile);
            const actualSpawnSpec = prepareSpawnSpecForPlatform(spawnSpec || buildSpawn(profile, prompt), env, task.directory);
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
                if (onLifecycle) onLifecycle(`Agent 启动错误：${message}`);
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
                    startedAt: processStartedAt,
                    lastOutputAt: null,
                    outputChunks: 0,
                };
            }
            if (onLifecycle) {
                onLifecycle(`Agent 进程已启动：profile=${profile.name} type=${profile.agentType} pid=${child.pid || "-"} cwd=${task.directory}`);
            }

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
                if (onLifecycle) {
                    if (outputChunks === 0) onLifecycle("Agent 运行结束：未收到 stdout/stderr 输出");
                    onLifecycle([
                        `Agent 进程结束：exitCode=${result.exitCode ?? "-"} signal=${result.signal || "-"} durationMs=${durationMs}`,
                        `输出统计：chunks=${outputChunks} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`,
                    ].join("\n"));
                }
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
                if (onLifecycle) onLifecycle(`Agent 超时：超过 ${profile.timeoutSeconds || 1800}s，发送 SIGTERM`);
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
                    if (onLifecycle) onLifecycle(`Agent 首次输出：stdout ${chunk.length} bytes`);
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
                    if (onLifecycle) onLifecycle(`Agent 首次输出：stderr ${chunk.length} bytes`);
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
                if (onLifecycle) onLifecycle(`Agent 启动错误：${error.message}`);
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
        if (!profile) {
            const error = new Error("请选择可用的生成 Profile");
            error.statusCode = 400;
            throw error;
        }

        const beforeHash = fileHash(task.filePath);
        const prompt = buildTaskGenerationPrompt(task);
        let spawnSpec = null;
        try {
            spawnSpec = prepareSpawnSpecForPlatform(buildSpawn(profile, prompt), environmentForProfile(profile), task.directory);
        } catch (error) {
            task.status = STATUS.failed;
            task.lastOutput = error.message;
            task.updatedAt = nowISO();
            addEvent(state, "failed", task.id, `生成启动失败：${error.message}`);
            saveState(state);
            appendTaskLog(task, `生成启动失败：${error.message}`);
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
        task.decomposeProfileId = profile.id;
        task.updatedAt = nowISO();
        saveState(state);

        appendTaskLog(task, [
            `开始生成目标文件：${profile.name} (${profile.agentType})`,
            profileConfigDescription(profile),
            `工作目录：${task.directory}`,
            `命令：${spawnSpec.summary}`,
            promptBlock(prompt),
        ].join("\n"));

        const result = await runProfileCommand({
            profile,
            task,
            prompt,
            spawnSpec,
            onLifecycle: (message) => appendTaskLog(task, `generate ${message}`),
            onOutput: (text, stream) => appendTaskLog(task, formatOutputChunk(`generate ${stream}`, text)),
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
            appendTaskLog(task, `生成目标文件失败：${reason}`);
        } else {
            const changed = beforeHash !== afterHash ? "已更新" : "未检测到内容变化";
            addEvent(state, "generate", task.id, `生成目标文件完成：${task.title}`);
            appendTaskLog(task, `生成目标文件完成：${changed}`);
        }
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
        const profile = resolveRunProfile(state, task);
        if (!profile) {
            task.status = STATUS.failed;
            task.lastOutput = "执行 Profile 不存在或已禁用";
            addEvent(state, "failed", taskId, task.lastOutput);
            saveState(state);
            runners.delete(taskId);
            return;
        }

        task.status = STATUS.running;
        task.lastRunAt = nowISO();
        task.nextRunAt = null;

        const beforeHash = fileHash(task.filePath);
        let prompt = "";
        let spawnSpec = null;
        try {
            prompt = buildPrompt(profile, task);
            spawnSpec = prepareSpawnSpecForPlatform(buildSpawn(profile, prompt), environmentForProfile(profile), task.directory);
        } catch (error) {
            task.status = STATUS.failed;
            task.lastOutput = error.message;
            task.updatedAt = nowISO();
            addEvent(state, "failed", taskId, `启动失败：${error.message}`);
            saveState(state);
            appendTaskLog(task, `启动失败：${error.message}`);
            runners.delete(taskId);
            return;
        }
        task.lastPrompt = prompt;
        task.lastCommand = spawnSpec.summary;
        task.lastProfileId = profile.id;
        task.lastProfileName = profile.name;
        task.lastProfileAgentType = profile.agentType;
        task.updatedAt = nowISO();
        saveState(state);

        appendTaskLog(task, [
            `Agent 激活：${profile.name} (${profile.agentType})`,
            profileConfigDescription(profile),
            `工作目录：${task.directory}`,
            `命令：${spawnSpec.summary}`,
            promptBlock(prompt),
        ].join("\n"));

        const result = await runProfileCommand({
            profile,
            task,
            prompt,
            spawnSpec,
            onLifecycle: (message) => appendTaskLog(task, message),
            onOutput: (text, stream) => appendTaskLog(task, formatOutputChunk(stream, text)),
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

        if (runner.stopped) {
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            addEvent(state, "stopped", taskId, "任务已停止");
            saveState(state);
            runners.delete(taskId);
            return;
        }

        if (/429/i.test(output)) {
            task.status = STATUS.retryWait;
            task.retryCount = (task.retryCount || 0) + 1;
            const switched = rotateProfile(state, task);
            task.nextRunAt = new Date(Date.now() + 300000).toISOString();
            const note = switched ? `检测到 429，切换 Profile：${switched}，5 分钟后重试` : "检测到 429，5 分钟后重试";
            addEvent(state, "retry", taskId, note);
            saveState(state);
            appendTaskLog(task, note);
            scheduleNext(taskId, 300000);
            return;
        }

        if (isAllDoneOutput(output)) {
            task.status = STATUS.allDone;
            task.nextRunAt = null;
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: "", lastHash: afterHash };
            addEvent(state, "all_done", taskId, "目标文件中任务全部完成");
            saveState(state);
            appendTaskLog(task, "全部完成，停止循环");
            runners.delete(taskId);
            return;
        }

        if (output.includes("任务完成")) {
            task.status = STATUS.completed;
            task.nextRunAt = new Date(Date.now() + 10000).toISOString();
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: output, lastHash: afterHash };
            addEvent(state, "completed", taskId, "单轮任务完成，10 秒后继续");
            saveState(state);
            appendTaskLog(task, "任务完成，10 秒后继续下一轮");
            scheduleNext(taskId, 10000);
            return;
        }

        const previousLoop = task.loop || {};
        const sameOutput = output === previousLoop.lastOutput;
        const unchangedFile = afterHash === beforeHash;
        const stallCount = sameOutput && unchangedFile ? (previousLoop.stallCount || 1) + 1 : 1;

        task.loop = {
            lastOutput: output,
            lastHash: afterHash,
            stallCount,
        };

        if (stallCount >= 3) {
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            addEvent(state, "stopped", taskId, "连续 3 次输出相同且任务文件无改动，停止循环");
            saveState(state);
            appendTaskLog(task, "连续 3 次输出相同且任务文件无改动，停止循环");
            runners.delete(taskId);
            return;
        }

        task.status = STATUS.retryWait;
        task.retryCount = (task.retryCount || 0) + 1;
        const switched = rotateProfile(state, task);
        task.nextRunAt = new Date(Date.now() + 60000).toISOString();
        const retryNote = switched
            ? `其他输出，切换 Profile：${switched}，1 分钟后重试`
            : "其他输出，1 分钟后重试";
        addEvent(state, "retry", taskId, retryNote);
        saveState(state);
        appendTaskLog(task, `${retryNote}。停滞计数：${stallCount}/3`);
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

    function sendText(response, statusCode, text, type = "text/plain; charset=utf-8") {
        response.writeHead(statusCode, {
            "content-type": type,
            "cache-control": "no-store",
        });
        response.end(text);
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
                command: String(body.command || existing?.command || "claude").trim(),
                args: String(body.args ?? existing?.args ?? "-p {prompt}"),
                envText: String(body.envText ?? existing?.envText ?? ""),
                promptTemplate: String(body.promptTemplate || existing?.promptTemplate || DEFAULT_RUN_PROMPT),
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
            const sourceMode = normalizeTaskSourceMode(body.sourceMode, body);
            const targetFileName = safeTaskFileName(body.targetFileName || `${title}.md`);
            const filePath = resolveTaskFile(directory, targetFileName);
            const explicitRunProfileIds = normalizeProfileIdList(body.runProfileIds);
            const requestedRunProfileIds = explicitRunProfileIds.length
                ? explicitRunProfileIds
                : normalizeProfileIdList([body.runProfileId, body.decomposeProfileId]);
            const runProfileIds = selectUsableProfileIds(state, requestedRunProfileIds);
            if (requestedRunProfileIds.length > 0 && runProfileIds.length === 0) {
                sendJson(response, 400, { error: "请选择可用的执行 Profile" });
                return;
            }
            const generationProfile = sourceMode === "agent" ? findProfile(state, body.decomposeProfileId || runProfileIds[0]) : null;
            if (sourceMode === "agent" && !generationProfile) {
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

            if (sourceMode === "upload") {
                if (!Object.prototype.hasOwnProperty.call(body, "sourceContent")) {
                    sendJson(response, 400, { error: "请先选择要导入的任务目标文件" });
                    return;
                }
                fs.writeFileSync(filePath, String(body.sourceContent ?? ""), "utf8");
            } else if (sourceMode === "template") {
                fs.writeFileSync(filePath, generateTaskMarkdown({ title, requirement }), "utf8");
            } else if (sourceMode === "agent") {
                fs.writeFileSync(filePath, "", "utf8");
            }

            const task = {
                id: makeId("task"),
                title,
                requirement,
                sourceMode,
                targetFileName,
                filePath,
                directory,
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
                logFile: `${Date.now()}-${safeTaskFileName(title).replace(/\.md$/i, "")}.log`,
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
            appendTaskLog(task, `${createMessages[sourceMode] || "创建任务"}\n目标文件：${filePath}`);

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
                appendTaskLog(task, `保存任务文件：${task.filePath}`);
                sendJson(response, 200, { ok: true });
                return;
            }
        }

        const taskLogMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/log$/);
        if (method === "GET" && taskLogMatch) {
            const state = loadState();
            const task = findTask(state, decodeURIComponent(taskLogMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const logPath = path.join(logDir, task.logFile);
            sendJson(response, 200, {
                content: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
                logPath,
            });
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
            const usableIds = selectUsableProfileIds(state, requestedIds);
            if (usableIds.length === 0) {
                sendJson(response, 400, { error: "请选择可用的执行 Profile" });
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
            task.runProfileIds = usableIds;
            task.runProfileId = usableIds[0];
            task.status = shouldSchedule ? STATUS.scheduled : STATUS.running;
            task.retryCount = task.retryCount || 0;
            task.nextRunAt = scheduledStartAt;
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
            });
            if (shouldSchedule) {
                scheduleInitialRun(task.id, startAt);
                appendTaskLog(task, `预约启动时间：${scheduledStartAt}`);
                sendJson(response, 200, { ok: true, runProfileIds: usableIds, scheduledStartAt });
                return;
            }
            setImmediate(() => runTaskLoop(task.id));
            sendJson(response, 200, { ok: true, runProfileIds: usableIds, scheduledStartAt: null });
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
            if (runner) {
                runner.stopped = true;
                if (runner.timer) clearTimeout(runner.timer);
                if (runner.child) runner.child.kill("SIGTERM");
                runners.delete(task.id);
            }
            task.status = STATUS.stopped;
            task.nextRunAt = null;
            addEvent(state, "stopped", task.id, `停止任务：${task.title}`);
            saveState(state);
            appendTaskLog(task, "用户停止任务");
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
        for (const runner of runners.values()) {
            if (runner.timer) clearTimeout(runner.timer);
            if (runner.child) runner.child.kill("SIGTERM");
        }
        runners.clear();
    };

    startPingScheduler();

    return server;
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || "127.0.0.1";
    const server = createApp();
    server.listen(port, host, () => {
        console.log(`Agent Loop Web running at http://${host}:${port}`);
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
    RUNTIME_STATE,
    STATUS,
    createApp,
};
