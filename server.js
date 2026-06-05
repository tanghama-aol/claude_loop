const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
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
} = require("./lib/core");

const STATUS = {
    notStarted: "not_started",
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

function createApp(options = {}) {
    const rootDir = path.resolve(options.rootDir || process.cwd());
    const dataDir = path.resolve(options.dataDir || process.env.CLAUDE_LOOP_DATA_DIR || path.join(rootDir, ".claude-loop-data"));
    const publicDir = path.resolve(options.publicDir || path.join(__dirname, "public"));
    const logDir = path.join(dataDir, "logs");
    const stateFile = path.join(dataDir, "state.json");
    const runners = new Map();

    fs.mkdirSync(logDir, { recursive: true });

    function initialState() {
        return {
            version: 1,
            directories: [rootDir],
            profiles: createDefaultProfiles(rootDir),
            tasks: [],
            events: [],
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
        const normalized = {
            ...profile,
            configDirectory: rawConfigDirectory ? path.resolve(rawConfigDirectory) : "",
            defaultDirectory: path.resolve(profile?.defaultDirectory || rootDir),
        };
        const isLegacyDefaultCodex = normalized.id === "profile_codex_default"
            && normalized.name === "codex-default"
            && String(normalized.agentType || "").toLowerCase() === "codex"
            && String(normalized.command || "") === "codex"
            && String(normalized.args || "") === LEGACY_CODEX_ARGS;
        if (isLegacyDefaultCodex) normalized.args = DEFAULT_CODEX_ARGS;
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

    function publicState() {
        const state = loadState();
        return {
            ...state,
            profiles: state.profiles.map((profile) => ({
                ...profile,
                envPreview: maskEnvText(profile.envText || ""),
                envKeys: Object.keys(parseEnvText(profile.envText || "")),
            })),
            tasks: state.tasks.map((task) => ({
                ...task,
                ...runtimeInfoForTask(task),
                logSize: task.logFile ? safeStat(path.join(logDir, task.logFile))?.size || 0 : 0,
                fileMtime: task.filePath ? safeStat(task.filePath)?.mtime?.toISOString() || null : null,
            })),
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

    function formatOutputChunk(stream, text) {
        const normalized = String(text || "").replace(/\s+$/g, "");
        if (!normalized) return `${stream}: <empty chunk>`;
        return normalized
            .split(/\r?\n/)
            .map((line) => `${stream}: ${line}`)
            .join("\n");
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
        return path.basename(String(profile.command || "")).toLowerCase() === "codex";
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
            command: profile.command,
            args: renderedArgs,
            summary: [profile.command, ...renderedArgs].map(quoteCommandArg).join(" ").trim(),
        };
    }

    function runProfileCommand({ profile, task, prompt, spawnSpec = null, onOutput = () => {}, onLifecycle = null }) {
        return new Promise((resolve) => {
            const actualSpawnSpec = spawnSpec || buildSpawn(profile, prompt);
            const env = {
                ...process.env,
                ...parseEnvText(profile.envText || ""),
                ...configEnvForProfile(profile),
            };
            const timeoutMs = Math.max(1, Number(profile.timeoutSeconds || 1800)) * 1000;
            const startedAt = Date.now();
            const processStartedAt = nowISO();
            const child = childProcess.spawn(actualSpawnSpec.command, actualSpawnSpec.args, {
                cwd: task.directory,
                env,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
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
            spawnSpec = buildSpawn(profile, prompt);
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

        if (output.includes("全部任务完成")) {
            task.status = STATUS.allDone;
            task.nextRunAt = null;
            task.loop = { ...(task.loop || {}), stallCount: 0, lastOutput: "", lastHash: afterHash };
            addEvent(state, "all_done", taskId, "目标文件中任务全部完成");
            saveState(state);
            appendTaskLog(task, "全部任务完成，停止循环");
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

        if (method === "POST" && pathname === "/api/profiles") {
            const body = await readJson(request);
            const state = loadState();
            const existing = body.id ? state.profiles.find((profile) => profile.id === body.id) : null;
            const rawConfigDirectory = String(body.configDirectory ?? existing?.configDirectory ?? "").trim();
            const profile = {
                id: existing?.id || makeId("profile"),
                name: String(body.name || existing?.name || "new-profile").trim(),
                agentType: String(body.agentType || existing?.agentType || "claude").trim(),
                command: String(body.command || existing?.command || "claude").trim(),
                args: String(body.args ?? existing?.args ?? "-p {prompt}"),
                envText: String(body.envText ?? existing?.envText ?? ""),
                promptTemplate: String(body.promptTemplate || existing?.promptTemplate || DEFAULT_RUN_PROMPT),
                timeoutSeconds: Math.max(1, Number(body.timeoutSeconds || existing?.timeoutSeconds || 1800)),
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
            sendJson(response, 200, { ok: true, profile });
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
            const targetFileName = safeTaskFileName(body.targetFileName || `${title}.md`);
            const filePath = resolveTaskFile(directory, targetFileName);
            if (safeStat(filePath) && body.overwrite !== true) {
                sendJson(response, 409, { error: "目标任务文件已存在，请换一个文件名或确认覆盖" });
                return;
            }
            const explicitRunProfileIds = normalizeProfileIdList(body.runProfileIds);
            const requestedRunProfileIds = explicitRunProfileIds.length
                ? explicitRunProfileIds
                : normalizeProfileIdList([body.runProfileId, body.decomposeProfileId]);
            const runProfileIds = selectUsableProfileIds(state, requestedRunProfileIds);
            if (requestedRunProfileIds.length > 0 && runProfileIds.length === 0) {
                sendJson(response, 400, { error: "请选择可用的执行 Profile" });
                return;
            }
            fs.writeFileSync(filePath, generateTaskMarkdown({ title, requirement }), "utf8");
            const task = {
                id: makeId("task"),
                title,
                requirement,
                targetFileName,
                filePath,
                directory,
                decomposeProfileId: body.decomposeProfileId || "",
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
            addEvent(state, "task", task.id, `创建任务：${task.title}`);
            saveState(state);
            appendTaskLog(task, `创建任务文件：${filePath}`);
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
            task.runProfileIds = usableIds;
            task.runProfileId = usableIds[0];
            task.status = STATUS.running;
            task.retryCount = task.retryCount || 0;
            task.nextRunAt = null;
            addEvent(state, "started", task.id, `启动任务：${task.title}`);
            saveState(state);
            const startedAt = nowISO();
            runners.set(task.id, {
                stopped: false,
                child: null,
                timer: null,
                startedAt,
                idleSince: startedAt,
                nextRunAt: null,
                activeProcess: null,
                currentRunStartedAt: null,
                lastAgentExitAt: null,
                lastAgentExitCode: null,
                lastAgentSignal: null,
            });
            setImmediate(() => runTaskLoop(task.id));
            sendJson(response, 200, { ok: true, runProfileIds: usableIds });
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

        const decomposeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/decompose$/);
        if (method === "POST" && decomposeMatch) {
            const body = await readJson(request);
            const state = loadState();
            const task = findTask(state, decodeURIComponent(decomposeMatch[1]));
            if (!task) {
                sendJson(response, 404, { error: "任务不存在" });
                return;
            }
            const profile = findProfile(state, body.profileId || task.decomposeProfileId);
            if (!profile) {
                sendJson(response, 400, { error: "请选择可用的拆解 Profile" });
                return;
            }
            const prompt = fillTemplate(DEFAULT_DECOMPOSE_PROMPT, {
                targetFile: task.targetFileName,
                taskFile: task.targetFileName,
                requirement: task.requirement,
                title: task.title,
                workingDirectory: task.directory,
            });
            let spawnSpec = null;
            try {
                spawnSpec = buildSpawn(profile, prompt);
            } catch (error) {
                appendTaskLog(task, `拆解启动失败：${error.message}`);
                sendJson(response, 400, { error: error.message });
                return;
            }
            appendTaskLog(task, [
                `开始拆解：${profile.name} (${profile.agentType})`,
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
                onLifecycle: (message) => appendTaskLog(task, `decompose ${message}`),
                onOutput: (text, stream) => appendTaskLog(task, formatOutputChunk(`decompose ${stream}`, text)),
            });
            const latest = loadState();
            const latestTask = findTask(latest, task.id);
            if (latestTask && result.output.trim()) {
                fs.writeFileSync(latestTask.filePath, result.output.trim() + "\n", "utf8");
                latestTask.lastExitCode = result.exitCode;
                latestTask.lastOutput = result.output.slice(-4000);
                latestTask.decomposeProfileId = profile.id;
                latestTask.updatedAt = nowISO();
                addEvent(latest, "decompose", latestTask.id, `完成任务拆解：${latestTask.title}`);
                saveState(latest);
            }
            sendJson(response, 200, { ok: true, exitCode: result.exitCode, output: result.output });
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
        for (const runner of runners.values()) {
            if (runner.timer) clearTimeout(runner.timer);
            if (runner.child) runner.child.kill("SIGTERM");
        }
        runners.clear();
    };

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
