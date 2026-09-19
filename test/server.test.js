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
    ALL_DONE_MARKER,
    ALL_DONE_OUTPUT,
    DEFAULT_CODEX_ARGS,
    DEFAULT_RUN_PROMPT,
    LEGACY_CODEX_ARGS,
    LEGACY_RUN_PROMPT,
    LEGACY_RUN_PROMPT_V2,
    LEGACY_RUN_PROMPT_V3,
    createTerminalLogger,
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
        logLevel: "info",
    });
    assert.deepEqual(resolveServerConfig({ HOST: " 127.0.0.1 ", PORT: "3100", LOG_LEVEL: "DEBUG" }), {
        host: "127.0.0.1",
        port: 3100,
        logLevel: "debug",
    });
    assert.deepEqual(resolveServerConfig({ HOST: "", PORT: "0", LOG_LEVEL: "verbose" }), {
        host: DEFAULT_HOST,
        port: 0,
        logLevel: "info",
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
        "// 任务文件是唯一凭据：假 Agent 通过这两个助手把结束标志 / 本轮凭据写进任务文件。",
        "const taskFilePath = () => process.env.AGENT_TASK_FILE || \"\";",
        "const markTaskFileAllDone = () => { if (taskFilePath()) fs.appendFileSync(taskFilePath(), \"\\nGGGG全部完成GGGGGGGG全部完成GGGG\\n\", \"utf8\"); };",
        "const runTokenFromPrompt = () => (process.argv.slice(2).join(\" \").match(/任务\\+[0-9a-f-]{36}/) || [\"\"])[0];",
        "const writeRunToken = (note = \"done\") => { const token = runTokenFromPrompt(); if (token && taskFilePath()) fs.appendFileSync(taskFilePath(), `\\n${token}：${note}\\n`, \"utf8\"); return token; };",
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
    assert.equal(created.generation, undefined);
    assert.equal(created.task.status, "not_started");
    assert.equal(created.task.generationState, "pending");
    assert.ok(fs.existsSync(path.join(tempRoot, "测试任务.md")));
    assert.match(fs.readFileSync(path.join(tempRoot, "测试任务.md"), "utf8"), /尚未生成任务列表/);

    const generation = await request(server, `/api/tasks/${created.task.id}/generate`, { method: "POST" });
    assert.equal(generation.ok, true);
    assert.equal(generation.fileChanged, true);
    assert.equal(generation.task.status, "not_started");

    const publicTask = (await request(server, "/api/state")).tasks.find((item) => item.id === created.task.id);
    assert.equal(publicTask.runtimeState, RUNTIME_STATE.loopNotStarted);
    assert.equal(publicTask.activeProcess, null);
    assert.match(publicTask.lastPrompt, /详细方案/);
    assert.match(publicTask.lastPrompt, /开发步骤/);
    assert.match(publicTask.lastPrompt, /不得将新增任务标记为 FINISHED/);

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
        "  - 状态：FINISHED",
        "  - 完成标准：旧任务完成",
        "  - 详细方案：历史方案",
        "  - 开发步骤：",
        "    - [x] 1. 明确改动范围",
        "    - [x] 2. 完成实现",
        "    - [x] 3. 验证结果",
        "  - 执行记录：此前运行",
        "",
    ].join("\n");
    fs.writeFileSync(path.join(tempRoot, targetFileName), `${originalContent}\n${ALL_DONE_OUTPUT}\n`, "utf8");
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
    assert.equal(file.content.includes(ALL_DONE_OUTPUT), false);
    assert.match(file.content, /- \[ \] 2\. 追加的第一项/);
    assert.match(file.content, /- \[ \] 3\. 追加的第二项/);
    assert.match(file.content, /完成标准：通过追加测试/);
    assert.equal(file.content.match(/^  - 详细方案：/gm).length, 3);
    assert.equal(file.content.match(/^    - \[ \] /gm).length, 6);
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
        "$line = 'GGGG' + $marker + 'GGGG' + 'GGGG' + $marker + 'GGGG'",
        "[System.IO.File]::AppendAllText($env:AGENT_TASK_FILE, \"`n$line`n\", [System.Text.Encoding]::UTF8)",
        "Write-Output $line",
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
            pingEnabled: true,
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

test("server migrates all legacy default prompts and preserves custom prompts", async (t) => {
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
        }, {
            id: "profile_claude_previous",
            name: "previous-default",
            agentType: "claude",
            command: "claude",
            promptTemplate: LEGACY_RUN_PROMPT_V2,
        }, {
            id: "profile_claude_planned",
            name: "planned-default",
            agentType: "claude",
            command: "claude",
            promptTemplate: LEGACY_RUN_PROMPT_V3,
        }, {
            id: "profile_custom_prompt",
            name: "custom-prompt",
            agentType: "gemini",
            command: "gemini",
            promptTemplate: `${LEGACY_RUN_PROMPT_V2}\n保留用户的自定义规则。`,
        }, {
            id: "profile_custom_planned_prompt",
            name: "custom-planned-prompt",
            agentType: "codex",
            command: "codex",
            promptTemplate: `${LEGACY_RUN_PROMPT_V3}\n保留用户的自定义计划规则。`,
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
    assert.equal(state.profiles[1].promptTemplate, DEFAULT_RUN_PROMPT);
    assert.equal(state.profiles[2].promptTemplate, DEFAULT_RUN_PROMPT);
    assert.equal(state.profiles[3].promptTemplate, `${LEGACY_RUN_PROMPT_V2}\n保留用户的自定义规则。`);
    assert.equal(state.profiles[4].promptTemplate, `${LEGACY_RUN_PROMPT_V3}\n保留用户的自定义计划规则。`);
});

test("server creating an agent task does not spawn the generation profile", async (t) => {
    const { server, rootDir, statePath } = taskManagementFixture(t);
    const script = writeAgentScript(rootDir, "generator.js", [
        "fs.writeFileSync(\"generator-invoked.txt\", \"invoked\");",
        "fs.writeFileSync(\"agent-task.md\", \"# generated\\n\\n- [ ] 1. 生成的任务项\\n\");",
        "console.log(\"任务目标文件已生成\");",
    ].join("\n"));
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "generator", command: script.command, args: script.args, timeoutSeconds: 2 },
    });

    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "agent-task",
            directory: rootDir,
            targetFileName: "agent-task.md",
            requirementMode: "agent",
            requirement: "实现登录页面\n补充登录接口测试",
            decomposeProfileId: profile.profile.id,
        },
    });
    assert.equal(created.ok, true);
    assert.equal(created.generation, undefined);
    assert.equal(created.task.sourceMode, "agent");
    assert.equal(created.task.requirementMode, "agent");
    assert.equal(created.task.generationState, "pending");
    assert.equal(created.task.status, "not_started");
    assert.equal(created.task.decomposeProfileId, profile.profile.id);
    // 创建过程没有启动生成 Profile。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(path.join(rootDir, "generator-invoked.txt")), false);

    // 目标文件是占位内容：包含标题与原始需求、没有任务项与完成标记。
    const content = fs.readFileSync(path.join(rootDir, "agent-task.md"), "utf8");
    assert.match(content, /^# agent-task/);
    assert.match(content, /实现登录页面/);
    assert.match(content, /补充登录接口测试/);
    assert.match(content, /尚未生成任务列表/);
    assert.doesNotMatch(content, /- \[ \]/);
    assert.equal(content.includes("GGGG"), false);
    const file = await request(server, `/api/tasks/${created.task.id}/file`);
    assert.equal(file.content, content);

    // 占位哈希写入 loop.placeholderHash，且等于当前文件哈希；去掉显式字段后重新载入仍判定为 pending。
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const savedTask = saved.tasks.find((task) => task.id === created.task.id);
    assert.ok(savedTask.loop.placeholderHash);
    assert.equal(savedTask.loop.placeholderHash, savedTask.loop.lastHash);
    const fullState = await request(server, "/api/state");
    const publicTask = fullState.tasks.find((task) => task.id === created.task.id);
    assert.equal(publicTask.generationState, "pending");
    assert.equal(publicTask.loop.placeholderHash, savedTask.loop.placeholderHash);
    assert.ok(fullState.events.some((event) => event.taskId === created.task.id && /待生成目标文件/.test(event.message)));
    assert.equal(publicTask.logRuns.length, 0);

    // 运行界面触发生成后才调用 Profile。
    const generation = await request(server, `/api/tasks/${created.task.id}/generate`, { method: "POST" });
    assert.equal(generation.ok, true);
    assert.equal(generation.fileChanged, true);
    assert.equal(fs.readFileSync(path.join(rootDir, "generator-invoked.txt"), "utf8"), "invoked");
    assert.match(fs.readFileSync(path.join(rootDir, "agent-task.md"), "utf8"), /生成的任务项/);
});

