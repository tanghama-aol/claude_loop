const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RUNTIME_STATE, createApp } = require("../server");
const {
    DEFAULT_CODEX_ARGS,
    DEFAULT_RUN_PROMPT,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
} = require("../lib/core");

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
    fs.writeFileSync(filePath, [
        "const fs = require(\"node:fs\");",
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "",
        "(async () => {",
        content,
        "})().catch((error) => {",
        "    console.error(error && error.stack ? error.stack : error);",
        "    process.exit(1);",
        "});",
    ].join("\n"), "utf8");
    return {
        command: process.execPath,
        args: `${JSON.stringify(filePath)} {prompt}`,
        filePath,
    };
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
    const generatorScript = writeAgentScript(tempRoot, "agent-generate.sh", [
        "fs.writeFileSync(\"测试任务.md\", [",
        "    \"# 测试任务\",",
        "    \"\",",
        "    \"- [ ] 实现任务文件生成\",",
        "    \"  - 完成标准：文件已生成。\",",
        "    \"\",",
        "].join(\"\\n\"), \"utf8\");",
        "console.log(\"任务目标文件已生成\");",
    ].join("\n"));
    const generatorProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "task-generator",
            agentType: "claude",
            command: generatorScript.command,
            args: generatorScript.args,
            timeoutSeconds: 1,
            enabled: true,
        },
    });

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "测试任务",
            requirement: "实现任务文件生成",
            targetFileName: "测试任务.md",
            directory: tempRoot,
            sourceMode: "agent",
            decomposeProfileId: generatorProfile.profile.id,
            runProfileIds: [generatorProfile.profile.id],
        },
    });
    assert.equal(created.ok, true);
    assert.equal(created.generation.ok, true);
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

test("server can create a task from an existing target file", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    fs.writeFileSync(path.join(tempRoot, "existing-task.md"), "# 已有任务\n\n- [ ] 保留内容\n", "utf8");
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

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "已有任务",
            targetFileName: "existing-task.md",
            directory: tempRoot,
            sourceMode: "existing",
        },
    });
    assert.equal(created.task.sourceMode, "existing");
    assert.equal(created.task.status, "not_started");

    const file = await request(server, `/api/tasks/${created.task.id}/file`);
    assert.equal(file.content, "# 已有任务\n\n- [ ] 保留内容\n");
});

