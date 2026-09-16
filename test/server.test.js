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
    assert.match(startup, /127\.0\.0\.1:13100/);
    assert.match(startup, /listening on 0\.0\.0\.0:13100/);
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
    // The all-done marker has to appear twice back to back on one line, as the run prompt demands.
    fs.writeFileSync(path.join(tempRoot, "fake-codex.ps1"), [
        "$marker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\"5YWo6YOo5a6M5oiQ\"))",
        "Write-Output ('GGGG' + $marker + 'GGGG' + 'GGGG' + $marker + 'GGGG')",
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
        const item = state.tasks.find((entry) => entry.id === created.task.id);
        return item && item.lastExitCode !== null ? item : null;
    });
    assert.equal(task.lastExitCode, 0);
    assert.match(task.lastCommand, /pwsh(\.exe)?|powershell\.exe/i);
    assert.match(task.lastCommand, /fake-codex\.ps1/i);
    if (/pwsh/i.test(task.lastCommand)) {
        // pwsh runs through the UTF-8 delegate, so PowerShell-authored Chinese survives the pipe
        // and the all-done marker is detected. The legacy host encodes with the OEM code page.
        assert.equal(task.status, "all_done");
        assert.match(task.lastOutput, /GGGG全部完成GGGGGGGG全部完成GGGG/);
    }
});

test("server reports a missing working directory instead of a spawn ENOENT", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const vanishingDirectory = path.join(tempRoot, "vanishing-directory");
    fs.mkdirSync(vanishingDirectory, { recursive: true });

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

    const script = writeAgentScript(tempRoot, "agent-vanishing-cwd.sh", "console.log(\"should never run\");");
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "vanishing-cwd-agent",
            agentType: "claude",
            command: script.command,
            args: script.args,
            timeoutSeconds: 5,
            enabled: true,
        },
    });
    await request(server, "/api/directories", {
        method: "POST",
        body: { directory: vanishingDirectory },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "工作目录消失",
            requirement: "确认报错指向工作目录而不是命令",
            targetFileName: "vanishing-cwd.md",
            directory: vanishingDirectory,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    fs.rmSync(vanishingDirectory, { recursive: true, force: true });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });

    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.lastExitCode !== null);
    });
    assert.equal(task.lastExitCode, 127);
    assert.match(task.lastOutput, /工作目录不存在/);
    assert.match(task.lastOutput, /vanishing-directory/);
    assert.doesNotMatch(task.lastOutput, /ENOENT/);
});

test("server keeps a relative profile working directory relative to the project", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-relative-cwd.sh", [
        "fs.writeFileSync(\"agent-cwd.txt\", process.cwd(), \"utf8\");",
        "console.log(\"pong\");",
    ].join("\n"));

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
            name: "relative-cwd-agent",
            agentType: "claude",
            command: script.command,
            args: script.args,
            defaultDirectory: "default_work_dir",
            timeoutSeconds: 5,
            enabled: true,
        },
    });
    assert.equal(profile.profile.defaultDirectory, "default_work_dir");

    const resolved = await request(server, "/api/state").then((state) => state.profiles[0].defaultDirectory);
    assert.equal(resolved, "default_work_dir");
    await assert.rejects(
        request(server, "/api/profiles", {
            method: "POST",
            body: { id: profile.profile.id, defaultDirectory: "../outside-project" },
        }),
        /必须位于项目目录内/,
    );

    const result = await request(server, "/api/pings/run", { method: "POST" });
    const record = result.records.find((item) => item.profileId === profile.profile.id);
    assert.ok(record);
    assert.equal(record.success, true);

    // The agent ran inside the project-relative directory, which the server created on demand.
    const cwdFile = path.join(tempRoot, "default_work_dir", "agent-cwd.txt");
    assert.equal(fs.existsSync(cwdFile), true);
    assert.match(fs.readFileSync(cwdFile, "utf8").trim(), /default_work_dir$/);
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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

test("server rejects a single all-done marker", async (t) => {
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
    const script = writeAgentScript(tempRoot, "agent-incomplete-all-done.sh", "console.log(\"GGGG全部完成GGGG\");");

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "incomplete-all-done-agent",
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
            title: "strict all done",
            requirement: "a single marker must not finish the task",
            targetFileName: "strict-all-done.md",
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
        return state.tasks.find((item) => item.id === created.task.id && item.status === "retry_wait");
    });
    assert.equal(task.lastExitCode, 0);
    assert.notEqual(task.status, "all_done");

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.equal(log.events.some((event) => event.type === "task_all_done"), false);
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        body: { profileIds: [profile.profile.id], scheduleMode: "fixed_time", startAt },
    });

    const scheduledState = await request(server, "/api/state");
    const scheduledTask = scheduledState.tasks.find((item) => item.id === created.task.id);
    assert.equal(scheduledTask.status, "scheduled");
    assert.equal(scheduledTask.scheduleMode, "fixed_time");
    assert.equal(scheduledTask.scheduledStartAt, startAt);
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

