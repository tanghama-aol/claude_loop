const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    DEFAULT_HOST,
    DEFAULT_PORT,
    RUNTIME_STATE,
    createApp,
    formatStartupMessage,
    resolveServerConfig,
} = require("../server");
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

test("server defaults to all interfaces while preserving explicit HOST and PORT", () => {
    assert.deepEqual(resolveServerConfig({}), {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
    });
    assert.deepEqual(resolveServerConfig({ HOST: " 127.0.0.1 ", PORT: "3100" }), {
        host: "127.0.0.1",
        port: 3100,
    });
    assert.deepEqual(resolveServerConfig({ HOST: "", PORT: "0" }), {
        host: DEFAULT_HOST,
        port: 0,
    });

    const startup = formatStartupMessage({ host: DEFAULT_HOST, port: DEFAULT_PORT });
    assert.match(startup, /127\.0\.0\.1:3000/);
    assert.match(startup, /listening on 0\.0\.0\.0:3000/);
    assert.match(startup, /network and firewall/i);
});

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

test("server appends task items to historical tasks and restores executable status", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const targetFileName = "historical-task.md";
    const originalContent = [
        "# 历史任务",
        "",
        "## 任务列表",
        "",
        "- [x] 1. 已完成的旧任务",
        "  - 状态：已完成",
        "  - 完成标准：旧任务完成",
        "  - 执行记录：此前运行",
        "",
    ].join("\n");
    fs.writeFileSync(path.join(tempRoot, targetFileName), originalContent, "utf8");
    let server = createApp({
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

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "历史任务",
            targetFileName,
            directory: tempRoot,
            sourceMode: "existing",
        },
    });
    const taskId = created.task.id;
    const statePath = path.join(tempData, "state.json");
    const savedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const savedTask = savedState.tasks.find((task) => task.id === taskId);
    savedTask.status = "all_done";
    savedTask.lastRunId = "run_old_history";
    fs.writeFileSync(statePath, JSON.stringify(savedState, null, 2), "utf8");

    const appended = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/items`, {
        method: "POST",
        body: {
            items: [
                "追加的第一项",
                { text: "追加的第二项", completionCriteria: "通过追加测试" },
            ],
        },
    });
    assert.equal(appended.ok, true);
    assert.equal(appended.previousStatus, "all_done");
    assert.equal(appended.status, "not_started");
    assert.deepEqual(appended.items.map((item) => item.number), [2, 3]);
    assert.equal(appended.task.appendedItems.length, 2);
    assert.equal(appended.task.lastRunId, "run_old_history");

    const file = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/file`);
    assert.ok(file.content.startsWith(originalContent));
    assert.match(file.content, /- \[ \] 2\. 追加的第一项/);
    assert.match(file.content, /- \[ \] 3\. 追加的第二项/);
    assert.match(file.content, /完成标准：通过追加测试/);
    const log = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/log`);
    assert.ok(log.events.some((event) => event.type === "task_items_appended"));
    assert.match(log.content, /追加的第一项/);

    server.closeRunners();
    server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    const reloaded = await request(server, "/api/state");
    const reloadedTask = reloaded.tasks.find((task) => task.id === taskId);
    assert.equal(reloadedTask.status, "not_started");
    assert.equal(reloadedTask.appendedItems.length, 2);
    assert.equal(reloadedTask.appendedItems[1].text, "追加的第二项");

    const invalid = await server.inject({
        method: "POST",
        path: `/api/tasks/${encodeURIComponent(taskId)}/items`,
        body: { items: ["  ", ""] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /不能为空/);

    const missing = await server.inject({
        method: "POST",
        path: "/api/tasks/task_missing/items",
        body: { items: ["不会写入"] },
    });
    assert.equal(missing.statusCode, 404);

    const conflictState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    conflictState.tasks.find((task) => task.id === taskId).status = "running";
    fs.writeFileSync(statePath, JSON.stringify(conflictState, null, 2), "utf8");
    const conflict = await server.inject({
        method: "POST",
        path: `/api/tasks/${encodeURIComponent(taskId)}/append`,
        body: { text: "运行期间不应追加" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.json().error, /运行/);
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
    const started = await request(server, `/api/tasks/${created.task.id}/start`, {
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

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.ok(log.events.some((event) => event.type === "task_scheduled"));
    assert.ok(log.events.some((event) => event.type === "user_stopped"));
    const runLog = await request(server, `/api/tasks/${created.task.id}/logs/${encodeURIComponent(started.runId)}`);
    assert.equal(runLog.run.status, "stopped");
    assert.ok(runLog.run.endedAt);
    assert.ok(fs.existsSync(runLog.logPath));
    assert.ok(fs.existsSync(runLog.eventLogPath));
});

test("server exposes ordered structured task log events with raw output", async (t) => {
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
    const script = writeAgentScript(tempRoot, "agent-structured-log.sh", [
        "console.log(\"first line\\nsecond line\");",
        "console.error(\"warning one\\nwarning two\");",
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "structured-log-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "结构化日志",
            requirement: "验证事件顺序",
            targetFileName: "structured-log-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });
    const started = await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    });

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    const sequences = log.events.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
    assert.equal(new Set(sequences).size, sequences.length);
    assert.ok(log.events.every((event) => event.taskId === created.task.id));
    assert.ok(log.events.every((event) => typeof event.runId === "string" && event.runId.length > 0));

    const runEvents = log.events.filter((event) => event.runId === started.runId);
    const runTypes = new Set(runEvents.map((event) => event.type));
    for (const type of [
        "task_started",
        "agent_selected",
        "command",
        "prompt",
        "process_started",
        "stdout",
        "stderr",
        "process_exit",
        "task_all_done",
    ]) {
        assert.ok(runTypes.has(type), `missing structured log event: ${type}`);
    }
    assert.ok(runEvents.some((event) => event.type === "stdout" && event.text.includes("first line\nsecond line\n")));
    assert.ok(runEvents.some((event) => event.type === "stderr" && event.text.includes("warning one\nwarning two\n")));
    assert.equal(runEvents.find((event) => event.type === "agent_selected").profile.name, "structured-log-agent");

    const promptEvent = runEvents.find((event) => event.type === "prompt");
    const incremental = await request(server, `/api/tasks/${created.task.id}/log?after=${promptEvent.sequence}`);
    assert.ok(incremental.events.length > 0);
    assert.ok(incremental.events.every((event) => event.sequence > promptEvent.sequence));
    assert.equal(incremental.nextCursor, incremental.events.at(-1).sequence);
});

test("server incrementally persists isolated run logs and reloads them after restart", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    let server = createApp({
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
    const counterPath = path.join(tempRoot, "run-counter.txt");
    const script = writeAgentScript(tempRoot, "agent-run-history.sh", [
        `const counterPath = ${JSON.stringify(counterPath)};`,
        "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, \"utf8\")) + 1 : 1;",
        "fs.writeFileSync(counterPath, String(count), \"utf8\");",
        "console.log(`run-${count}-begin`);",
        "await sleep(350);",
        "console.error(`run-${count}-warning`);",
        "console.log(\"GGGG全部完成GGGG\");",
    ].join("\n"));
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "run-history-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "运行日志历史",
            requirement: "验证增量保存和重启读取",
            targetFileName: "run-history-task.md",
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });

    const firstStarted = await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const startedState = await request(server, "/api/state");
    const startedTask = startedState.tasks.find((task) => task.id === created.task.id);
    const firstRunState = startedTask.logRuns.find((run) => run.runId === firstStarted.runId);
    assert.ok(firstRunState);
    assert.ok(fs.existsSync(path.join(tempData, "logs", firstRunState.logFile)));
    assert.ok(fs.existsSync(path.join(tempData, "logs", firstRunState.eventLogFile)));

    const incremental = await waitFor(async () => {
        const log = await request(server, `/api/tasks/${created.task.id}/log?runId=${encodeURIComponent(firstStarted.runId)}`);
        return log.events.some((event) => event.type === "stdout" && event.text.includes("run-1-begin")) ? log : null;
    });
    assert.equal(incremental.runId, firstStarted.runId);
    assert.match(fs.readFileSync(incremental.eventLogPath, "utf8"), /run-1-begin/);
    assert.match(fs.readFileSync(incremental.logPath, "utf8"), /run-1-begin/);

    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === created.task.id && task.status === "all_done");
    });
    const firstLog = await request(server, `/api/tasks/${created.task.id}/logs/${encodeURIComponent(firstStarted.runId)}`);
    assert.equal(firstLog.run.status, "all_done");
    assert.ok(firstLog.events.every((event) => event.runId === firstStarted.runId));
    assert.match(firstLog.content, /run-1-warning/);

    server.closeRunners();
    server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    const reloaded = await request(server, `/api/tasks/${created.task.id}/logs/${encodeURIComponent(firstStarted.runId)}`);
    assert.equal(reloaded.run.status, "all_done");
    assert.match(reloaded.content, /run-1-begin/);
    assert.ok(reloaded.events.some((event) => event.type === "task_all_done"));

    const secondStarted = await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === created.task.id && task.status === "all_done" && task.lastRunId === secondStarted.runId);
    });
    const history = await request(server, `/api/tasks/${created.task.id}/logs`);
    assert.deepEqual(new Set(history.runs.map((run) => run.runId)), new Set([firstStarted.runId, secondStarted.runId]));
    const secondLog = await request(server, `/api/tasks/${created.task.id}/logs/${encodeURIComponent(secondStarted.runId)}`);
    assert.notEqual(firstLog.logPath, secondLog.logPath);
    assert.notEqual(firstLog.eventLogPath, secondLog.eventLogPath);
    assert.ok(secondLog.events.every((event) => event.runId === secondStarted.runId));
    assert.match(secondLog.content, /run-2-begin/);
    assert.doesNotMatch(secondLog.content, /run-1-begin/);
});

test("server completes a durable lifecycle with rich output and historical append", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const targetFileName = "e2e-丰富日志.md";
    const targetPath = path.join(tempRoot, targetFileName);
    const counterPath = path.join(tempRoot, "e2e-run-count.txt");
    const originalContent = [
        "# E2E 历史任务 😀",
        "",
        "## 原始需求",
        "",
        "保留 <原始标记> & Unicode 内容。",
        "",
        "## 任务列表",
        "",
        "- [x] 1. 原始任务",
        "  - 状态：已完成",
        "  - 完成标准：原始任务已验证",
        "  - 执行记录：第一阶段",
        "",
    ].join("\n");
    fs.writeFileSync(targetPath, originalContent, "utf8");

    const richStdout = "<script>alert('x')</script> & <img src=x onerror=alert(2)>\n第一行\n第二行\n";
    const richStderr = "错误流 <b>not markup</b>\n第二个错误 😀\n";
    const script = writeAgentScript(tempRoot, "agent-e2e-rich.js", [
        `const targetPath = ${JSON.stringify(targetPath)};`,
        `const counterPath = ${JSON.stringify(counterPath)};`,
        "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, \"utf8\")) + 1 : 1;",
        "fs.writeFileSync(counterPath, String(count), \"utf8\");",
        "if (count === 1) {",
        `    process.stdout.write(${JSON.stringify(richStdout)});`,
        `    process.stderr.write(${JSON.stringify(richStderr)});`,
        "    process.stdout.write(\"L\".repeat(16000));",
        "    process.stdout.write(\"\\nGGGG全部完成GGGGGGGG全部完成GGGG\\n\");",
        "} else {",
        "    const current = fs.readFileSync(targetPath, \"utf8\");",
        "    fs.writeFileSync(targetPath, current.replace(\"- [ ] 2. \", \"- [x] 2. \"), \"utf8\");",
        "    console.log(\"第二轮完成 ✓\");",
        "    console.log(\"GGGG全部完成GGGG\");",
        "}",
    ].join("\n"));

    let server = createApp({
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

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "e2e-rich-agent",
            agentType: "custom",
            provider: "custom",
            command: script.command,
            args: script.args,
            timeoutSeconds: 5,
            pingEnabled: false,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "E2E 丰富日志",
            targetFileName,
            directory: tempRoot,
            sourceMode: "existing",
            runProfileIds: [profile.profile.id],
        },
    });
    const taskId = created.task.id;

    const firstStarted = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const startedLog = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(firstStarted.runId)}`);
    assert.equal(startedLog.runId, firstStarted.runId);
    assert.ok(fs.existsSync(startedLog.logPath));
    assert.ok(fs.existsSync(startedLog.eventLogPath));

    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === taskId
            && task.status === "all_done"
            && task.lastRunId === firstStarted.runId);
    });

    const firstLog = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(firstStarted.runId)}`);
    assert.equal(firstLog.run.status, "all_done");
    const firstEvents = firstLog.events.filter((event) => event.runId === firstStarted.runId);
    const firstTypes = new Set(firstEvents.map((event) => event.type));
    for (const type of [
        "agent_selected",
        "command",
        "prompt",
        "process_started",
        "first_output",
        "stdout",
        "stderr",
        "process_exit",
        "task_all_done",
    ]) {
        assert.ok(firstTypes.has(type), `missing rich lifecycle event: ${type}`);
    }
    const stdout = firstEvents.filter((event) => event.type === "stdout").map((event) => event.text).join("");
    const stderr = firstEvents.filter((event) => event.type === "stderr").map((event) => event.text).join("");
    assert.match(stdout, /<script>alert\('x'\)<\/script>/);
    assert.match(stdout, /第一行\n第二行/);
    assert.ok(stdout.includes("L".repeat(16000)));
    assert.match(stderr, /错误流 <b>not markup<\/b>\n第二个错误 😀/);
    assert.match(firstLog.content, /<img src=x onerror=alert\(2\)>/);
    assert.match(fs.readFileSync(firstLog.eventLogPath, "utf8"), /第二个错误 😀/);

    // A restart must not lose the completed run or its full output.
    server.closeRunners();
    server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    const reloadedLog = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(firstStarted.runId)}`);
    assert.equal(reloadedLog.run.status, "all_done");
    assert.match(reloadedLog.content, /第一行/);
    assert.ok(reloadedLog.events.some((event) => event.text.includes("L".repeat(16000))));

    const appendedText = "追加 <危险标签> & Unicode 🚀";
    const appended = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/items`, {
        method: "POST",
        body: {
            items: [{ text: appendedText, completionCriteria: "追加项必须被第二轮标记完成" }],
        },
    });
    assert.equal(appended.previousStatus, "all_done");
    assert.equal(appended.status, "not_started");
    assert.equal(appended.items[0].status, "not_started");
    assert.equal(appended.items[0].number, 2);

    const afterAppend = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/file`);
    assert.equal(afterAppend.content.slice(0, originalContent.length), originalContent);
    assert.match(afterAppend.content, /- \[x\] 1\. 原始任务/);
    assert.ok(afterAppend.content.includes(`- [ ] 2. ${appendedText}`));
    assert.equal((afterAppend.content.match(/- \[ \]/g) || []).length, 1);
    const appendLog = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/log`);
    assert.ok(appendLog.events.some((event) => event.type === "task_items_appended"));
    assert.match(appendLog.content, /追加 <危险标签> & Unicode 🚀/);

    // A second restart proves the append metadata and pending state are durable.
    server.closeRunners();
    server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });
    const beforeSecondRun = await request(server, "/api/state");
    const pendingTask = beforeSecondRun.tasks.find((task) => task.id === taskId);
    assert.equal(pendingTask.status, "not_started");
    assert.equal(pendingTask.appendedItems.at(-1).status, "not_started");
    assert.equal(pendingTask.appendedItems.at(-1).text, appendedText);

    const secondStarted = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === taskId
            && task.status === "all_done"
            && task.lastRunId === secondStarted.runId);
    });
    const finalFile = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/file`);
    assert.match(finalFile.content, /- \[x\] 1\. 原始任务/);
    assert.ok(finalFile.content.includes(`- [x] 2. ${appendedText}`));
    assert.equal((finalFile.content.match(/- \[x\]/g) || []).length, 2);
    const secondLog = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(secondStarted.runId)}`);
    assert.equal(secondLog.run.status, "all_done");
    assert.match(secondLog.content, /第二轮完成 ✓/);
    assert.doesNotMatch(secondLog.content, /<script>alert\('x'\)<\/script>/);
    const history = await request(server, `/api/tasks/${encodeURIComponent(taskId)}/logs`);
    assert.deepEqual(new Set(history.runs.map((run) => run.runId)), new Set([firstStarted.runId, secondStarted.runId]));
});

test("server reports empty corrupt and legacy logs without allowing path traversal", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    let server = createApp({
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

    async function createExistingTask(name) {
        fs.writeFileSync(path.join(tempRoot, `${name}.md`), `# ${name}\n`, "utf8");
        return request(server, "/api/tasks", {
            method: "POST",
            body: {
                title: name,
                targetFileName: `${name}.md`,
                directory: tempRoot,
                sourceMode: "existing",
            },
        });
    }

    const legacyTask = await createExistingTask("legacy-log");
    const legacyPaths = await request(server, `/api/tasks/${legacyTask.task.id}/log`);
    fs.rmSync(legacyPaths.eventLogPath, { force: true });
    fs.writeFileSync(legacyPaths.logPath, "[legacy] old output\n", "utf8");
    const legacy = await request(server, `/api/tasks/${legacyTask.task.id}/log`);
    assert.equal(legacy.format, "legacy");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.events.length, 0);
    assert.match(legacy.content, /old output/);
    assert.ok(legacy.warnings.some((warning) => warning.code === "legacy_format"));

    const largeLegacyContent = `${"old-prefix-line\n".repeat(24000)}tail-marker-保留\n`;
    fs.writeFileSync(legacyPaths.logPath, largeLegacyContent, "utf8");
    const largeLegacy = await request(server, `/api/tasks/${legacyTask.task.id}/log`);
    assert.equal(largeLegacy.format, "legacy");
    assert.equal(largeLegacy.contentTruncated, true);
    assert.ok(largeLegacy.contentBytes > largeLegacy.contentReturnedBytes);
    assert.ok(Buffer.byteLength(largeLegacy.content) <= 256 * 1024);
    assert.match(largeLegacy.content, /tail-marker-保留/);
    assert.ok(largeLegacy.warnings.some((warning) => warning.code === "content_truncated"));

    const fullLegacy = await request(server, `/api/tasks/${legacyTask.task.id}/log?full=1`);
    assert.equal(fullLegacy.contentTruncated, false);
    assert.equal(fullLegacy.content, largeLegacyContent);

    const corruptTask = await createExistingTask("corrupt-log");
    const corruptPaths = await request(server, `/api/tasks/${corruptTask.task.id}/log`);
    fs.writeFileSync(corruptPaths.eventLogPath, [
        JSON.stringify({
            version: 1,
            id: "valid-event",
            sequence: 7,
            taskId: corruptTask.task.id,
            runId: "run-corrupt",
            timestamp: "2026-07-25T00:00:00.000Z",
            type: "stdout",
            phase: "run",
            text: "valid output",
            stream: "stdout",
            profile: null,
            metadata: {},
        }),
        "not-json",
        "",
    ].join("\n"), "utf8");
    const corrupt = await request(server, `/api/tasks/${corruptTask.task.id}/log`);
    assert.equal(corrupt.format, "structured_partial");
    assert.equal(corrupt.status, "partial");
    assert.equal(corrupt.corrupted, true);
    assert.deepEqual(corrupt.events.map((event) => event.text), ["valid output"]);
    assert.ok(corrupt.warnings.some((warning) => warning.code === "malformed_jsonl" && warning.count === 1));
    const inferredRun = await request(server, `/api/tasks/${corruptTask.task.id}/logs/run-corrupt`);
    assert.equal(inferredRun.run.inferred, true);
    assert.deepEqual(inferredRun.events.map((event) => event.runId), ["run-corrupt"]);

    const emptyTask = await createExistingTask("empty-log");
    const emptyPaths = await request(server, `/api/tasks/${emptyTask.task.id}/log`);
    fs.rmSync(emptyPaths.logPath, { force: true });
    fs.rmSync(emptyPaths.eventLogPath, { force: true });
    const empty = await request(server, `/api/tasks/${emptyTask.task.id}/log`);
    assert.equal(empty.format, "empty");
    assert.equal(empty.status, "missing");
    assert.equal(empty.content, "");
    assert.deepEqual(empty.events, []);

    server.closeRunners();
    const statePath = path.join(tempData, "state.json");
    const savedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const unsafeTask = savedState.tasks.find((task) => task.id === emptyTask.task.id);
    unsafeTask.logFile = "../outside-secret.log";
    unsafeTask.logEventsFile = "../outside-secret.events.jsonl";
    unsafeTask.logRuns = [{
        runId: "../outside-run",
        status: "completed",
        startedAt: "2026-07-25T00:00:00.000Z",
        endedAt: "2026-07-25T00:00:01.000Z",
        logFile: "../../outside-secret.log",
        eventLogFile: "../../outside-secret.events.jsonl",
    }];
    fs.writeFileSync(statePath, JSON.stringify(savedState, null, 2), "utf8");
    fs.writeFileSync(path.join(tempData, "outside-secret.log"), "TOP SECRET", "utf8");
    fs.writeFileSync(path.join(tempData, "outside-secret.events.jsonl"), "TOP SECRET", "utf8");
    server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
    });

    const safeAggregate = await request(server, `/api/tasks/${emptyTask.task.id}/log`);
    assert.equal(safeAggregate.content, "");
    assert.equal(path.dirname(safeAggregate.logPath), path.join(tempData, "logs"));
    assert.doesNotMatch(JSON.stringify(safeAggregate), /TOP SECRET/);
    const unsafeRunId = encodeURIComponent("../outside-run");
    const safeRun = await request(server, `/api/tasks/${emptyTask.task.id}/logs/${unsafeRunId}`);
    assert.equal(safeRun.content, "");
    assert.equal(path.dirname(safeRun.logPath), path.join(tempData, "logs"));
    assert.equal(path.dirname(safeRun.eventLogPath), path.join(tempData, "logs"));
    assert.doesNotMatch(JSON.stringify(safeRun), /TOP SECRET/);

    const missingRun = await server.inject({
        method: "GET",
        path: `/api/tasks/${emptyTask.task.id}/logs/not-a-run`,
    });
    assert.equal(missingRun.statusCode, 404);
    assert.equal(missingRun.json().error, "任务运行日志不存在");
    const malformedPath = await server.inject({
        method: "GET",
        path: `/api/tasks/${emptyTask.task.id}/logs/%E0%A4%A`,
    });
    assert.equal(malformedPath.statusCode, 400);
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
    assert.ok(log.events.some((event) => event.type === "profile_switched"));
    assert.ok(log.events.some((event) => event.type === "retry_wait" && event.metadata.reason === "429"));
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
    assert.equal(typeof result.records[0].prompt, "string");
    assert.ok(result.records[0].prompt.length > 0);
    assert.notEqual(result.records[0].prompt, "hello");

    const state = await request(server, "/api/state");
    assert.equal(state.pingRecords.length, 2);
    assert.equal(state.pingDays.length, 1);
    assert.equal(state.pingDays[0].total, 2);
    assert.equal(state.pingDays[0].success, 1);
    assert.equal(state.pingDays[0].failed, 1);
    assert.equal(state.pingDays[0].records.length, 2);
});