test("server migrates legacy sourceMode into requirementMode", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const legacyTask = (id, sourceMode, extra = {}) => ({
        id,
        title: id,
        requirement: "旧任务",
        taskType: "text",
        sourceMode,
        targetFileName: `${id}.md`,
        filePath: path.join(tempRoot, `${id}.md`),
        directory: tempRoot,
        runProfileIds: [],
        status: "not_started",
        logFile: `${id}.log`,
        logRuns: [],
        loop: { stallCount: 0, lastOutput: "", lastHash: "" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...extra,
    });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 3,
        directories: [tempRoot],
        projects: [],
        profiles: [],
        tasks: [
            legacyTask("task_template", "template"),
            legacyTask("task_agent", "agent"),
            legacyTask("task_existing", "existing"),
            legacyTask("task_upload", "upload"),
            legacyTask("task_pending", "agent", { loop: { stallCount: 0, lastOutput: "", lastHash: "abc", placeholderHash: "abc" } }),
            legacyTask("task_explicit", "template", { requirementMode: "agent", generationState: "failed" }),
            legacyTask("task_invalid", "agent", { requirementMode: "bogus", generationState: "bogus" }),
        ],
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

    const state = await request(server, "/api/state");
    const byId = (id) => state.tasks.find((task) => task.id === id);
    // 旧 template 任务 → manual，且不需要生成。
    assert.equal(byId("task_template").sourceMode, "template");
    assert.equal(byId("task_template").requirementMode, "manual");
    assert.equal(byId("task_template").generationState, "none");
    // 旧 agent 任务创建时已同步生成过，迁移后视为 generated，不阻塞启动。
    assert.equal(byId("task_agent").requirementMode, "agent");
    assert.equal(byId("task_agent").generationState, "generated");
    // existing / upload 没有需求来源语义。
    assert.equal(byId("task_existing").requirementMode, "");
    assert.equal(byId("task_existing").generationState, "none");
    assert.equal(byId("task_upload").requirementMode, "");
    assert.equal(byId("task_upload").generationState, "none");
    // 记录了占位哈希但缺少 generationState 的 agent 任务视为 pending。
    assert.equal(byId("task_pending").generationState, "pending");
    // 显式字段优先于 sourceMode 推导。
    assert.equal(byId("task_explicit").requirementMode, "agent");
    assert.equal(byId("task_explicit").generationState, "failed");
    // 非法值回退到推导结果。
    assert.equal(byId("task_invalid").requirementMode, "agent");
    assert.equal(byId("task_invalid").generationState, "generated");

    // requirementMode 可以在创建请求中直接指定，并映射到既有的 sourceMode。
    const manual = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "手动任务",
            requirement: "第一项\n第二项",
            targetFileName: "manual.md",
            directory: tempRoot,
            requirementMode: "manual",
        },
    });
    assert.equal(manual.task.sourceMode, "template");
    assert.equal(manual.task.requirementMode, "manual");
    assert.equal(manual.task.generationState, "none");
    assert.match(fs.readFileSync(path.join(tempRoot, "manual.md"), "utf8"), /第一项/);
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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