test("server starts a task when its Profile becomes available", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const availabilityGate = path.join(tempRoot, "model-available.flag");
    const script = writeAgentScript(tempRoot, "agent-availability.sh", [
        `if (String(process.env.AGENT_TASK_ID || "").startsWith("ping_") && !fs.existsSync(${JSON.stringify(availabilityGate)})) {`,
        "    console.error(\"model unavailable\");",
        "    process.exit(2);",
        "}",
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
    ].join("\n"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        availabilityCheckIntervalMs: 60,
        pingQuestionRandom: () => 0,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "availability-agent",
            agentType: "codex",
            command: script.command,
            args: script.args,
            timeoutSeconds: 1,
            pingEnabled: false,
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "模型可用预约",
            requirement: "模型可用后运行",
            targetFileName: "availability-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });

    const scheduled = await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: {
            profileIds: [profile.profile.id],
            scheduleMode: "profile_available",
        },
    });
    assert.equal(scheduled.scheduleMode, "profile_available");
    assert.equal(scheduled.runProfileIds[0], profile.profile.id);

    const waitingTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        const task = state.tasks.find((item) => item.id === created.task.id);
        const failedCheck = state.pingRecords.some((record) => record.taskId === created.task.id && record.success === false);
        return task?.status === "scheduled" && failedCheck ? task : null;
    });
    assert.equal(waitingTask.scheduleMode, "profile_available");
    assert.equal(waitingTask.availabilityCheckIntervalMinutes, 30);
    assert.ok(waitingTask.availabilityNextCheckAt);
    assert.equal(waitingTask.runtimeState, RUNTIME_STATE.idleWaiting);
    assert.equal(fs.existsSync(availabilityGate), false);

    fs.writeFileSync(availabilityGate, "ready", "utf8");
    const finishedTask = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    }, { timeoutMs: 2500 });
    assert.equal(finishedTask.scheduleMode, "profile_available");
    assert.equal(finishedTask.availabilityNextCheckAt, null);

    const state = await request(server, "/api/state");
    const records = state.pingRecords.filter((record) => record.taskId === created.task.id);
    assert.ok(records.length >= 2);
    assert.equal(records.some((record) => record.success), true);
    assert.equal(records.some((record) => record.success === false), true);
    assert.ok(records.every((record) => record.source === "task_availability"));
    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.ok(log.events.some((event) => event.type === "availability_check"));
    assert.ok(log.events.some((event) => event.type === "availability_wait"));
    assert.ok(log.events.some((event) => event.type === "profile_available"));
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "    console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
    const nextScript = writeAgentScript(tempRoot, "agent-next.sh", "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");");

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

test("server selects the first available task Profile in configured order", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const executionOrder = path.join(tempRoot, "profile-order.log");
    const unavailableRun = path.join(tempRoot, "unavailable-run.txt");
    const availableRun = path.join(tempRoot, "available-run.txt");
    const unavailableScript = writeAgentScript(tempRoot, "agent-unavailable-first.js", [
        `fs.appendFileSync(${JSON.stringify(executionOrder)}, "first\\n", "utf8");`,
        `if (!String(process.env.AGENT_TASK_ID || "").startsWith("ping_")) fs.writeFileSync(${JSON.stringify(unavailableRun)}, "ran", "utf8");`,
        "console.error(\"first profile unavailable\");",
        "process.exit(2);",
    ].join("\n"));
    const availableScript = writeAgentScript(tempRoot, "agent-available-second.js", [
        "const isPing = String(process.env.AGENT_TASK_ID || \"\").startsWith(\"ping_\");",
        `fs.appendFileSync(${JSON.stringify(executionOrder)}, isPing ? "second-ping\\n" : "second-run\\n", "utf8");`,
        "if (isPing) {",
        "    console.log(\"pong\");",
        "    return;",
        "}",
        `fs.writeFileSync(${JSON.stringify(availableRun)}, "ran", "utf8");`,
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
    ].join("\n"));
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

    const unavailableProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "unavailable-first",
            agentType: "codex",
            command: unavailableScript.command,
            args: unavailableScript.args,
            timeoutSeconds: 1,
            enabled: true,
        },
    });
    const availableProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "available-second",
            agentType: "claude",
            command: availableScript.command,
            args: availableScript.args,
            timeoutSeconds: 1,
            enabled: true,
        },
    });
    const profileIds = [unavailableProfile.profile.id, availableProfile.profile.id];
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "顺序选择 Profile",
            requirement: "使用首个可用模型",
            targetFileName: "ordered-profile-task.md",
            directory: tempRoot,
            sourceMode: "template",
            decomposeProfileId: availableProfile.profile.id,
            runProfileIds: profileIds,
        },
    });

    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds },
    });

    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "all_done");
    });
    assert.deepEqual(task.runProfileIds, profileIds);
    assert.equal(task.runProfileId, availableProfile.profile.id);
    assert.equal(fs.existsSync(unavailableRun), false);
    assert.equal(fs.readFileSync(availableRun, "utf8"), "ran");
    assert.equal(fs.readFileSync(executionOrder, "utf8"), "first\nsecond-ping\nsecond-run\n");

    const state = await request(server, "/api/state");
    const selectionRecords = state.pingRecords.filter((record) => record.taskId === created.task.id);
    assert.equal(selectionRecords.length, 2);
    assert.ok(selectionRecords.every((record) => record.source === "task_selection"));
    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.ok(log.events.some((event) => event.type === "availability_check" && event.metadata.source === "task_selection"));
    assert.ok(log.events.some((event) => event.type === "profile_available" && event.profile.id === availableProfile.profile.id));
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
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
    assert.equal(state.events.find((event) => event.type === "ping")?.message, "Ping Profiles：1/2 成功");
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