test("server asks generator profile to write target file instead of using stdout as content", async (t) => {
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
    const script = writeAgentScript(tempRoot, "agent-rewrite.sh", [
        "fs.writeFileSync(\"rewrite-task.md\", [",
        "    \"# Agent 写入\",",
        "    \"\",",
        "    \"- [ ] 由生成 Profile 创建\",",
        "    \"\",",
        "].join(\"\\n\"), \"utf8\");",
        "console.log(\"stdout 不应覆盖文件\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "rewrite-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            timeoutSeconds: 1,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "重写任务",
            requirement: "生成目标文件",
            targetFileName: "rewrite-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    const generated = await request(server, `/api/tasks/${created.task.id}/generate`, {
        method: "POST",
        body: { profileId: profile.profile.id },
    });
    assert.equal(generated.ok, true);
    assert.equal(generated.failed, false);

    const file = await request(server, `/api/tasks/${created.task.id}/file`);
    assert.match(file.content, /# Agent 写入/);
    assert.doesNotMatch(file.content, /stdout 不应覆盖文件/);
});

test("server resolves Windows PowerShell command shims", { skip: process.platform !== "win32" }, async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    fs.writeFileSync(path.join(tempRoot, "fake-codex.ps1"), [
        "$marker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\"5YWo6YOo5a6M5oiQ\"))",
        "Write-Output ('GGGG' + $marker + 'GGGG')",
    ].join("\r\n"), "utf8");

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

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "fake-codex",
            agentType: "codex",
            command: "fake-codex",
            args: "{prompt}",
            envText: `PATH=${tempRoot}${path.delimiter}${process.env.PATH || ""}`,
            timeoutSeconds: 5,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "windows-shim",
            requirement: "run a PowerShell shim",
            targetFileName: "windows-shim.md",
            directory: tempRoot,
            sourceMode: "template",
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
    assert.match(task.lastCommand, /powershell\.exe/i);
    assert.match(task.lastCommand, /fake-codex\.ps1/i);
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
            promptTemplate: LEGACY_RUN_PROMPT,
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
    assert.equal(state.profiles[0].promptTemplate, DEFAULT_RUN_PROMPT);
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
        "let input = \"\";",
        "process.stdin.setEncoding(\"utf8\");",
        "process.stdin.on(\"data\", (chunk) => { input += chunk; });",
        "await new Promise((resolve) => process.stdin.on(\"end\", resolve));",
        "console.log(input ? `stdin-open:${input.trim()}` : \"stdin-closed\");",
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "stdin-agent",
            agentType: "claude",
            command: script.command,
            args: script.args,
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
            sourceMode: "template",
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

test("server still accepts the legacy all-done marker", async (t) => {
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
    const script = writeAgentScript(tempRoot, "agent-legacy-all-done.sh", "console.log(\"全部任务完成\");");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "legacy-all-done-agent",
            agentType: "claude",
            command: script.command,
            args: script.args,
            timeoutSeconds: 1,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "legacy all done",
            requirement: "legacy marker compatibility",
            targetFileName: "legacy-all-done.md",
            directory: tempRoot,
            sourceMode: "template",
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
    const script = writeAgentScript(tempRoot, "agent-sleep.sh", [
        "console.log(\"started\");",
        "await sleep(1000);",
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "sleep-agent",
            agentType: "claude",
            command: script.command,
            args: script.args,
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
            sourceMode: "template",
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
    const script = writeAgentScript(tempRoot, "agent-once.sh", "console.log(\"任务完成\");");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "once-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
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
            sourceMode: "template",
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

test("server can schedule a task to start once in the future", async (t) => {
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
    const markerPath = path.join(tempRoot, "scheduled-marker.txt");
    const script = writeAgentScript(tempRoot, "agent-scheduled.sh", [
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "scheduled-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "预约执行",
            requirement: "到点才执行",
            targetFileName: "scheduled-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    const startAt = new Date(Date.now() + 220).toISOString();
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id], startAt },
    });

    const scheduledState = await request(server, "/api/state");
    const scheduledTask = scheduledState.tasks.find((item) => item.id === created.task.id);
    assert.equal(scheduledTask.status, "scheduled");
    assert.equal(scheduledTask.runtimeState, RUNTIME_STATE.idleWaiting);
    assert.equal(scheduledTask.nextRunAt, startAt);
    assert.equal(scheduledTask.runtimeNextRunAt, startAt);
    assert.equal(fs.existsSync(markerPath), false);

    const finishedTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    }, { timeoutMs: 2000 });
    assert.equal(finishedTask.nextRunAt, null);
    assert.equal(finishedTask.runtimeState, RUNTIME_STATE.loopNotStarted);
    assert.equal(fs.readFileSync(markerPath, "utf8"), "started");
});

test("server cancels a scheduled task when it is stopped", async (t) => {
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
    const markerPath = path.join(tempRoot, "cancelled-marker.txt");
    const script = writeAgentScript(tempRoot, "agent-cancelled.sh", [
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "cancelled-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "取消预约",
            requirement: "停止后不要执行",
            targetFileName: "cancelled-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    const startAt = new Date(Date.now() + 450).toISOString();
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id], startAt },
    });

    await request(server, `/api/tasks/${created.task.id}/stop`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 550));

    const state = await request(server, "/api/state");
    const task = state.tasks.find((item) => item.id === created.task.id);
    assert.equal(task.status, "stopped");
    assert.equal(task.nextRunAt, null);
    assert.equal(task.runtimeState, RUNTIME_STATE.loopNotStarted);
    assert.equal(fs.existsSync(markerPath), false);
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
    const failScript = writeAgentScript(tempRoot, "agent-429.sh", "console.log(\"429\");");
    const nextScript = writeAgentScript(tempRoot, "agent-next.sh", "console.log(\"GGGG全部完成GGGG\");");

    const failProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "node-429",
            agentType: "claude",
            command: failScript.command,
            args: failScript.args,
            enabled: true,
        },
    });
    const nextProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "node-next",
            agentType: "codex",
            command: nextScript.command,
            args: nextScript.args,
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
            sourceMode: "template",
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
    const script = writeAgentScript(tempRoot, "agent-config.sh", [
        "console.log(process.env.CODEX_HOME || \"\");",
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "codex-config-dir",
            agentType: "codex",
            command: script.command,
            args: script.args,
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
            sourceMode: "template",
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
    assert.match(log.content, /stdout: GGGG全部完成GGGG/);
});