test("server checks task-file completion after each agent command", async (t) => {
    const cases = [
        { name: "Claude writes the marker but only reports task progress", agentType: "claude", marker: ALL_DONE_OUTPUT, output: "任务完成", allDone: true },
        { name: "Codex writes the marker without output", agentType: "codex", marker: ALL_DONE_OUTPUT, allDone: true },
        { name: "file completion takes priority over a 429 error", agentType: "codex", marker: ALL_DONE_OUTPUT, output: "429 rate limit", exitCode: 1, allDone: true },
        { name: "an unchanged completed file stops a failed command", agentType: "claude", marker: ALL_DONE_OUTPUT, preexisting: true, exitCode: 2, allDone: true },
        { name: "a single marker is incomplete", agentType: "claude", marker: ALL_DONE_MARKER },
        { name: "a newline between markers is incomplete", agentType: "codex", marker: `${ALL_DONE_MARKER}\r\n${ALL_DONE_MARKER}` },
        { name: "a space between markers is incomplete", agentType: "claude", marker: `${ALL_DONE_MARKER} ${ALL_DONE_MARKER}` },
        { name: "a missing task file does not interrupt retry handling", agentType: "codex", removeFile: true },
        { name: "a directory cannot be read as a task file", agentType: "claude", removeFile: true, directoryInstead: true },
        { name: "media tasks still need an artifact", agentType: "codex", marker: ALL_DONE_OUTPUT, taskType: "image" },
    ];
    for (const scenario of cases) {
        await t.test(scenario.name, async (t) => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-marker-"));
            const server = createApp({
                rootDir: tempRoot,
                dataDir: path.join(tempRoot, "data"),
                publicDir: path.join(__dirname, "..", "public"),
                disablePingScheduler: true,
            });
            t.after(() => {
                server.closeRunners();
                fs.rmSync(tempRoot, { recursive: true, force: true });
            });
            const targetFileName = "marker-task.md";
            const completedContent = `# 任务\n\n- [x] 1. 已验证\n  - 状态：FINISHED\n\n${scenario.marker || ""}\n`;
            const script = writeAgentScript(tempRoot, "agent-file-marker.js", [
                "fs.appendFileSync(\"invocations.txt\", \"run\\n\", \"utf8\");",
                scenario.removeFile
                    ? `fs.unlinkSync(${JSON.stringify(targetFileName)});`
                    : scenario.preexisting
                        ? ""
                        : `fs.writeFileSync(${JSON.stringify(targetFileName)}, ${JSON.stringify(completedContent)}, "utf8");`,
                scenario.directoryInstead ? `fs.mkdirSync(${JSON.stringify(targetFileName)});` : "",
                scenario.output ? `console.log(${JSON.stringify(scenario.output)});` : "",
                `process.exitCode = ${scenario.exitCode || 0};`,
            ].join("\n"));
            const taskType = scenario.taskType || "text";
            const profile = await request(server, "/api/profiles", {
                method: "POST",
                body: {
                    name: "file-marker-agent",
                    agentType: scenario.agentType,
                    command: script.command,
                    args: script.args,
                    outputModalities: [taskType],
                    enabled: true,
                },
            });
            const created = await request(server, "/api/tasks", {
                method: "POST",
                body: {
                    title: scenario.name,
                    targetFileName,
                    directory: tempRoot,
                    sourceMode: "template",
                    taskType,
                    runProfileIds: [profile.profile.id],
                },
            });
            if (scenario.preexisting) fs.writeFileSync(created.task.filePath, completedContent, "utf8");
            const started = await request(server, `/api/tasks/${created.task.id}/start`, {
                method: "POST",
                body: { profileIds: [profile.profile.id] },
            });
            const expectedStatus = scenario.allDone ? "all_done" : "retry_wait";
            const task = await waitFor(async () => {
                const state = await request(server, "/api/state");
                return state.tasks.find((item) => item.id === created.task.id && item.status === expectedStatus);
            });
            assert.equal(task.lastExitCode, scenario.exitCode || 0);
            assert.equal(task.lastOutput.includes(ALL_DONE_OUTPUT), false);
            assert.equal(fs.readFileSync(path.join(tempRoot, "invocations.txt"), "utf8"), "run\n");
            const log = await request(server, `/api/tasks/${created.task.id}/log`);
            const completionEvents = log.events.filter((event) => event.type === "task_all_done");
            if (scenario.allDone) {
                assert.equal(task.nextRunAt, null);
                assert.equal(task.retryCount, 0);
                assert.equal(task.runtimeState, RUNTIME_STATE.loopNotStarted);
                assert.equal(task.activeProcess, null);
                assert.equal(completionEvents.length, 1);
                assert.equal(completionEvents[0].metadata.completionSource, "task_file");
                assert.equal(log.events.some((event) => ["retry_wait", "task_completed"].includes(event.type)), false);
                const runLog = await request(server, `/api/tasks/${created.task.id}/logs/${started.runId}`);
                assert.equal(runLog.run.status, "all_done");
                assert.ok(runLog.run.endedAt);
            } else {
                assert.equal(completionEvents.length, 0);
                assert.ok(task.nextRunAt);
                assert.equal(task.artifactCount, 0);
            }
        });
    }
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
    const script = writeAgentScript(tempRoot, "agent-once.sh", "writeRunToken(\"first cycle\"); console.log(\"任务完成\");");

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
    assert.match(waitingTask.lastPrompt, /idle-task\.md/);
    assert.match(waitingTask.lastPrompt, /详细方案/);
    assert.match(waitingTask.lastPrompt, /开发步骤/);
    assert.match(waitingTask.lastPrompt, /FINISHED/);
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        loopTiming: { minRunIntervalMs: 20 },
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        loopTiming: { minRunIntervalMs: 20 },
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
        "    markTaskFileAllDone(); process.stdout.write(\"\\nGGGG全部完成GGGGGGGG全部完成GGGG\\n\");",
        "} else {",
        "    const current = fs.readFileSync(targetPath, \"utf8\");",
        "    const completed = current.replaceAll(\"- [ ]\", \"- [x]\").replace(\"状态：未开始\", \"状态：FINISHED\");",
        "    fs.writeFileSync(targetPath, completed, \"utf8\");",
        "    console.log(\"第二轮完成 ✓\");",
        "    markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
        "}",
    ].join("\n"));

    let server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        loopTiming: { minRunIntervalMs: 20 },
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
        loopTiming: { minRunIntervalMs: 20 },
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
    assert.equal((afterAppend.content.match(/^- \[ \]/gm) || []).length, 1);
    assert.equal((afterAppend.content.match(/^    - \[ \]/gm) || []).length, 3);
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
        loopTiming: { minRunIntervalMs: 20 },
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
    assert.equal((finalFile.content.match(/^- \[x\]/gm) || []).length, 2);
    assert.equal((finalFile.content.match(/^    - \[x\]/gm) || []).length, 3);
    assert.doesNotMatch(finalFile.content, /- \[ \]/);
    assert.match(finalFile.content, /状态：FINISHED/);
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
    const nextScript = writeAgentScript(tempRoot, "agent-next.sh", "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");");

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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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

    // 旧版状态没有自动 Ping 名单：按 Profile 的 pingEnabled 迁移，且只纳入 Claude / Codex 类型。
    const migrated = await request(server, "/api/state");
    assert.deepEqual(migrated.pingSettings.profileIds, ["profile_claude_ping", "profile_codex_ping"]);
    assert.equal(migrated.profiles.find((profile) => profile.id === "profile_gemini_ping").pingEnabled, false);
    assert.equal(migrated.profiles.find((profile) => profile.id === "profile_gemini_ping").pingEligible, false);
    assert.equal(migrated.profiles.find((profile) => profile.id === "profile_claude_ping").pingEligible, true);

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