test("server can test one Profile from the editor and persist the result", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const successScript = writeAgentScript(tempRoot, "agent-profile-editor-ping.sh", [
        "console.log(`editor-pong:${process.argv.slice(2).join(\" \")}`);",
    ].join("\n"));
    const failureScript = writeAgentScript(tempRoot, "agent-profile-editor-ping-fail.sh", [
        "console.error(\"editor connection failed\");",
        "process.exit(3);",
    ].join("\n"));
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

    const saved = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "editor-ping-profile",
            agentType: "claude",
            command: successScript.command,
            args: successScript.args,
            timeoutSeconds: 1,
            pingEnabled: false,
            enabled: true,
        },
    });
    const profileId = saved.profile.id;
    const success = await request(server, `/api/profiles/${encodeURIComponent(profileId)}/ping`, {
        method: "POST",
    });
    assert.equal(success.ok, true);
    assert.equal(success.record.profileId, profileId);
    assert.equal(success.record.source, "manual");
    assert.equal(success.record.success, true);
    assert.equal(success.record.prompt, "What is 1+1?");
    assert.equal(typeof success.record.durationMs, "number");

    await request(server, "/api/profiles", {
        method: "POST",
        body: {
            id: profileId,
            name: "editor-ping-profile",
            agentType: "claude",
            command: failureScript.command,
            args: failureScript.args,
            timeoutSeconds: 1,
            pingEnabled: false,
            enabled: true,
        },
    });
    const failure = await request(server, `/api/profiles/${encodeURIComponent(profileId)}/ping`, {
        method: "POST",
    });
    assert.equal(failure.record.success, false);
    assert.match(failure.record.failureReason, /editor connection failed/);

    const state = await request(server, "/api/state");
    assert.equal(state.pingRecords.length, 2);
    assert.equal(state.pingRecords[0].source, "manual");
    assert.match(state.events[0].message, /Ping Profile：editor-ping-profile 失败/);

    const missing = await server.inject({
        method: "POST",
        path: "/api/profiles/does-not-exist/ping",
    });
    assert.equal(missing.statusCode, 404);
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