test("server can disable and re-enable the global ping feature", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-global-ping.sh", "console.log(\"pong\");");
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [{
            id: "profile_codex_ping_toggle",
            name: "codex-ping-toggle",
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
            pingEnabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }],
        tasks: [],
        events: [],
        pingRecords: [],
        pingSettings: { enabled: true },
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

    const disabled = await request(server, "/api/pings/settings", {
        method: "POST",
        body: { enabled: false },
    });
    assert.equal(disabled.pingSettings.enabled, false);

    const blocked = await server.inject({ method: "POST", path: "/api/pings/run" });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error, /Ping/);

    const disabledState = await request(server, "/api/state");
    assert.equal(disabledState.pingSettings.enabled, false);
    assert.equal(disabledState.pingRecords.length, 0);

    const enabled = await request(server, "/api/pings/settings", {
        method: "POST",
        body: { enabled: true },
    });
    assert.equal(enabled.pingSettings.enabled, true);

    const result = await request(server, "/api/pings/run", { method: "POST" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].success, true);
});

test("server pings with one random prompt from the prepared 30 simple questions", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-random-prompt.sh", [
        "console.log(process.argv.slice(2).join(\" \"));",
    ].join("\n"));
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [{
            id: "profile_claude_random_prompt",
            name: "claude-random-prompt",
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
            pingEnabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }],
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
        pingQuestionRandom: () => 0,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const state = await request(server, "/api/state");
    assert.equal(state.pingQuestionCount, 30);

    const result = await request(server, "/api/pings/run", { method: "POST" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].prompt, "What is 1+1?");
    assert.notEqual(result.records[0].prompt, "hello");
    assert.match(result.records[0].outputTail, /What is 1\+1\?/);
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