test("server only auto-pings the Profiles listed in pingSettings.profileIds", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-ping-list.sh", "console.log(\"pong\");");
    const makeProfile = (id, agentType) => ({
        id,
        name: id,
        agentType,
        command: script.command,
        args: script.args,
        envText: "",
        promptTemplate: DEFAULT_RUN_PROMPT,
        timeoutSeconds: 1,
        enabled: true,
        nonInteractive: true,
        defaultDirectory: tempRoot,
        configDirectory: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    fs.mkdirSync(tempData, { recursive: true });
    fs.writeFileSync(path.join(tempData, "state.json"), JSON.stringify({
        version: 3,
        directories: [tempRoot],
        profiles: [
            makeProfile("profile_ping_a", "claude"),
            makeProfile("profile_ping_b", "codex"),
            makeProfile("profile_ping_gemini", "gemini"),
        ],
        tasks: [],
        events: [],
        pingRecords: [],
        pingSettings: { enabled: true, profileIds: ["profile_ping_b", "profile_missing", "profile_ping_gemini"] },
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

    // 名单是唯一真相：未列出的 Profile 不自动 Ping；不存在的 ID 被清理；名单派生出 Profile 的 pingEnabled。
    const initial = await request(server, "/api/state");
    assert.deepEqual(initial.pingSettings.profileIds, ["profile_ping_b", "profile_ping_gemini"]);
    assert.equal(initial.profiles.find((profile) => profile.id === "profile_ping_a").pingEnabled, false);
    assert.equal(initial.profiles.find((profile) => profile.id === "profile_ping_b").pingEnabled, true);

    const firstRound = await request(server, "/api/pings/run", { method: "POST" });
    assert.deepEqual(firstRound.records.map((record) => record.profileId), ["profile_ping_b"]);

    // 通过设置接口改名单：只保留已登记的 Profile ID，顺序按提交顺序。
    const updated = await request(server, "/api/pings/settings", {
        method: "POST",
        body: { profileIds: ["profile_ping_a", "profile_unknown"] },
    });
    assert.deepEqual(updated.pingSettings.profileIds, ["profile_ping_a"]);
    assert.equal(updated.pingSettings.enabled, true);
    const secondRound = await request(server, "/api/pings/run", { method: "POST" });
    assert.deepEqual(secondRound.records.map((record) => record.profileId), ["profile_ping_a"]);

    await assert.rejects(
        request(server, "/api/pings/settings", { method: "POST", body: { profileIds: "profile_ping_a" } }),
        /profileIds/,
    );

    // 新建 Profile 默认不加入名单；编辑时勾选 pingEnabled 会加入，取消勾选会移除。
    const created = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "ping-new", agentType: "codex", command: script.command, args: script.args, timeoutSeconds: 1 },
    });
    assert.equal(created.profile.pingEnabled, false);
    let state = await request(server, "/api/state");
    assert.deepEqual(state.pingSettings.profileIds, ["profile_ping_a"]);

    await request(server, "/api/profiles", { method: "POST", body: { id: created.profile.id, pingEnabled: true } });
    state = await request(server, "/api/state");
    assert.deepEqual(state.pingSettings.profileIds, ["profile_ping_a", created.profile.id]);
    // 未传 pingEnabled 的编辑保留原有名单状态。
    await request(server, "/api/profiles", { method: "POST", body: { id: created.profile.id, name: "ping-new-renamed" } });
    state = await request(server, "/api/state");
    assert.deepEqual(state.pingSettings.profileIds, ["profile_ping_a", created.profile.id]);

    await request(server, "/api/profiles", { method: "POST", body: { id: "profile_ping_a", pingEnabled: false } });
    state = await request(server, "/api/state");
    assert.deepEqual(state.pingSettings.profileIds, [created.profile.id]);
    assert.equal(state.profiles.find((profile) => profile.id === "profile_ping_a").pingEnabled, false);

    // 删除 Profile 时同步移出名单；手动测试连接不受名单限制。
    await request(server, `/api/profiles/${created.profile.id}`, { method: "DELETE" });
    state = await request(server, "/api/state");
    assert.deepEqual(state.pingSettings.profileIds, []);
    const manual = await request(server, "/api/profiles/profile_ping_a/ping", { method: "POST" });
    assert.equal(manual.record.success, true);
    const emptyRound = await request(server, "/api/pings/run", { method: "POST" });
    assert.equal(emptyRound.records.length, 0);
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
        referenceFiles: path.join("assets", "reference.png"),
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
        "markTaskFileAllDone(); console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
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
    const created = await request(server, "/api/tasks", { method: "POST", body });
    assert.equal(fs.existsSync(path.join(rootDir, "invocations.txt")), false);
    const pending = request(server, `/api/tasks/${created.task.id}/generate`, { method: "POST" });
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

test("server prints detailed terminal logs for requests, tasks, agents and shutdown", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const lines = [];
    const logger = createTerminalLogger({ level: "debug", writer: (line, entry) => lines.push({ line, entry }) });
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        logger,
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const scopes = () => lines.map((item) => item.entry.scope);
    const joined = () => lines.map((item) => item.line).join("\n");

    assert.ok(lines.some((item) => item.entry.scope === "server" && item.entry.message === "服务初始化" && item.entry.fields.dataDir === tempData));

    await request(server, "/api/state");
    const getLog = lines.find((item) => item.entry.scope === "server:http" && item.entry.message === "GET /api/state");
    assert.ok(getLog, "GET requests are logged at debug level");
    assert.equal(getLog.entry.level, "debug");
    assert.equal(getLog.entry.fields.status, 200);
    assert.equal(typeof getLog.entry.fields.durationMs, "number");

    const missing = await server.inject({ method: "GET", path: "/api/tasks/nope/logs" });
    assert.ok(missing.statusCode >= 400);
    assert.ok(lines.some((item) => item.entry.scope === "server:http" && item.entry.level === "warn" && item.entry.fields.status === missing.statusCode));

    const agent = writeAgentScript(tempRoot, "agent-terminal-log.sh", [
        "console.log(\"hello from agent\");",
        "console.error(\"agent warning\");",
    ].join("\n"));
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "terminal-log", agentType: "claude", command: agent.command, args: agent.args, timeoutSeconds: 5, enabled: true },
    });
    assert.ok(lines.some((item) => item.entry.scope === "server:http" && item.entry.level === "info" && item.entry.message === "POST /api/profiles"));
    assert.ok(lines.some((item) => item.entry.scope === "server:state" && item.entry.message === "state.json 已写入" && item.entry.fields.profiles >= 1));

    fs.writeFileSync(path.join(tempRoot, "terminal-log.md"), "- [ ] 任务\n", "utf8");
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: { title: "终端日志任务", directory: tempRoot, targetFileName: "terminal-log.md", sourceMode: "existing", runProfileIds: [profile.profile.id] },
    });
    const task = created.task;
    await request(server, `/api/tasks/${task.id}/start`, { method: "POST", body: { profileIds: [profile.profile.id] } });
    await waitFor(() => lines.some((item) => item.entry.scope === "server:agent" && item.entry.fields.type === "process_exit"), { timeoutMs: 10000 });

    assert.ok(lines.some((item) => item.entry.scope === "server:task" && item.entry.fields.taskId === task.id), "task events reach the terminal");
    assert.ok(lines.some((item) => item.entry.scope === "server:agent" && item.entry.fields.type === "process_started" && item.entry.fields.taskId === task.id));
    assert.ok(lines.some((item) => item.entry.scope === "server:agent" && item.entry.fields.stream === "stdout" && item.entry.message.includes("hello from agent")));
    assert.ok(lines.some((item) => item.entry.scope === "server:agent" && item.entry.fields.stream === "stderr" && item.entry.message.includes("agent warning")));
    assert.match(joined(), /\[server:agent\] .*exitCode=\d+/);

    server.closeRunners();
    assert.ok(lines.some((item) => item.entry.scope === "server" && item.entry.message.startsWith("正在关闭")));
    assert.ok(scopes().every((scope) => scope.startsWith("server")));

    // 默认级别（info）下 stdout/stderr 与 GET 轮询不再打印，但任务事件仍然可见。
    const infoLines = [];
    const quietServer = createApp({
        rootDir: tempRoot,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-")),
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        logger: createTerminalLogger({ level: "info", writer: (line, entry) => infoLines.push(entry) }),
    });
    t.after(() => quietServer.closeRunners());
    await request(quietServer, "/api/state");
    assert.equal(infoLines.filter((entry) => entry.scope === "server:http").length, 0);
    assert.ok(infoLines.some((entry) => entry.scope === "server" && entry.message === "服务初始化"));
});