test("server records first response latency, token usage, and expandable ping I/O details", async (t) => {
    if (process.platform === "win32") {
        t.skip("the fake Codex executable in this test uses a POSIX shebang");
        return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const fakeCodex = path.join(tempRoot, "codex");
    const fakeClaude = path.join(tempRoot, "claude");
    fs.writeFileSync(fakeCodex, [
        "#!/usr/bin/env node",
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "(async () => {",
        "    if (!process.argv.includes(\"--json\")) {",
        "        console.error(\"missing --json\");",
        "        process.exit(2);",
        "    }",
        "    console.log(JSON.stringify({ type: \"thread.started\", thread_id: \"ping-test\" }));",
        "    await sleep(35);",
        "    console.log(JSON.stringify({ type: \"item.completed\", item: { type: \"agent_message\", text: \"Structured pong\" } }));",
        "    console.log(JSON.stringify({ type: \"turn.completed\", usage: { input_tokens: 31, cached_input_tokens: 5, output_tokens: 4 } }));",
        "})().catch((error) => { console.error(error); process.exit(1); });",
        "",
    ].join("\n"), "utf8");
    fs.chmodSync(fakeCodex, 0o755);
    fs.writeFileSync(fakeClaude, [
        "#!/usr/bin/env node",
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "(async () => {",
        "    const formatIndex = process.argv.indexOf(\"--output-format\");",
        "    if (process.argv[formatIndex + 1] !== \"stream-json\" || !process.argv.includes(\"--include-partial-messages\")) {",
        "        console.error(\"missing Claude stream JSON flags\");",
        "        process.exit(2);",
        "    }",
        "    console.log(JSON.stringify({ type: \"system\", subtype: \"init\" }));",
        "    await sleep(30);",
        "    console.log(JSON.stringify({ type: \"stream_event\", event: { type: \"content_block_delta\", delta: { type: \"text_delta\", text: \"Claude\" } } }));",
        "    console.log(JSON.stringify({ type: \"result\", subtype: \"success\", result: \"Claude pong\", usage: { input_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 10, output_tokens: 5 } }));",
        "})().catch((error) => { console.error(error); process.exit(1); });",
        "",
    ].join("\n"), "utf8");
    fs.chmodSync(fakeClaude, 0o755);
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 1,
        directories: [tempRoot],
        profiles: [
            {
                id: "profile_codex_metrics",
                name: "codex-metrics",
                agentType: "codex",
                command: fakeCodex,
                args: "exec {prompt}",
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
            },
            {
                id: "profile_claude_metrics",
                name: "claude-metrics",
                agentType: "claude",
                command: fakeClaude,
                args: "-p {prompt}",
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
        pingQuestionRandom: () => 0,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });

    const result = await request(server, "/api/pings/run", { method: "POST" });
    const codexRecord = result.records.find((record) => record.profileName === "codex-metrics");
    const claudeRecord = result.records.find((record) => record.profileName === "claude-metrics");
    assert.equal(codexRecord.success, true);
    assert.equal(codexRecord.inputText, "What is 1+1?");
    assert.equal(codexRecord.outputText, "Structured pong");
    assert.equal(codexRecord.inputTokens, 31);
    assert.equal(codexRecord.outputTokens, 4);
    assert.equal(codexRecord.totalTokens, 35);
    assert.ok(codexRecord.firstOutputLatencyMs >= 20, `expected model response latency, received ${codexRecord.firstOutputLatencyMs}ms`);
    assert.ok(codexRecord.durationMs >= codexRecord.firstOutputLatencyMs);
    assert.match(codexRecord.command, /exec --json/);

    assert.equal(claudeRecord.success, true);
    assert.equal(claudeRecord.outputText, "Claude pong");
    assert.equal(claudeRecord.inputTokens, 15);
    assert.equal(claudeRecord.outputTokens, 5);
    assert.equal(claudeRecord.totalTokens, 20);
    assert.ok(claudeRecord.firstOutputLatencyMs >= 20);
    assert.match(claudeRecord.command, /--output-format stream-json --include-partial-messages/);

    const state = await request(server, "/api/state");
    assert.equal(state.pingRecords.length, 2);
    assert.equal(state.pingDays[0].records.find((record) => record.profileName === "codex-metrics").inputTokens, 31);
    assert.equal(state.pingDays[0].records.find((record) => record.profileName === "claude-metrics").outputText, "Claude pong");
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

test("server groups tasks by project, queues same-project runs, and archives target plus logs", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const executionLog = path.join(tempRoot, "project-queue-execution.log");
    const agent = writeAgentScript(tempRoot, "agent-project-queue.js", [
        `fs.appendFileSync(${JSON.stringify(executionLog)}, String(process.env.AGENT_TASK_ID || "") + "\\n", "utf8");`,
        "await sleep(100);",
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
    ].join("\n"));
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

    const unbound = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "不绑定项目" },
    });
    assert.equal(unbound.project.directory, "");
    const bound = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "队列项目", directory: tempRoot },
    });
    assert.equal(bound.project.directory, tempRoot);

    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "queue-agent",
            agentType: "custom",
            command: agent.command,
            args: agent.args,
            timeoutSeconds: 2,
            enabled: true,
        },
    });
    const createTask = (title, targetFileName) => request(server, "/api/tasks", {
        method: "POST",
        body: {
            title,
            requirement: title,
            targetFileName,
            projectId: bound.project.id,
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });
    const first = await createTask("当前任务", "current.md");
    const second = await createTask("排队任务", "queued.md");
    assert.equal(first.task.projectId, bound.project.id);
    assert.equal(second.task.directory, tempRoot);

    const firstStart = await request(server, `/api/tasks/${first.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    assert.equal(firstStart.queued, false);
    const secondStart = await request(server, `/api/tasks/${second.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    assert.equal(secondStart.queued, true);
    assert.equal(secondStart.queuePosition, 1);

    const completed = await waitFor(async () => {
        const current = await request(server, "/api/state");
        const firstTask = current.tasks.find((task) => task.id === first.task.id);
        const secondTask = current.tasks.find((task) => task.id === second.task.id);
        return firstTask?.status === "all_done" && secondTask?.status === "all_done"
            ? { current, firstTask, secondTask }
            : null;
    }, { timeoutMs: 4000 });
    assert.equal(completed.secondTask.queuePosition, null);
    assert.equal(fs.readFileSync(executionLog, "utf8").split(/\r?\n/).filter(Boolean).length, 2);

    const archive = await request(server, `/api/tasks/${first.task.id}/archive`, { method: "POST" });
    assert.equal(archive.task.archived, true);
    assert.match(archive.archiveDirectory, /archive/);
    assert.equal(fs.existsSync(path.join(tempRoot, "current.md")), false);
    assert.equal(fs.existsSync(archive.task.filePath), true);
    assert.equal(fs.existsSync(path.join(archive.task.archiveDirectory, "logs")), true);

    const archivedFile = await request(server, `/api/tasks/${first.task.id}/file`);
    assert.match(archivedFile.content, /当前任务/);
    const archivedLog = await request(server, `/api/tasks/${first.task.id}/log`);
    assert.ok(archivedLog.events.some((event) => event.type === "task_archived"));
    const readOnly = await server.inject({
        method: "PUT",
        path: `/api/tasks/${first.task.id}/file`,
        body: { content: "不应修改" },
    });
    assert.equal(readOnly.statusCode, 409);
    const finalState = await request(server, "/api/state");
    assert.equal(finalState.tasks.find((task) => task.id === first.task.id).archived, true);
    assert.ok(finalState.projects.find((project) => project.id === bound.project.id).archivedTaskCount >= 1);
});

test("server serializes tasks from different projects that share one working directory", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const executionLog = path.join(tempRoot, "directory-queue.log");
    const agent = writeAgentScript(tempRoot, "agent-directory-queue.js", [
        `fs.appendFileSync(${JSON.stringify(executionLog)}, String(process.env.AGENT_TASK_ID || "") + "\\n", "utf8");`,
        "await sleep(100);",
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
    ].join("\n"));
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

    const firstProject = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "目录项目 A", directory: tempRoot },
    });
    const secondProject = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "目录项目 B", directory: tempRoot },
    });
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "directory-queue-agent",
            agentType: "custom",
            command: agent.command,
            args: agent.args,
            timeoutSeconds: 2,
            enabled: true,
        },
    });
    const createTask = (projectId, title, targetFileName) => request(server, "/api/tasks", {
        method: "POST",
        body: {
            projectId,
            title,
            requirement: title,
            targetFileName,
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });
    const first = await createTask(firstProject.project.id, "目录任务 A", "directory-a.md");
    const second = await createTask(secondProject.project.id, "目录任务 B", "directory-b.md");

    await request(server, `/api/tasks/${first.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const queued = await request(server, `/api/tasks/${second.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.queueDirectory, tempRoot);
    assert.equal(queued.activeTaskId, first.task.id);

    const queuedState = await request(server, "/api/state");
    const queuedTask = queuedState.tasks.find((task) => task.id === second.task.id);
    assert.equal(queuedTask.queuePosition, 1);
    assert.equal(queuedTask.queueDirectory, tempRoot);
    assert.equal(queuedTask.queueActiveTaskId, first.task.id);

    await waitFor(async () => {
        const current = await request(server, "/api/state");
        return current.tasks.find((task) => task.id === first.task.id)?.status === "all_done"
            && current.tasks.find((task) => task.id === second.task.id)?.status === "all_done";
    }, { timeoutMs: 4000 });
    assert.deepEqual(
        fs.readFileSync(executionLog, "utf8").split(/\r?\n/).filter(Boolean),
        [first.task.id, second.task.id],
    );
});

