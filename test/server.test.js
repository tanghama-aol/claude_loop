const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RUNTIME_STATE, createApp } = require("../server");
const { DEFAULT_CODEX_ARGS, LEGACY_CODEX_ARGS } = require("../lib/core");

async function request(server, pathName, options = {}) {
    const response = await server.inject({
        method: options.method || "GET",
        path: pathName,
        body: options.body || null,
    });
    const payload = response.json();
    if (response.statusCode >= 400) {
        throw new Error(payload.error || `HTTP ${response.statusCode}`);
    }
    return payload;
}

async function waitFor(fn, { timeoutMs = 2500, intervalMs = 25 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for condition");
}

function writeAgentScript(directory, name, content) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, `#!/bin/sh\n${content}\n`, "utf8");
    fs.chmodSync(filePath, 0o755);
    return filePath;
}

test("server creates task files and supports editing", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const state = await request(server, "/api/state");
    assert.equal(state.directories[0], tempRoot);
    assert.ok(state.profiles.length >= 3);

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "测试任务",
            requirement: "实现任务文件生成",
            targetFileName: "测试任务.md",
            directory: tempRoot,
            decomposeProfileId: state.profiles[0].id,
        },
    });
    assert.equal(created.task.status, "not_started");
    assert.ok(fs.existsSync(path.join(tempRoot, "测试任务.md")));

    const publicTask = (await request(server, "/api/state")).tasks.find((item) => item.id === created.task.id);
    assert.equal(publicTask.runtimeState, RUNTIME_STATE.loopNotStarted);
    assert.equal(publicTask.activeProcess, null);

    const file = await request(server, `/api/tasks/${created.task.id}/file`);
    assert.match(file.content, /实现任务文件生成/);

    await request(server, `/api/tasks/${created.task.id}/file`, {
        method: "PUT",
        body: { content: "# 已编辑\n" },
    });
    const edited = await request(server, `/api/tasks/${created.task.id}/file`);
    assert.equal(edited.content, "# 已编辑\n");
});

test("server migrates legacy default codex profile to auto-confirm args", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [{
            id: "profile_codex_default",
            name: "codex-default",
            agentType: "codex",
            command: "codex",
            args: LEGACY_CODEX_ARGS,
            envText: "",
            promptTemplate: "",
            timeoutSeconds: 1800,
            enabled: true,
            nonInteractive: true,
            defaultDirectory: tempRoot,
            configDirectory: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }],
        tasks: [],
        events: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), "utf8");
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const state = await request(server, "/api/state");
    assert.equal(state.profiles[0].args, DEFAULT_CODEX_ARGS);
});

test("server closes agent stdin so commands do not wait for additional input", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const script = writeAgentScript(tempRoot, "agent-stdin.sh", [
        "if read line; then",
        "  echo \"stdin-open:$line\"",
        "else",
        "  echo stdin-closed",
        "fi",
        "echo 全部任务完成",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "stdin-agent",
            agentType: "claude",
            command: script,
            args: "{prompt}",
            timeoutSeconds: 1,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "stdin 检查",
            requirement: "确认 stdin 不阻塞",
            targetFileName: "stdin-task.md",
            directory: tempRoot,
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    });
    assert.equal(task.lastExitCode, 0);
    assert.match(task.lastOutput, /stdin-closed/);
});

test("server exposes active agent process while a task is running", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const script = writeAgentScript(tempRoot, "agent-sleep.sh", "echo started\nsleep 1\necho 全部任务完成");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "sleep-agent",
            agentType: "claude",
            command: script,
            args: "{prompt}",
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "进程检查",
            requirement: "检查运行中进程",
            targetFileName: "process-task.md",
            directory: tempRoot,
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    const runningTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.runtimeState === RUNTIME_STATE.agentRunning);
    });
    assert.equal(runningTask.isAgentRunning, true);
    assert.equal(runningTask.isIdleWaiting, false);
    assert.ok(runningTask.activeProcess.pid > 0);
    assert.equal(runningTask.activeProcess.profileName, "sleep-agent");
    assert.equal(runningTask.activeProcess.cwd, tempRoot);
    assert.match(runningTask.activeProcess.commandSummary, /agent-sleep\.sh/);

    const finishedTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    });
    assert.equal(finishedTask.runtimeState, RUNTIME_STATE.loopNotStarted);
    assert.equal(finishedTask.activeProcess, null);
});