test("server streams Claude stream-json events as readable log lines during a task run", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    // 命令名叫 claude 才会触发 stream-json 注入；PATH 中的 claude 垫片把参数转交给 node 执行脚本。
    const fakeClaude = path.join(tempRoot, "claude.js");
    fs.writeFileSync(fakeClaude, [
        "const fs = require(\"node:fs\");",
        "const args = process.argv.slice(2);",
        "const formatIndex = args.indexOf(\"--output-format\");",
        "if (args[formatIndex + 1] !== \"stream-json\" || !args.includes(\"--verbose\")) {",
        "    console.error(\"missing stream-json flags: \" + args.join(\" \"));",
        "    process.exit(2);",
        "}",
        "const prompt = args[args.indexOf(\"-p\") + 1] || \"\";",
        "const token = (prompt.match(/任务\\+[0-9a-f-]{36}/) || [\"\"])[0];",
        "const emit = (record) => process.stdout.write(JSON.stringify(record) + \"\\n\");",
        "emit({ type: \"system\", subtype: \"init\", model: \"claude-test\", session_id: \"sess-1\", tools: [\"Bash\"] });",
        "emit({ type: \"assistant\", message: { role: \"assistant\", content: [{ type: \"text\", text: \"读取任务文件\" }, { type: \"tool_use\", name: \"Read\", input: { file_path: process.env.AGENT_TASK_FILE } }] } });",
        "emit({ type: \"user\", message: { role: \"user\", content: [{ type: \"tool_result\", content: \"file ok\" }] } });",
        "fs.appendFileSync(process.env.AGENT_TASK_FILE, `\\n${token}：第一轮已完成\\n`, \"utf8\");",
        "emit({ type: \"result\", subtype: \"success\", num_turns: 2, duration_ms: 42, total_cost_usd: 0.01, usage: { input_tokens: 12, output_tokens: 5 }, result: \"本轮结束\" });",
    ].join("\n"), "utf8");
    // 垫片必须用完整路径：Windows 解析器会优先在 node 所在目录寻找同名命令，那里可能装着真实的 claude。
    const shimPath = path.join(tempRoot, process.platform === "win32" ? "claude.ps1" : "claude");
    fs.writeFileSync(shimPath, process.platform === "win32"
        ? `& ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} @args\r\nexit $LASTEXITCODE\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, "utf8");
    if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
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
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: {
            name: "claude-stream",
            agentType: "claude",
            command: shimPath,
            args: "--dangerously-skip-permissions -p {prompt}",
            enabled: true,
        },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "stream-json 日志",
            requirement: "实时查看 Claude 事件流",
            targetFileName: "stream-task.md",
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const task = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "completed");
    }, { timeoutMs: 5000 });
    assert.match(task.lastCommand, /--verbose --output-format stream-json/);
    assert.match(task.lastRunToken, /^任务\+/);
    assert.match(task.lastOutput, /\[system\] init model=claude-test/);
    assert.match(task.lastOutput, /\[tool_use\] Read/);
    assert.match(task.lastOutput, /\[result\] success turns=2 .*tokens=in:12 out:5\n本轮结束/);
    assert.doesNotMatch(task.lastOutput, /"type":"assistant"/, "raw JSON must not leak into the readable output");
    assert.ok(new Date(task.nextRunAt).getTime() - Date.now() > 100000, "the next cycle waits at least two minutes");

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    const stdout = log.events.filter((event) => event.type === "stdout").map((event) => event.text).join("\n");
    assert.match(stdout, /读取任务文件/);
    assert.match(stdout, /\[tool_result\] file ok/);
    assert.ok(log.events.some((event) => event.type === "run_token" && event.metadata.runToken === task.lastRunToken));
    const completed = log.events.find((event) => event.type === "task_completed");
    assert.equal(completed.metadata.runToken, task.lastRunToken);
    assert.equal(completed.metadata.delayMs, 120000);

    // 每轮统计：从 stream-json 的 result 事件取 usage，按 Fable 5.1 费率估算费用。
    assert.equal(task.stats.cycles, 1);
    assert.equal(task.stats.successes, 1);
    assert.equal(task.stats.inputTokens, 12);
    assert.equal(task.stats.outputTokens, 5);
    assert.equal(task.stats.costUsd, (12 * 10 + 5 * 50) / 1e6);
    assert.equal(task.stats.pricing.model, "claude-fable-5-1");
    assert.equal(task.cycles.length, 1);
    assert.equal(task.cycles[0].success, true);
    assert.equal(task.cycles[0].reason, "run_token_written");
    assert.equal(task.cycles[0].reportedCostUsd, 0.01);
    assert.ok(task.cycles[0].startedAt && task.cycles[0].endedAt);
    const cycleEvent = log.events.find((event) => event.type === "cycle_stats");
    assert.equal(cycleEvent.metadata.cycle, 1);
    assert.equal(cycleEvent.metadata.success, true);
    assert.equal(cycleEvent.metadata.inputTokens, 12);
});

test("server treats a task file without the run token as a failed cycle and backs off exponentially", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const counterPath = path.join(tempRoot, "cycles.txt");
    // 假 Agent 声称“任务完成”并改动任务文件，但从不写入本轮凭据：以前会被当成成功而每 10 秒重跑。
    const script = writeAgentScript(tempRoot, "agent-no-token.js", [
        `const count = fs.existsSync(${JSON.stringify(counterPath)}) ? Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8")) + 1 : 1;`,
        `fs.writeFileSync(${JSON.stringify(counterPath)}, String(count), "utf8");`,
        "fs.appendFileSync(taskFilePath(), `\\n第 ${count} 轮改动\\n`, \"utf8\");",
        "console.log(\"任务完成\");",
        "console.log(\"GGGG全部完成GGGGGGGG全部完成GGGG\");",
    ].join("\n"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        loopTiming: { minRunIntervalMs: 30, failureBackoffBaseMs: 30, failureBackoffMaxMs: 100, maxConsecutiveFailures: 3 },
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "no-token-agent", agentType: "codex", command: script.command, args: script.args, enabled: true },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "缺少凭据",
            requirement: "输出不算数",
            targetFileName: "no-token-task.md",
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const stopped = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "stopped");
    }, { timeoutMs: 6000 });
    assert.equal(fs.readFileSync(counterPath, "utf8"), "3", "the loop stops after the configured number of failed cycles");
    assert.equal(stopped.nextRunAt, null);

    const log = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.equal(log.events.some((event) => ["task_completed", "task_all_done"].includes(event.type)), false, "printed markers never count as success");
    const retries = log.events.filter((event) => event.type === "retry_wait");
    assert.deepEqual(retries.map((event) => event.metadata.reason), ["run_token_missing", "run_token_missing"]);
    assert.deepEqual(retries.map((event) => event.metadata.delayMs), [30, 60], "each failure doubles the wait");
    assert.deepEqual(retries.map((event) => event.metadata.failureStreak), [1, 2]);
    const stopEvent = log.events.find((event) => event.type === "task_stopped");
    assert.equal(stopEvent.metadata.reason, "stalled");
    assert.equal(stopEvent.metadata.failureStreak, 3);
    assert.equal(stopEvent.metadata.failureReason, "run_token_missing");
    // 三轮都失败：非结构化输出解析不到 usage，费用记 0，平均间隔按相邻启动时刻计算。
    assert.equal(stopped.stats.cycles, 3);
    assert.equal(stopped.stats.successes, 0);
    assert.equal(stopped.stats.failures, 3);
    assert.equal(stopped.stats.costUsd, 0);
    assert.ok(stopped.stats.averageIntervalMs >= 0);
    assert.deepEqual(stopped.cycles.map((cycle) => cycle.reason), ["run_token_missing", "run_token_missing", "run_token_missing"]);
    assert.ok(stopped.cycles.every((cycle) => cycle.usageFound === false));
});