test("server preserves a requested directory when assigning legacy and unbound project tasks", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const legacyDirectory = path.join(tempRoot, "legacy-directory");
    const unboundDirectory = path.join(tempRoot, "unbound-directory");
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(unboundDirectory);
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

    await request(server, "/api/directories", { method: "POST", body: { directory: legacyDirectory } });
    await request(server, "/api/directories", { method: "POST", body: { directory: unboundDirectory } });
    const legacyTask = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "旧客户端目录任务",
            requirement: "保留传入目录",
            targetFileName: "legacy-directory.md",
            directory: legacyDirectory,
            sourceMode: "template",
        },
    });
    assert.equal(legacyTask.task.directory, legacyDirectory);

    const unbound = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "未绑定目录任务组" },
    });
    const unboundTask = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            projectId: unbound.project.id,
            title: "未绑定项目任务",
            requirement: "使用任务自己的目录",
            targetFileName: "unbound-directory.md",
            directory: unboundDirectory,
            sourceMode: "template",
        },
    });
    assert.equal(unboundTask.task.projectId, unbound.project.id);
    assert.equal(unboundTask.task.directory, unboundDirectory);

    const state = await request(server, "/api/state");
    assert.equal(state.projects.find((project) => project.id === legacyTask.task.projectId)?.directory, legacyDirectory);
    const deleteInUse = await server.inject({
        method: "DELETE",
        path: `/api/directories/${encodeURIComponent(unboundDirectory)}`,
    });
    assert.equal(deleteInUse.statusCode, 409);
    assert.match(deleteInUse.json().error, /目录仍包含任务/);
});

function taskManagementFixture(t) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-task-management-"));
    const dataDir = path.join(rootDir, ".data");
    const options = { rootDir, dataDir, disablePingScheduler: true };
    const server = createApp(options);
    t.after(() => {
        server.closeRunners();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
    return {
        server,
        options,
        rootDir,
        dataDir,
        statePath: path.join(dataDir, "state.json"),
        createTask: async (fileName, overrides = {}) => (await request(server, "/api/tasks", {
            method: "POST",
            body: {
                title: fileName,
                targetFileName: fileName,
                directory: rootDir,
                sourceMode: "template",
                requirement: "保留原始任务内容",
                ...overrides,
            },
        })).task,
    };
}

test("server deletes task records while preserving files, artifacts, logs and unrelated tasks", async (t) => {
    const { server, createTask, options } = taskManagementFixture(t);
    const task = await createTask("delete-me.md", { taskType: "image", outputFileName: "result.png" });
    const other = await createTask("keep-me.md");
    const artifactPath = path.join(task.artifactDirectory, "result.png");
    fs.writeFileSync(artifactPath, "preserved image");
    const log = await request(server, `/api/tasks/${task.id}/log`);
    const preservedPaths = [task.filePath, artifactPath, log.logPath, log.eventLogPath];
    const contents = preservedPaths.map((filePath) => fs.readFileSync(filePath));

    const removed = await request(server, `/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal(removed.deletedTaskId, task.id);
    const state = await request(server, "/api/state");
    assert.deepEqual(state.tasks.map((item) => item.id), [other.id]);
    assert.equal(state.projects[0].currentTaskCount, 1);
    assert.equal(state.projectTaskTree[0].current.length, 1);
    assert.equal(state.events.some((event) => event.taskId === task.id), false);
    preservedPaths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), contents[index]));
    for (const suffix of ["", "/file", "/log"]) {
        const missing = await server.inject({ method: suffix ? "GET" : "DELETE", path: `/api/tasks/${task.id}${suffix}` });
        assert.equal(missing.statusCode, 404);
    }

    const reloaded = createApp(options);
    try {
        assert.deepEqual((await request(reloaded, "/api/state")).tasks.map((item) => item.id), [other.id]);
    } finally {
        reloaded.closeRunners();
    }
    const imported = await createTask("delete-me.md", { sourceMode: "existing" });
    assert.notEqual(imported.id, task.id);
    assert.deepEqual(fs.readFileSync(imported.filePath), contents[0]);
});

test("server can delete an archived task without removing its archive", async (t) => {
    const { server, createTask } = taskManagementFixture(t);
    const task = await createTask("archive-delete.md");
    const { task: archived } = await request(server, `/api/tasks/${task.id}/archive`, { method: "POST" });
    const log = await request(server, `/api/tasks/${task.id}/log`);
    const paths = [archived.filePath, path.join(archived.archiveDirectory, "task.json"), log.logPath, log.eventLogPath];
    const contents = paths.map((filePath) => fs.readFileSync(filePath));
    assert.equal((await request(server, "/api/state")).tasks[0].canDelete, true);
    await request(server, `/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal((await request(server, "/api/state")).tasks.length, 0);
    paths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), contents[index]));
});