test("server reports idle waiting while loop is between agent runs", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const script = writeAgentScript(tempRoot, "agent-once.sh", "echo 任务完成");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "once-agent",
            agentType: "codex",
            command: script,
            args: "{prompt}",
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "等待检查",
            requirement: "检查等待状态",
            targetFileName: "idle-task.md",
            directory: tempRoot,
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    const waitingTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => (
            item.id === created.task.id
            && item.status === "completed"
            && item.runtimeState === RUNTIME_STATE.idleWaiting
        ));
    });
    assert.equal(waitingTask.status, "completed");
    assert.equal(waitingTask.isRunning, true);
    assert.equal(waitingTask.isAgentRunning, false);
    assert.equal(waitingTask.isIdleWaiting, true);
    assert.equal(waitingTask.activeProcess, null);
    assert.ok(waitingTask.runtimeNextRunAt);
});

test("server logs real prompt and rotates to next profile after failure", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const failScript = writeAgentScript(tempRoot, "agent-429.sh", "echo 429");
    const nextScript = writeAgentScript(tempRoot, "agent-next.sh", "echo 全部任务完成");

    const failProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "node-429",
            agentType: "claude",
            command: failScript,
            args: "{prompt}",
            enabled: true,
        },
    });
    const nextProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "node-next",
            agentType: "codex",
            command: nextScript,
            args: "{prompt}",
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "轮换任务",
            requirement: "检查真实 prompt",
            targetFileName: "rotate-task.md",
            directory: tempRoot,
            decomposeProfileId: failProfile.profile.id,
            runProfileIds: [failProfile.profile.id, nextProfile.profile.id],
        },
    });

    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [failProfile.profile.id, nextProfile.profile.id] },
    });

    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "retry_wait");
    });
    assert.equal(task.runProfileId, nextProfile.profile.id);

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.match(log.content, /Agent 激活：node-429/);
    assert.match(log.content, /Prompt 开始/);
    assert.match(log.content, /rotate-task\.md/);
    assert.match(log.content, /Agent 首次输出：stdout/);
    assert.match(log.content, /stdout: 429/);
});

test("server applies profile config directory to agent environment", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const configDirectory = path.join(tempData, "codex-home");
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const script = writeAgentScript(tempRoot, "agent-config.sh", "echo \"$CODEX_HOME\"\necho 全部任务完成");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "codex-config-dir",
            agentType: "codex",
            command: script,
            args: "{prompt}",
            configDirectory,
            enabled: true,
        },
    });
    assert.equal(profile.profile.configDirectory, configDirectory);

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "配置目录任务",
            requirement: "检查配置目录",
            targetFileName: "config-dir-task.md",
            directory: tempRoot,
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    });
    assert.equal(task.lastProfileId, profile.profile.id);

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.match(log.content, new RegExp(configDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(log.content, /配置目录：.*CODEX_HOME/);
    assert.match(log.content, /Prompt 开始/);
    assert.match(log.content, /stdout: 全部任务完成/);
});

test("server rejects task files outside configured directory", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const state = await request(server, "/api/state");
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "路径检查",
            requirement: "路径检查",
            targetFileName: "../escape",
            directory: tempRoot,
            decomposeProfileId: state.profiles[0].id,
        },
    });
    assert.equal(created.task.targetFileName, "escape.md");
    assert.equal(path.dirname(created.task.filePath), tempRoot);
});