test("server reports an unchanged task file as the failure reason and rate-limits manual restarts", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const script = writeAgentScript(tempRoot, "agent-untouched.js", [
        "console.error(\"ERROR: currently experiencing high demand\");",
        "process.exit(1);",
    ].join("\n"));
    const server = createApp({
        rootDir: tempRoot,
        dataDir: tempData,
        publicDir: path.join(__dirname, "..", "public"),
        disablePingScheduler: true,
        loopTiming: { minRunIntervalMs: 400, failureBackoffBaseMs: 400, failureBackoffMaxMs: 400, maxConsecutiveFailures: 2 },
    });
    t.after(() => {
        server.closeRunners();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(tempData, { recursive: true, force: true });
    });
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "untouched-agent", agentType: "codex", command: script.command, args: script.args, enabled: true },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "文件未变",
            requirement: "限流",
            targetFileName: "untouched-task.md",
            directory: tempRoot,
            sourceMode: "template",
            runProfileIds: [profile.profile.id],
        },
    });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const waiting = await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "retry_wait");
    });
    assert.ok(new Date(waiting.nextRunAt).getTime() - Date.now() > 150, "the first failure already waits the minimum interval");
    const firstLog = await request(server, `/api/tasks/${created.task.id}/log`);
    assert.equal(firstLog.events.find((event) => event.type === "retry_wait").metadata.reason, "task_file_unchanged");

    // 用户手动停止后立刻重启：距上次 Agent 结束不足最小间隔，必须先等待而不是立即再发请求。
    await request(server, `/api/tasks/${created.task.id}/stop`, { method: "POST" });
    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === created.task.id && item.status === "stopped");
    });
    await request(server, `/api/tasks/${created.task.id}/start`, {
        method: "POST",
        body: { profileIds: [profile.profile.id] },
    });
    const throttled = await waitFor(async () => {
        const log = await request(server, `/api/tasks/${created.task.id}/log`);
        return log.events.find((event) => event.type === "rate_limit_wait") || null;
    });
    assert.ok(throttled.metadata.delayMs > 0 && throttled.metadata.delayMs <= 400);
    assert.equal(throttled.metadata.minRunIntervalMs, 400);
    const stateAfter = await request(server, "/api/state");
    const throttledTask = stateAfter.tasks.find((item) => item.id === created.task.id);
    assert.equal(throttledTask.status, "running");
    assert.equal(throttledTask.runtimeState, RUNTIME_STATE.idleWaiting);
});