test("server rejects deleting active task states and permits deletion after cancelling a schedule", async (t) => {
    const { server, createTask, statePath } = taskManagementFixture(t);
    const task = await createTask("busy.md");
    for (const status of ["running", "queued", "scheduled", "retry_wait"]) {
        const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
        saved.tasks[0].status = status;
        fs.writeFileSync(statePath, JSON.stringify(saved));
        const denied = await server.inject({ method: "DELETE", path: `/api/tasks/${task.id}` });
        assert.equal(denied.statusCode, 409, status);
        assert.equal((await request(server, "/api/state")).tasks[0].canDelete, false, status);
        assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).tasks[0].status, status);
    }
    await request(server, `/api/tasks/${task.id}/stop`, { method: "POST" });
    const state = await request(server, "/api/state");
    await request(server, `/api/tasks/${task.id}/start`, {
        method: "POST",
        body: { profileIds: [state.profiles[0].id], startAt: new Date(Date.now() + 60000).toISOString() },
    });
    assert.equal((await server.inject({ method: "DELETE", path: `/api/tasks/${task.id}` })).statusCode, 409);
    await request(server, `/api/tasks/${task.id}/stop`, { method: "POST" });
    await request(server, `/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal((await request(server, "/api/state")).tasks.length, 0);
});

test("server reuses duplicate creates before overwriting files or changing task configuration", async (t) => {
    const { server, createTask, rootDir, dataDir } = taskManagementFixture(t);
    const original = await createTask("unique.md");
    const content = fs.readFileSync(original.filePath, "utf8");
    const otherProject = await request(server, "/api/projects", {
        method: "POST", body: { name: "同目录的另一个项目", directory: rootDir },
    });
    const results = await Promise.all(["existing", "template", "upload", "agent"].map((sourceMode) => request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "重复的标题",
            directory: path.join(rootDir, "."),
            projectId: otherProject.project.id,
            targetFileName: "../unique.md",
            sourceMode,
            overwrite: true,
            sourceContent: "must not overwrite",
            requirement: "must not regenerate",
            taskType: "image",
        },
    })));
    for (const result of results) {
        assert.equal(result.deduplicated, true);
        assert.equal(result.task.id, original.id);
        assert.equal(result.task.title, original.title);
        assert.equal(result.task.projectId, original.projectId);
        assert.equal(result.task.taskType, "text");
    }
    assert.equal((await request(server, "/api/state")).tasks.length, 1);
    assert.equal(fs.readFileSync(original.filePath, "utf8"), content);
    assert.equal(fs.existsSync(path.join(rootDir, ".agent-output")), false);
    assert.equal(fs.readdirSync(path.join(dataDir, "logs")).length, 2);

    const otherFile = await createTask("different.md", { title: original.title });
    assert.notEqual(otherFile.id, original.id);
    const otherDirectory = path.join(rootDir, "other");
    fs.mkdirSync(otherDirectory);
    await request(server, "/api/directories", { method: "POST", body: { directory: otherDirectory } });
    const otherTask = await createTask("unique.md", { directory: otherDirectory });
    assert.notEqual(otherTask.id, original.id);
});

test("server deduplicates directory aliases even when the target file is missing", { skip: process.platform === "win32" }, async (t) => {
    const { server, createTask, rootDir } = taskManagementFixture(t);
    const original = await createTask("aliased.md");
    const alias = path.join(rootDir, "alias");
    fs.symlinkSync(rootDir, alias, "dir");
    await request(server, "/api/directories", { method: "POST", body: { directory: alias } });
    // Simulate an externally removed target: do not recreate it on a duplicate request.
    fs.unlinkSync(original.filePath);
    const result = await request(server, "/api/tasks", {
        method: "POST",
        body: { directory: alias, targetFileName: "aliased.md", sourceMode: "template", overwrite: true },
    });
    assert.equal(result.deduplicated, true);
    assert.equal(result.task.id, original.id);
    assert.equal(fs.existsSync(original.filePath), false);
    assert.equal((await request(server, "/api/state")).tasks.length, 1);
});

test("server deduplicates during generation without starting another agent or deleting a live process", async (t) => {
    const { server, rootDir } = taskManagementFixture(t);
    const script = writeAgentScript(rootDir, "generator.js", [
        'fs.appendFileSync("invocations.txt", "run\\n");',
        'fs.writeFileSync("generating.md", "# generated content");',
        "await sleep(500);",
        'console.log("generated");',
    ].join("\n"));
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "generator", command: script.command, args: script.args, timeoutSeconds: 2 },
    });
    const body = {
        title: "generating", directory: rootDir, targetFileName: "generating.md", sourceMode: "agent",
        requirement: "generate", decomposeProfileId: profile.profile.id,
    };
    const pending = request(server, "/api/tasks", { method: "POST", body });
    try {
        const running = await waitFor(async () => {
            const state = await request(server, "/api/state");
            return fs.existsSync(path.join(rootDir, "invocations.txt")) && state.tasks.find((task) => task.status === "running");
        });
        const repeated = await request(server, "/api/tasks", { method: "POST", body: { ...body, overwrite: true } });
        assert.equal(repeated.task.id, running.id);
        assert.equal(repeated.deduplicated, true);
        assert.equal((await server.inject({ method: "DELETE", path: `/api/tasks/${running.id}` })).statusCode, 409);
        await request(server, `/api/tasks/${running.id}/stop`, { method: "POST" });
        assert.equal((await request(server, "/api/state")).tasks[0].canDelete, false);
        assert.equal((await server.inject({ method: "DELETE", path: `/api/tasks/${running.id}` })).statusCode, 409);
    } finally {
        await pending;
    }
    assert.equal(fs.readFileSync(path.join(rootDir, "invocations.txt"), "utf8"), "run\n");
    assert.equal(fs.readFileSync(path.join(rootDir, "generating.md"), "utf8"), "# generated content");
    const state = await request(server, "/api/state");
    assert.equal(state.tasks[0].canDelete, true);
    await request(server, `/api/tasks/${state.tasks[0].id}`, { method: "DELETE" });
});

test("server cleans legacy duplicates, keeps active and historical tasks, and leaves archives and files intact", async (t) => {
    const { server, createTask, rootDir, dataDir, statePath } = taskManagementFixture(t);
    const history = await createTask("history.md");
    const busy = await createTask("busy.md");
    const oldest = await createTask("oldest.md");
    const unrelated = await createTask("unrelated.md", { title: history.title });
    const archivedSource = await createTask("archived.md");
    const { task: archived } = await request(server, `/api/tasks/${archivedSource.id}/archive`, { method: "POST" });
    const recreated = await createTask("archived.md");
    assert.notEqual(recreated.id, archived.id);

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const byId = (id) => saved.tasks.find((task) => task.id === id);
    Object.assign(byId(history.id), { status: "all_done", lastRunId: "run_history", createdAt: "2020-01-01T00:00:00.000Z" });
    Object.assign(byId(busy.id), { status: "running", createdAt: "2010-01-01T00:00:00.000Z" });
    Object.assign(byId(oldest.id), { createdAt: "2000-01-01T00:00:00.000Z" });
    const duplicateLog = path.join(dataDir, "logs", "legacy-duplicate.log");
    fs.writeFileSync(duplicateLog, "legacy execution log");
    saved.tasks.unshift(
        { ...history, id: "empty_older", createdAt: "1990-01-01T00:00:00.000Z", logFile: "legacy-duplicate.log" },
        { ...history, id: "empty_newer", createdAt: "2021-01-01T00:00:00.000Z" },
        { ...busy, id: "busy_queued", status: "queued", createdAt: "2021-01-01T00:00:00.000Z" },
        { ...busy, id: "busy_empty", createdAt: "1990-01-01T00:00:00.000Z" },
        { ...oldest, id: "newer_relative", filePath: "./oldest.md", createdAt: "2021-01-01T00:00:00.000Z" },
    );
    saved.events.push({ id: "legacy_event", taskId: "empty_older", type: "task", message: "removed task" });
    fs.writeFileSync(statePath, JSON.stringify(saved));
    const preservedPaths = [history.filePath, busy.filePath, oldest.filePath, unrelated.filePath, archived.filePath, recreated.filePath, duplicateLog];
    const contents = preservedPaths.map((filePath) => fs.readFileSync(filePath));

    const result = await request(server, "/api/tasks/deduplicate", { method: "POST" });
    assert.equal(result.deletedCount, 4);
    assert.deepEqual(result.deletedTaskIds.slice().sort(), ["busy_empty", "empty_newer", "empty_older", "newer_relative"]);
    assert.deepEqual(result.skippedTaskIds, ["busy_queued"]);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.duplicates.find((item) => item.taskId === "empty_older").keptTaskId, history.id);
    assert.equal(result.duplicates.find((item) => item.taskId === "newer_relative").keptTaskId, oldest.id);
    const current = await request(server, "/api/state");
    assert.equal(current.tasks.length, 7);
    assert.equal(current.tasks.find((task) => task.id === history.id).lastRunId, "run_history");
    assert.equal(current.tasks.find((task) => task.id === busy.id).status, "running");
    assert.equal(current.tasks.find((task) => task.id === "busy_queued").status, "queued");
    assert.equal(current.tasks.find((task) => task.id === archived.id).archived, true);
    assert.ok(current.tasks.some((task) => task.id === recreated.id));
    assert.equal(current.events.some((event) => result.deletedTaskIds.includes(event.taskId)), false);
    preservedPaths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), contents[index]));

    const beforeSecondPass = fs.readFileSync(statePath, "utf8");
    const again = await request(server, "/api/tasks/deduplicate", { method: "POST" });
    assert.equal(again.deletedCount, 0);
    assert.equal(again.skippedCount, 1);
    assert.equal(fs.readFileSync(statePath, "utf8"), beforeSecondPass);
    assert.equal(fs.readFileSync(path.join(rootDir, "history.md"), "utf8"), contents[0].toString());
});

test("server pages large logs with stable cursors and preserves complete history access", async (t) => {
    const { server, createTask, dataDir } = taskManagementFixture(t);
    const task = await createTask("large-log.md");
    const eventPath = path.join(dataDir, "logs", task.logEventsFile);
    const event = (sequence) => ({ sequence, id: `${task.id}:${sequence}`, taskId: task.id, runId: "history", type: "stdout", text: "输出 😀".repeat(100) });
    fs.writeFileSync(eventPath, Array.from({ length: 1000 }, (_, i) => JSON.stringify(event(i + 1))).join("\n") + "\n");
    const endpoint = `/api/tasks/${task.id}/log`;
    const latest = await request(server, `${endpoint}?limit=25`);
    assert.equal(latest.events.length, 25);
    assert.equal(latest.firstCursor, 976);
    assert.equal(latest.nextCursor, 1000);
    assert.equal(latest.oldestCursor, 1);
    assert.equal(latest.totalEvents, 1000);
    assert.equal(latest.contentIncluded, false);
    assert.equal(latest.content, "");
    assert.equal(latest.hasMoreBefore, true);
    assert.equal(latest.hasMoreAfter, false);
    const older = await request(server, `${endpoint}?before=976&limit=25`);
    assert.equal(older.firstCursor, 951);
    assert.equal(older.nextCursor, 975);
    const catchUp = await request(server, `${endpoint}?after=975&limit=10`);
    assert.equal(catchUp.firstCursor, 976);
    assert.equal(catchUp.nextCursor, 985);
    assert.equal(catchUp.hasMoreAfter, true);
    const unchanged = await request(server, `${endpoint}?after=1000&limit=25`);
    assert.deepEqual(unchanged.events, []);
    assert.equal(unchanged.nextCursor, 1000);

    fs.appendFileSync(eventPath, `${JSON.stringify(event(1001))}\n`);
    const appended = await request(server, `${endpoint}?after=1000&limit=25`);
    assert.deepEqual(appended.events, [event(1001)]);
    assert.equal(appended.totalEvents, 1001);
    const run = await request(server, `/api/tasks/${task.id}/logs/history?limit=10`);
    assert.equal(run.events.length, 10);
    assert.equal(run.nextCursor, 1001);
    assert.equal((await request(server, endpoint)).events.length, 1001);
    assert.equal((await request(server, `${endpoint}?full=1&limit=25`)).events.length, 1001);

    fs.writeFileSync(eventPath, `${JSON.stringify(event(1))}\n`);
    const replaced = await request(server, `${endpoint}?after=1001&limit=25`);
    assert.equal(replaced.latestCursor, 1);
    assert.equal(replaced.totalEvents, 1);
});

test("server provides compact conditional state and invalidates it after external and API changes", async (t) => {
    const { server, createTask, statePath } = taskManagementFixture(t);
    const task = await createTask("cached-state.md");
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    saved.pingRecords = [{ id: "ping_saved", date: "2026-09-13", inputText: "input", outputText: "output" }];
    fs.writeFileSync(statePath, JSON.stringify(saved));
    const first = await server.inject({ path: "/api/state?compact=1" });
    assert.equal(first.json().projectTaskTree, undefined);
    assert.equal(first.json().pingDays, undefined);
    assert.equal(first.json().pingRecords, undefined);
    assert.equal(first.json().pingRecordCount, 1);
    assert.ok(first.headers.etag);
    const same = await server.inject({ path: "/api/state?compact=1", headers: { "If-None-Match": first.headers.etag } });
    assert.equal(same.statusCode, 304);
    assert.equal(same.body, "");
    assert.equal((await request(server, "/api/state?compact=1&includePings=1")).pingRecords.length, 1);
    assert.equal((await request(server, "/api/state")).projectTaskTree.length, 1);

    saved.tasks[0].title = "external update";
    fs.writeFileSync(statePath, JSON.stringify(saved));
    const updated = await server.inject({ path: "/api/state?compact=1", headers: { "if-none-match": first.headers.etag } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().tasks[0].title, "external update");
    assert.notEqual(updated.headers.etag, first.headers.etag);
    await request(server, `/api/tasks/${task.id}`, { method: "DELETE" });
    const deleted = await server.inject({ path: "/api/state?compact=1", headers: { "if-none-match": updated.headers.etag } });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json().tasks, []);
});