test("server runs image and video tasks with provider metadata and artifact previews", async (t) => {
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

    const script = writeAgentScript(tempRoot, "agent-media.sh", [
        "const path = require(\"node:path\");",
        "fs.mkdirSync(path.dirname(process.env.AGENT_OUTPUT_FILE), { recursive: true });",
        "fs.writeFileSync(process.env.AGENT_OUTPUT_FILE, JSON.stringify({",
        "    provider: process.env.AGENT_PROVIDER,",
        "    model: process.env.AGENT_MODEL,",
        "    taskType: process.env.AGENT_TASK_TYPE,",
        "    outputFormat: process.env.AGENT_OUTPUT_FORMAT,",
        "    aspectRatio: process.env.AGENT_ASPECT_RATIO,",
        "    resolution: process.env.AGENT_RESOLUTION,",
        "    durationSeconds: process.env.AGENT_DURATION_SECONDS || \"\",",
        "    referenceFiles: process.env.AGENT_REFERENCE_FILES || \"\",",
        "}), \"utf8\");",
        "console.log(\"media generated\");",
    ].join("\n"));

    const saved = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "replicate-media",
            provider: "replicate",
            agentType: "custom",
            command: script.command,
            args: script.args,
            apiToken: "replicate-secret",
            modelName: "owner/media-model",
            inputModalities: ["text", "image"],
            outputModalities: ["image", "video"],
            timeoutSeconds: 3,
            enabled: true,
        },
    });
    assert.equal(saved.profile.provider, "replicate");
    assert.deepEqual(saved.profile.outputModalities, ["image", "video"]);
    assert.equal(saved.profile.apiTokenConfigured, true);

    const imageTask = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "海报生成",
            requirement: "生成一张复古电影海报",
            targetFileName: "poster-task.md",
            directory: tempRoot,
            sourceMode: "template",
            taskType: "image",
            runProfileIds: [saved.profile.id],
            outputFileName: "poster.webp",
            outputFormat: "webp",
            aspectRatio: "3:4",
            resolution: "1536x2048",
            referenceFiles: "assets/reference.png",
        },
    });
    await request(server, `/api/tasks/${imageTask.task.id}/start`, {
        method: "POST",
        body: { profileIds: [saved.profile.id] },
    });

    const finishedImage = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === imageTask.task.id && task.status === "all_done");
    });
    assert.equal(finishedImage.taskType, "image");
    assert.equal(finishedImage.artifactCount, 1);
    assert.equal(finishedImage.artifacts[0].relativePath, "poster.webp");
    const imagePayload = JSON.parse(fs.readFileSync(path.join(finishedImage.artifactDirectory, "poster.webp"), "utf8"));
    assert.deepEqual(imagePayload, {
        provider: "replicate",
        model: "owner/media-model",
        taskType: "image",
        outputFormat: "webp",
        aspectRatio: "3:4",
        resolution: "1536x2048",
        durationSeconds: "",
        referenceFiles: "assets/reference.png",
    });

    const artifactResponse = await server.inject({
        method: "GET",
        path: finishedImage.artifacts[0].url,
    });
    assert.equal(artifactResponse.statusCode, 200);
    assert.equal(artifactResponse.headers["content-type"], "image/webp");

    const videoTask = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "短视频生成",
            requirement: "生成产品转台短视频",
            targetFileName: "video-task.md",
            directory: tempRoot,
            sourceMode: "template",
            taskType: "video",
            runProfileIds: [saved.profile.id],
            outputFileName: "turntable.mp4",
            outputFormat: "mp4",
            aspectRatio: "16:9",
            resolution: "1920x1080",
            durationSeconds: 8,
        },
    });
    await request(server, `/api/tasks/${videoTask.task.id}/start`, {
        method: "POST",
        body: { profileIds: [saved.profile.id] },
    });
    const finishedVideo = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((task) => task.id === videoTask.task.id && task.status === "all_done");
    });
    assert.equal(finishedVideo.artifacts[0].mediaType, "video");
    assert.equal(finishedVideo.artifacts[0].contentType, "video/mp4");
    const videoPayload = JSON.parse(fs.readFileSync(path.join(finishedVideo.artifactDirectory, "turntable.mp4"), "utf8"));
    assert.equal(videoPayload.durationSeconds, "8");
});