test("server updates task metadata in place and rejects busy, archived, or cross-directory edits", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-root-"));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-data-"));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-other-"));
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
        fs.rmSync(otherRoot, { recursive: true, force: true });
    });
    await request(server, "/api/directories", { method: "POST", body: { directory: otherRoot } });
    const script = writeAgentScript(tempRoot, "agent-edit.js", "await sleep(1500); markTaskFileAllDone();");
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "edit-agent", agentType: "codex", command: script.command, args: script.args, enabled: true },
    });
    const secondProfile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "edit-agent-2", agentType: "claude", command: script.command, args: script.args, enabled: true },
    });
    const otherProject = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "其他目录项目", directory: otherRoot },
    });
    const unboundProject = await request(server, "/api/projects", {
        method: "POST",
        body: { name: "不绑定目录" },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "原标题",
            requirement: "原需求",
            targetFileName: "edit-task.md",
            directory: tempRoot,
            sourceMode: "agent",
            decomposeProfileId: profile.profile.id,
            runProfileIds: [profile.profile.id],
        },
    });
    const taskId = created.task.id;
    const placeholder = fs.readFileSync(created.task.filePath, "utf8");
    assert.match(placeholder, /原标题/);

    // 空请求：无改动，不产生事件。
    const noop = await request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: {} });
    assert.deepEqual(noop.changed, []);

    const updated = await request(server, `/api/tasks/${taskId}`, {
        method: "PATCH",
        body: {
            title: "新标题",
            requirement: "新需求",
            runProfileIds: [secondProfile.profile.id, profile.profile.id],
            projectId: unboundProject.project.id,
            targetFileName: "should-be-ignored.md",
            directory: otherRoot,
        },
    });
    assert.deepEqual(updated.changed, ["title", "requirement", "projectId", "runProfileIds"]);
    assert.equal(updated.task.title, "新标题");
    assert.equal(updated.task.requirement, "新需求");
    assert.equal(updated.task.targetFileName, "edit-task.md", "the target file is locked after creation");
    assert.equal(updated.task.directory, tempRoot, "the working directory is locked after creation");
    assert.equal(updated.task.projectId, unboundProject.project.id);
    assert.deepEqual(updated.task.runProfileIds, [secondProfile.profile.id, profile.profile.id]);
    assert.equal(updated.task.runProfileId, secondProfile.profile.id);
    assert.equal(updated.placeholderRewritten, true, "an untouched placeholder file follows the new title");
    const rewritten = fs.readFileSync(created.task.filePath, "utf8");
    assert.match(rewritten, /新标题/);
    assert.match(rewritten, /新需求/);
    assert.doesNotMatch(rewritten, /原标题/);

    const log = await request(server, `/api/tasks/${taskId}/log`);
    const updateEvent = log.events.find((event) => event.type === "task_updated");
    assert.deepEqual(updateEvent.metadata.changed, ["title", "requirement", "projectId", "runProfileIds"]);

    // 用户手动编辑过目标文件后，再改标题不能覆盖文件。
    fs.writeFileSync(created.task.filePath, "# 手工内容\n", "utf8");
    const afterManual = await request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { title: "第三个标题" } });
    assert.equal(afterManual.placeholderRewritten, false);
    assert.equal(fs.readFileSync(created.task.filePath, "utf8"), "# 手工内容\n");

    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { title: "   " } }), /标题不能为空/);
    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { projectId: otherProject.project.id } }), /其他工作目录/);
    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { projectId: "missing" } }), /有效项目/);
    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { runProfileIds: ["missing-profile"] } }), /执行 Profile/);
    await assert.rejects(request(server, `/api/tasks/missing`, { method: "PATCH", body: { title: "x" } }), /任务不存在/);

    // 运行中的任务拒绝编辑。
    await request(server, `/api/tasks/${taskId}/start`, { method: "POST", body: { profileIds: [profile.profile.id] } });
    await waitFor(async () => {
        const state = await request(server, "/api/state");
        return state.tasks.find((item) => item.id === taskId && item.status === "running");
    });
    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { title: "运行中改名" } }), /正在运行/);
    await request(server, `/api/tasks/${taskId}/stop`, { method: "POST" });
    await waitFor(async () => {
        const state = await request(server, "/api/state");
        const task = state.tasks.find((item) => item.id === taskId);
        return task && !task.isRunning && task.status === "stopped" ? task : null;
    }, { timeoutMs: 5000 });

    // 归档后只读。
    await request(server, `/api/tasks/${taskId}/archive`, { method: "POST" });
    await assert.rejects(request(server, `/api/tasks/${taskId}`, { method: "PATCH", body: { title: "归档改名" } }), /只读/);
    const finalState = await request(server, "/api/state");
    assert.equal(finalState.tasks.find((item) => item.id === taskId).title, "第三个标题");
});