test("server pings enabled claude and codex profiles and groups records by day", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const successScript = writeAgentScript(tempRoot, "agent-ping-success.sh", [
        "const prompt = process.argv.slice(2).join(\" \");",
        "console.log(`reply:${prompt}`);",
    ].join("\n"));
    const failScript = writeAgentScript(tempRoot, "agent-ping-fail.sh", [
        "console.error(\"ping failed\");",
        "process.exit(2);",
    ].join("\n"));
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [
            {
                id: "profile_claude_ping",
                name: "claude-ping",
                agentType: "claude",
                command: successScript.command,
                args: successScript.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "profile_codex_ping",
                name: "codex-ping",
                agentType: "codex",
                command: failScript.command,
                args: failScript.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "profile_gemini_ping",
                name: "gemini-ping",
                agentType: "gemini",
                command: successScript.command,
                args: successScript.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
        tasks: [],
        events: [],
        pingRecords: [],
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

    const result = await request(server, "/api/pings/run", { method: "POST" });
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.map((record) => record.profileName).sort(), ["claude-ping", "codex-ping"]);
    assert.equal(result.records.find((record) => record.profileName === "claude-ping").success, true);
    assert.equal(result.records.find((record) => record.profileName === "codex-ping").success, false);
    assert.match(result.records[0].minute, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(result.records[0].prompt, "hello");

    const state = await request(server, "/api/state");
    assert.equal(state.pingRecords.length, 2);
    assert.equal(state.pingDays.length, 1);
    assert.equal(state.pingDays[0].total, 2);
    assert.equal(state.pingDays[0].success, 1);
    assert.equal(state.pingDays[0].failed, 1);
    assert.equal(state.pingDays[0].records.length, 2);
});

test("server stores model test configuration and masks profile tokens", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const saved = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "codex-openai-compatible",
            agentType: "codex",
            command: process.execPath,
            args: "-e \"console.log(process.env.AGENT_MODEL)\"",
            baseUrl: "https://api.example.test/v1",
            apiToken: "secret-token-123456",
            modelName: "gpt-test",
            pingIntervalMinutes: 7,
            pingEnabled: true,
            enabled: true,
        },
    });
    assert.equal(saved.profile.baseUrl, "https://api.example.test/v1");
    assert.equal(saved.profile.modelName, "gpt-test");
    assert.equal(saved.profile.pingIntervalMinutes, 7);
    assert.equal(saved.profile.pingEnabled, true);

    const state = await request(server, "/api/state");
    const profile = state.profiles.find((item) => item.id === saved.profile.id);
    assert.equal(profile.baseUrl, "https://api.example.test/v1");
    assert.equal(profile.modelName, "gpt-test");
    assert.equal(profile.pingIntervalMinutes, 7);
    assert.equal(profile.pingEnabled, true);
    assert.equal(profile.apiTokenConfigured, true);
    assert.match(profile.apiTokenPreview, /^\*+3456$/);
    assert.equal(Object.prototype.hasOwnProperty.call(profile, "apiToken"), false);

    await request(server, "/api/profiles", {
        method: "POST",
        body: {
            id: saved.profile.id,
            name: "codex-openai-compatible",
            agentType: "codex",
            command: process.execPath,
            args: "-e \"console.log(process.env.AGENT_MODEL)\"",
            apiToken: "",
            baseUrl: "https://api.changed.test/v1",
            modelName: "gpt-test-2",
            pingIntervalMinutes: 11,
            pingEnabled: false,
        },
    });
    const updatedState = await request(server, "/api/state");
    const updated = updatedState.profiles.find((item) => item.id === saved.profile.id);
    assert.equal(updated.apiTokenConfigured, true);
    assert.equal(updated.modelName, "gpt-test-2");
    assert.equal(updated.pingIntervalMinutes, 11);
    assert.equal(updated.pingEnabled, false);
});