test("server rejects incompatible media Profiles and artifact paths outside the workspace", async (t) => {
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

    const textOnly = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "text-only",
            agentType: "custom",
            provider: "custom",
            command: process.execPath,
            args: "-e \"console.log('done')\" {prompt}",
            inputModalities: ["text"],
            outputModalities: ["text"],
            enabled: true,
        },
    });
    const incompatible = await server.inject({
        method: "POST",
        path: "/api/tasks",
        body: {
            title: "image task",
            requirement: "generate image",
            targetFileName: "image.md",
            directory: tempRoot,
            sourceMode: "template",
            taskType: "image",
            runProfileIds: [textOnly.profile.id],
        },
    });
    assert.equal(incompatible.statusCode, 400);
    assert.match(incompatible.json().error, /支持 image 输出/);

    const imageProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "image-provider",
            agentType: "custom",
            provider: "fal",
            command: process.execPath,
            args: "-e \"console.log('done')\" {prompt}",
            inputModalities: ["text"],
            outputModalities: ["image"],
            enabled: true,
        },
    });
    const escaped = await server.inject({
        method: "POST",
        path: "/api/tasks",
        body: {
            title: "escaped artifact",
            requirement: "generate image",
            targetFileName: "escaped.md",
            directory: tempRoot,
            sourceMode: "template",
            taskType: "image",
            artifactDirectoryName: "../outside",
            runProfileIds: [imageProfile.profile.id],
        },
    });
    assert.equal(escaped.statusCode, 400);
    assert.match(escaped.json().error, /产物目录必须位于任务工作目录内/);
});