test("server updates media task settings within the working directory", async (t) => {
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
    const script = writeAgentScript(tempRoot, "agent-media-edit.js", "console.log('noop');");
    const profile = await request(server, "/api/profiles", {
        method: "POST",
        body: { name: "video-agent", agentType: "custom", command: script.command, args: script.args, outputModalities: ["video"], enabled: true },
    });
    const created = await request(server, "/api/tasks", {
        method: "POST",
        body: {
            title: "视频任务",
            requirement: "生成视频",
            targetFileName: "video-task.md",
            directory: tempRoot,
            sourceMode: "template",
            taskType: "video",
            runProfileIds: [profile.profile.id],
        },
    });
    const updated = await request(server, `/api/tasks/${created.task.id}`, {
        method: "PATCH",
        body: {
            artifactDirectoryName: "renders/final",
            outputFileName: "clip",
            outputFormat: "webm",
            aspectRatio: "16:9",
            resolution: "1920x1080",
            durationSeconds: "12",
            referenceFiles: "assets/a.png\nassets/a.png\n\nassets/b.png",
        },
    });
    assert.deepEqual(updated.changed, ["artifactDirectoryName", "output", "aspectRatio", "resolution", "durationSeconds", "referenceFiles"]);
    assert.equal(updated.task.artifactDirectoryName, path.join("renders", "final"));
    assert.equal(updated.task.artifactDirectory, path.join(tempRoot, "renders", "final"));
    assert.equal(updated.task.outputFileName, "clip.webm");
    assert.equal(updated.task.outputFormat, "webm");
    assert.equal(updated.task.aspectRatio, "16:9");
    assert.equal(updated.task.resolution, "1920x1080");
    assert.equal(updated.task.durationSeconds, 12);
    assert.deepEqual(updated.task.referenceFiles, [path.join("assets", "a.png"), path.join("assets", "b.png")]);
    await assert.rejects(request(server, `/api/tasks/${created.task.id}`, { method: "PATCH", body: { artifactDirectoryName: "../outside" } }), /工作目录内/);
    await assert.rejects(request(server, `/api/tasks/${created.task.id}`, { method: "PATCH", body: { referenceFiles: "../secret.png" } }), /工作目录内/);
});