test("server injects base url token and model when pinging codex and claude code profiles", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-ping-config.sh", [
        "console.log(JSON.stringify({",
        "    prompt: process.argv.slice(2).join(\" \"),",
        "    agentBaseUrl: process.env.AGENT_BASE_URL,",
        "    agentToken: process.env.AGENT_TOKEN,",
        "    agentModel: process.env.AGENT_MODEL,",
        "    openaiBaseUrl: process.env.OPENAI_BASE_URL,",
        "    openaiApiKey: process.env.OPENAI_API_KEY,",
        "    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,",
        "    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,",
        "}));",
    ].join("\n"));
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [
            {
                id: "profile_codex_configured",
                name: "codex-configured",
                agentType: "codex",
                command: script.command,
                args: script.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                baseUrl: "https://codex.example.test/v1",
                apiToken: "codex-token",
                modelName: "codex-model",
                pingIntervalMinutes: 5,
                pingEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "profile_claude_configured",
                name: "claude-configured",
                agentType: "claudecode",
                command: script.command,
                args: script.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                baseUrl: "https://claude.example.test",
                apiToken: "claude-token",
                modelName: "claude-model",
                pingIntervalMinutes: 9,
                pingEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
        tasks: [],
        events: [],
        pingRecords: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), "utf8");
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const result = await request(server, "/api/pings/run", { method: "POST" });
    assert.equal(result.records.length, 2);

    const codex = result.records.find((record) => record.profileName === "codex-configured");
    assert.equal(codex.success, true);
    assert.equal(codex.modelName, "codex-model");
    assert.equal(codex.baseUrl, "https://codex.example.test/v1");
    assert.equal(codex.pingIntervalMinutes, 5);
    assert.match(codex.outputTail, /"agentBaseUrl":"https:\/\/codex\.example\.test\/v1"/);
    assert.match(codex.outputTail, /"agentToken":"codex-token"/);
    assert.match(codex.outputTail, /"agentModel":"codex-model"/);
    assert.match(codex.outputTail, /"openaiApiKey":"codex-token"/);

    const claude = result.records.find((record) => record.profileName === "claude-configured");
    assert.equal(claude.success, true);
    assert.equal(claude.modelName, "claude-model");
    assert.equal(claude.baseUrl, "https://claude.example.test");
    assert.equal(claude.pingIntervalMinutes, 9);
    assert.match(claude.outputTail, /"anthropicBaseUrl":"https:\/\/claude\.example\.test"/);
    assert.match(claude.outputTail, /"anthropicAuthToken":"claude-token"/);
});

test("server scheduled pings only run profiles that are due for their configured interval", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-ping-due.sh", "console.log(\"scheduled pong\");");
    const now = Date.now();
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [
            {
                id: "profile_not_due",
                name: "not-due",
                agentType: "codex",
                command: script.command,
                args: script.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                modelName: "not-due-model",
                pingIntervalMinutes: 10,
                pingEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "profile_due",
                name: "due",
                agentType: "claude",
                command: script.command,
                args: script.args,
                envText: "",
                promptTemplate: DEFAULT_RUN_PROMPT,
                timeoutSeconds: 1,
                enabled: true,
                nonInteractive: true,
                defaultDirectory: tempRoot,
                configDirectory: "",
                modelName: "due-model",
                pingIntervalMinutes: 1,
                pingEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
        tasks: [],
        events: [],
        pingRecords: [{
            id: "existing_ping",
            createdAt: new Date(now - 30000).toISOString(),
            date: "2026-06-23",
            minute: "2026-06-23 00:00",
            prompt: "hello",
            profileId: "profile_not_due",
            profileName: "not-due",
            agentType: "codex",
            modelName: "not-due-model",
            model: "not-due-model",
            baseUrl: "",
            pingIntervalMinutes: 10,
            success: true,
            exitCode: 0,
            outputTail: "previous",
        }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), "utf8");
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        pingSchedulerTickMs: 100,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const state = await waitFor(async () => {
        const current = await request(server, "/api/state");
        return current.pingRecords.some((record) => record.profileId === "profile_due") ? current : null;
    }, { timeoutMs: 2500 });
    const dueRecords = state.pingRecords.filter((record) => record.profileId === "profile_due");
    const notDueRecords = state.pingRecords.filter((record) => record.profileId === "profile_not_due");
    assert.equal(dueRecords.length, 1);
    assert.equal(dueRecords[0].modelName, "due-model");
    assert.equal(notDueRecords.length, 1);
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
            sourceMode: "template",
            decomposeProfileId: state.profiles[0].id,
        },
    });
    assert.equal(created.task.targetFileName, "escape.md");
    assert.equal(path.dirname(created.task.filePath), tempRoot);
});
