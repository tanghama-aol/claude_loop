const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("runtime log renderer escapes agent-controlled text before inserting HTML", () => {
    const start = appSource.indexOf("function escapeHtml");
    const end = appSource.indexOf("\nfunction formatTime", start);
    assert.ok(start >= 0 && end > start, "escapeHtml helper must remain a standalone function");

    const context = {};
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.escapeHtml = escapeHtml;`, context);
    assert.equal(
        context.escapeHtml("<script>alert('x')</script> & \"quoted\" 'single'"),
        "&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt; &amp; &quot;quoted&quot; &#039;single&#039;",
    );

    const renderStart = appSource.indexOf("function renderLogEventText");
    const renderEnd = appSource.indexOf("\nfunction renderLogEventExtras", renderStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart, "log text renderer must remain present");
    const renderer = appSource.slice(renderStart, renderEnd);
    assert.match(renderer, /escapeHtml\(text/);
    assert.doesNotMatch(renderer, /<pre[^`]*\$\{text/);
});

test("legacy log rendering is bounded and boot does not eagerly load task logs", () => {
    const constantMatch = appSource.match(/const MAX_LEGACY_LOG_RENDER_CHARS = [^;]+;/);
    const previewStart = appSource.indexOf("function legacyLogPreview");
    const previewEnd = appSource.indexOf("\nfunction coalesceLogEvents", previewStart);
    assert.ok(constantMatch && previewStart >= 0 && previewEnd > previewStart);

    const context = {};
    vm.runInNewContext(`${constantMatch[0]}\n${appSource.slice(previewStart, previewEnd)}\nthis.legacyLogPreview = legacyLogPreview;`, context);
    const largeLog = `discard-${"x".repeat(300000)}-tail`;
    const preview = context.legacyLogPreview(largeLog);
    assert.equal(preview.truncated, true);
    assert.ok(preview.content.length <= 256 * 1024);
    assert.ok(preview.content.endsWith("-tail"));
    assert.doesNotMatch(preview.content, /^discard-/);

    const bootStart = appSource.indexOf("async function boot");
    const bootEnd = appSource.indexOf("\nwindow.addEventListener", bootStart);
    const bootSource = appSource.slice(bootStart, bootEnd);
    assert.doesNotMatch(bootSource, /loadLog\(firstTask\.id/);

    const switchStart = appSource.indexOf("function switchView");
    const switchEnd = appSource.indexOf("\nfunction applyLanguage", switchStart);
    assert.match(appSource.slice(switchStart, switchEnd), /view !== "runtime"\) cancelLogRequest\(\)/);
});

test("ping view lets the user pick which Profiles are pinged automatically", () => {
    assert.match(indexSource, /id="pingProfileList"/);
    assert.match(indexSource, /id="pingProfileSummary"/);
    const start = appSource.indexOf("function renderPingProfilePicker");
    const end = appSource.indexOf("\nfunction renderPings", start);
    assert.ok(start >= 0 && end > start, "ping profile picker renderer must remain present");
    const renderer = appSource.slice(start, end);
    assert.match(renderer, /pingEligible === true/);
    assert.match(renderer, /pingSettings\?\.profileIds/);
    assert.match(renderer, /escapeHtml\(profile\.name\)/);
    assert.match(appSource, /body: \{ profileIds \}/);
    assert.match(appSource, /form\.elements\.pingEnabled\.checked = profile\?\.pingEnabled === true/);
});

test("profile editor exposes an individual connection test", () => {
    assert.match(indexSource, /id="pingProfile"/);
    assert.match(indexSource, /id="profilePingStatus"/);
    assert.match(appSource, /\/api\/profiles\/\$\{encodeURIComponent\(id\)\}\/ping/);
    assert.match(appSource, /profile\.pingSuccess/);
    assert.match(appSource, /profile\.pingFailure/);
});

test("ping ledger shows latency and token metrics with safe expandable success details", () => {
    const renderStart = appSource.indexOf("function formatPingDuration");
    const renderEnd = appSource.indexOf("\nfunction renderSelectors", renderStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart, "ping renderer must remain present");
    const renderer = appSource.slice(renderStart, renderEnd);

    assert.match(renderer, /ping\.column\.firstOutput/);
    assert.match(renderer, /ping\.column\.duration/);
    assert.match(renderer, /ping\.column\.inputTokens/);
    assert.match(renderer, /ping\.column\.outputTokens/);
    assert.doesNotMatch(renderer, /ping\.column\.baseUrl/);
    assert.doesNotMatch(renderer, /ping\.column\.question/);
    assert.match(renderer, /<details class="ping-record ping-record-success"/);
    assert.match(renderer, /record\.failureReason/);
    assert.match(renderer, /escapeHtml\(inputText\)/);
    assert.match(renderer, /escapeHtml\(outputText\)/);
});

test("runtime view lists started tasks as switchable tabs", () => {
    assert.match(indexSource, /id="runtimeTabsBar"/);
    assert.match(indexSource, /id="runtimeTabs"[^>]*role="tablist"/);

    const escapeStart = appSource.indexOf("function escapeHtml");
    const escapeEnd = appSource.indexOf("\nfunction formatTime", escapeStart);
    const startedStart = appSource.indexOf("function taskIsStarted(");
    const startedEnd = appSource.indexOf("\nfunction renderRuntimeContext", startedStart);
    // renderRuntimeTabs 依赖紧邻其前的 runtimeTabTasks，一并切入
    const renderStart = appSource.indexOf("function runtimeTabTasks(");
    const renderEnd = appSource.indexOf("\nasync function selectRuntimeTask(", renderStart);
    assert.ok(startedStart >= 0 && startedEnd > startedStart, "started-task filter must remain present");
    assert.ok(renderStart >= 0 && renderEnd > renderStart, "runtime tab renderer must remain present");

    const bar = { hidden: true };
    const tabs = { innerHTML: "" };
    const nodes = new Map([["#runtimeTabsBar", bar], ["#runtimeTabs", tabs]]);
    const context = {
        state: {
            selectedTaskId: "task-live",
            runtimeTabsSignature: "",
            data: {
                tasks: [
                    { id: "task-live", title: "运行中的任务", isRunning: true, runtimeState: "agent_running" },
                    { id: "task-queued", title: "排队任务", status: "queued", runtimeState: "queue_waiting" },
                    { id: "task-scheduled", title: "预约任务", status: "scheduled", runtimeState: "loop_not_started" },
                    { id: "task-idle", title: "空闲等待", isRunning: true, loopActive: true, runtimeState: "idle_waiting" },
                    { id: "task-done", title: "已完成", status: "completed", runtimeState: "loop_not_started" },
                    { id: "task-archived", title: "已归档", archived: true, isRunning: true, runtimeState: "agent_running" },
                    { id: "task-hostile", title: "<img src=x onerror=alert(1)>", status: "running" },
                ],
            },
        },
        $: (selector) => nodes.get(selector),
        taskRuntimeState: (task) => task.runtimeState || "loop_not_started",
        taskDisplayStatus: (task) => task.runtimeState || task.status,
        t: (key, params = {}) => `${key}:${params.name || ""}`,
    };
    vm.runInNewContext(`${appSource.slice(escapeStart, escapeEnd)}\n${appSource.slice(startedStart, startedEnd)}\n${appSource.slice(renderStart, renderEnd)}\nthis.taskIsStarted = taskIsStarted; this.renderRuntimeTabs = renderRuntimeTabs;`, context);

    assert.equal(context.taskIsStarted(null), false);
    assert.equal(context.taskIsStarted({ id: "done", status: "completed" }), false);
    assert.equal(context.taskIsStarted({ id: "archived", archived: true, isRunning: true }), false);
    assert.equal(context.taskIsStarted({ id: "queued", status: "queued" }), true);
    assert.equal(context.taskIsStarted({ id: "loop", isRunning: true }), true);

    context.renderRuntimeTabs();
    assert.equal(bar.hidden, false);
    const markup = tabs.innerHTML;
    for (const id of ["task-live", "task-queued", "task-scheduled", "task-idle", "task-hostile"]) {
        assert.match(markup, new RegExp(`data-runtime-tab="${id}"`));
    }
    for (const id of ["task-done", "task-archived"]) {
        assert.doesNotMatch(markup, new RegExp(`data-runtime-tab="${id}"`));
    }
    assert.match(markup, /data-runtime-tab="task-live"[^>]*aria-selected="true"/);
    assert.match(markup, /data-runtime-tab="task-queued"[^>]*aria-selected="false"/);
    assert.match(markup, /data-runtime-state="queue_waiting"/);
    assert.match(markup, /runtime\.tabsSwitch:运行中的任务/);
    assert.doesNotMatch(markup, /<img src=x onerror/);
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);

    // Polling must not rebuild the tab strip (and steal focus) while nothing changed.
    tabs.innerHTML = "sentinel";
    context.renderRuntimeTabs();
    assert.equal(tabs.innerHTML, "sentinel");

    context.state.selectedTaskId = "task-queued";
    context.renderRuntimeTabs();
    assert.match(tabs.innerHTML, /data-runtime-tab="task-queued"[^>]*aria-selected="true"/);

    context.state.data.tasks = [{ id: "task-done", status: "completed" }];
    context.state.selectedTaskId = "";
    context.renderRuntimeTabs();
    assert.equal(bar.hidden, true);

    assert.match(appSource, /#runtimeTabs"\)\.addEventListener\("click"/);
    assert.match(appSource, /\[data-runtime-tab\]/);
    assert.match(appSource, /await selectRuntimeTask\(event\.target\.value\)/);
    // renderSelectors() picks the fallback task, so the tabs must be rebuilt after it
    // or the first paint highlights no tab.
    const renderAllStart = appSource.indexOf("function renderAll()");
    const renderAllEnd = appSource.indexOf("\nasync function refresh(", renderAllStart);
    assert.match(appSource.slice(renderAllStart, renderAllEnd), /renderSelectors\(\);[\s\S]*renderRuntimeTabs\(\);/);
});

test("runtime exposes fixed-time and Profile-availability scheduling", () => {
    assert.match(indexSource, /id="scheduleMode"/);
    assert.match(indexSource, /value="fixed_time"/);
    assert.match(indexSource, /value="profile_available"/);
    assert.match(indexSource, /id="scheduleTimeField"/);
    assert.match(appSource, /scheduleMode === "profile_available"/);
    assert.match(appSource, /body = \{ profileIds, scheduleMode \}/);
    assert.match(appSource, /runtimeState\.waitingAvailability/);
});

test("project task tree exposes queue and archive actions on the unified task page", () => {
    assert.match(indexSource, /id="taskProject"/);
    assert.match(indexSource, /id="projectForm"/);
    assert.match(indexSource, /id="projectList"/);
    assert.match(indexSource, /id="runtimeFileEditor"/);
    assert.match(indexSource, /id="archiveTask"/);
    assert.match(appSource, /function renderProjects/);
    assert.match(appSource, /project-tree/);
    assert.match(appSource, /data-archive-task/);
    assert.match(appSource, /\/api\/projects/);
    assert.match(appSource, /\/archive/);
    assert.match(appSource, /toast\.taskQueued/);
    assert.match(appSource, /runtimeState\.queue_waiting/);
});

test("dashboard cards navigate to their related module, task, or project", () => {
    const targetStart = appSource.indexOf("function dashboardEventTarget");
    const targetEnd = appSource.indexOf("\nfunction renderMetrics", targetStart);
    assert.ok(targetStart >= 0 && targetEnd > targetStart, "dashboard event routing helper must remain present");
    const context = {};
    vm.runInNewContext(`${appSource.slice(targetStart, targetEnd)}\nthis.dashboardEventTarget = dashboardEventTarget;`, context);

    assert.equal(JSON.stringify(context.dashboardEventTarget({ type: "completed", taskId: "task-1" })), JSON.stringify({ view: "runtime", taskId: "task-1" }));
    assert.equal(JSON.stringify(context.dashboardEventTarget({ type: "profile" })), JSON.stringify({ view: "profiles" }));
    assert.equal(JSON.stringify(context.dashboardEventTarget({ type: "ping" })), JSON.stringify({ view: "pings" }));
    assert.equal(JSON.stringify(context.dashboardEventTarget({ type: "project" })), JSON.stringify({ view: "tasks" }));
    assert.equal(JSON.stringify(context.dashboardEventTarget({ type: "directory" })), JSON.stringify({ view: "settings" }));

    const metricsStart = appSource.indexOf("function renderMetrics");
    const metricsEnd = appSource.indexOf("\nfunction renderTasks", metricsStart);
    const metricsRenderer = appSource.slice(metricsStart, metricsEnd);
    assert.match(metricsRenderer, /<button class="metric dashboard-card"/);
    assert.match(metricsRenderer, /data-dashboard-view/);
    assert.match(metricsRenderer, /data-dashboard-runtime-state/);
    assert.match(appSource, /function openDashboardView/);
    assert.match(appSource, /function openTaskPage/);
    assert.match(appSource, /function openProject/);
    assert.match(appSource, /data-open-project/);
    assert.match(appSource, /dashboard-target-highlight/);
});

test("removing the selected task clears editors and logs before selecting a remaining task", async () => {
    const start = appSource.indexOf("async function refresh(");
    const end = appSource.indexOf("\nfunction updateTokenPlaceholder", start);
    const nodes = new Map(["#fileEditor", "#runtimeFileEditor", "#appendTaskItems", "#appendCompletionStandard", "#editorPath", "#runtimeEditorPath", "#runProfiles"]
        .map((selector) => [selector, { value: "old task content", textContent: "old task path", innerHTML: "old profiles" }]));
    let nextTasks = [{ id: "kept" }];
    const logLoads = [];
    const context = {
        state: { selectedTaskId: "removed", scheduleTaskId: "removed", fileRequestId: 0, refreshRequestId: 0, activeView: "runtime" },
        api: async () => ({ tasks: nextTasks }),
        $: (selector) => nodes.get(selector),
        t: (key) => key,
        loadLog: async (id) => logLoads.push(id),
        renderAll: () => {
            if (!context.state.selectedTaskId) context.state.selectedTaskId = nextTasks[0]?.id || "";
        },
        loadFile: async (id) => {
            assert.equal(nodes.get("#fileEditor").value, "");
            assert.equal(nodes.get("#runtimeFileEditor").value, "");
            nodes.get("#fileEditor").value = `content for ${id}`;
            nodes.get("#runtimeFileEditor").value = `content for ${id}`;
        },
    };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.refresh = refresh;`, context);
    await context.refresh({ replacementTaskId: "kept" });
    assert.equal(context.state.selectedTaskId, "kept");
    assert.equal(nodes.get("#fileEditor").value, "content for kept");
    assert.equal(nodes.get("#appendTaskItems").value, "");
    assert.equal(nodes.get("#appendCompletionStandard").value, "");
    assert.equal(context.state.fileRequestId, 1);
    assert.deepEqual(logLoads, ["", "kept"]);

    // A background poll may already have selected a fallback before the deduplication response arrives.
    context.state.selectedTaskId = "fallback";
    context.state.data = { tasks: [{ id: "fallback" }, { id: "kept" }] };
    context.api = async () => null;
    await context.refresh({ replacementTaskId: "kept" });
    assert.equal(context.state.selectedTaskId, "kept");
    assert.equal(nodes.get("#fileEditor").value, "content for kept");

    nextTasks = [];
    context.api = async () => ({ tasks: nextTasks });
    await context.refresh();
    assert.equal(context.state.selectedTaskId, "");
    assert.equal(nodes.get("#fileEditor").value, "");
    assert.equal(nodes.get("#runtimeFileEditor").value, "");
    assert.equal(nodes.get("#editorPath").textContent, "editor.noTask");
    assert.equal(logLoads.at(-1), "");
});

test("a stale file response cannot restore a deleted task or overwrite the next editor", async () => {
    const start = appSource.indexOf("async function loadFile(");
    const end = appSource.indexOf("\nasync function deleteTask", start);
    let resolveFile;
    const context = {
        state: { selectedTaskId: "removed", fileRequestId: 0, data: { tasks: [{ id: "removed" }] } },
        api: () => new Promise((resolve) => { resolveFile = resolve; }),
        $: () => { throw new Error("stale response must not touch the editors"); },
    };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.loadFile = loadFile;`, context);
    const pending = context.loadFile("removed");
    context.state.fileRequestId += 1;
    context.state.selectedTaskId = "kept";
    context.state.data.tasks = [{ id: "kept" }];
    resolveFile({ content: "stale content", filePath: "removed.md" });
    await pending;
    assert.equal(context.state.selectedTaskId, "kept");
});

test("delete actions remain disabled for active tasks and processes, including a stopped process still exiting", () => {
    const start = appSource.indexOf("function taskCanDelete(");
    const end = appSource.indexOf("\nfunction renderRuntimeContext", start);
    const context = { state: { deletingTaskIds: new Set() } };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.taskCanDelete = taskCanDelete;`, context);
    for (const status of ["running", "queued", "scheduled", "retry_wait"]) {
        assert.equal(context.taskCanDelete({ id: "busy", status }), false);
    }
    assert.equal(context.taskCanDelete({ id: "stopping", status: "stopped", canDelete: false }), false);
    assert.equal(context.taskCanDelete({ id: "archived", archived: true, status: "completed", canDelete: true }), true);
    assert.equal(context.taskCanDelete(null), false);
});

test("live log memory is bounded by both event count and output length", () => {
    const start = appSource.indexOf("function boundLogEvents(");
    const end = appSource.indexOf("\nfunction cancelLogRequest", start);
    const context = { MAX_LOG_EVENTS: 400, MAX_LOG_RENDER_CHARS: 512 * 1024 };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.boundLogEvents = boundLogEvents;`, context);
    const small = Array.from({ length: 1000 }, (_, sequence) => ({ sequence, text: "small" }));
    assert.equal(context.boundLogEvents(small).length, 400);
    assert.equal(context.boundLogEvents(small)[0].sequence, 600);
    const large = Array.from({ length: 100 }, (_, sequence) => ({ sequence, text: "x".repeat(65536) }));
    assert.equal(context.boundLogEvents(large).length, 8);
    assert.equal(context.boundLogEvents(large).at(-1).sequence, 99);
});

test("unchanged log polls preserve timeline DOM and expanded details", () => {
    const start = appSource.indexOf("function renderConversationLog(");
    const end = appSource.indexOf("\nfunction renderConversationBody", start);
    const nodes = new Map();
    let bodyRenders = 0;
    const context = {
        state: { log: { taskId: "task", runId: "", renderVersion: 1, events: [{ sequence: 1 }], content: "", loading: false, following: false, format: "structured" } },
        $: (selector) => {
            if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, scrollTop: 20, scrollHeight: 200, setAttribute() {} });
            return nodes.get(selector);
        },
        i18n: { getLanguage: () => "zh-CN" },
        t: (key) => key,
        translatedOr: (_key, fallback) => fallback,
        renderConversationBody: () => { bodyRenders += 1; },
        renderLogRunOptions() {}, renderLogNotice() {}, setLogFollowing() {},
    };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.renderConversationLog = renderConversationLog;`, context);
    context.renderConversationLog();
    context.state.log.loading = true;
    context.renderConversationLog();
    context.state.log.loading = false;
    context.renderConversationLog();
    assert.equal(bodyRenders, 1);
    context.state.log.renderVersion += 1;
    context.renderConversationLog();
    assert.equal(bodyRenders, 2);
});

test("polling never overlaps requests and pauses while the page is hidden", async () => {
    const start = appSource.indexOf("async function poll(");
    const end = appSource.indexOf("\nasync function boot", start);
    let refreshes = 0;
    let resolveRefresh;
    const context = {
        state: { pollInFlight: false, data: { tasks: [] }, log: {}, pollFailures: 0 },
        document: { hidden: true },
        refresh: () => { refreshes += 1; return new Promise((resolve) => { resolveRefresh = resolve; }); },
        $: () => ({ value: "" }),
        clearTimeout() {},
        setTimeout: () => { throw new Error("must not schedule background polling"); },
        toast: (message) => { throw new Error(message); },
    };
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.poll = poll;`, context);
    await context.poll();
    assert.equal(refreshes, 0);
    context.document.hidden = false;
    const pending = context.poll();
    await context.poll();
    assert.equal(refreshes, 1);
    context.document.hidden = true;
    resolveRefresh();
    await pending;
    assert.equal(context.state.pollInFlight, false);
});

test("task page pairs the project tree with an auto-saving task editor", () => {
    assert.match(indexSource, /class="split task-workbench"/);
    assert.match(indexSource, /class="panel task-tree-panel"[\s\S]*id="taskList"[\s\S]*class="panel task-editor-panel"/, "the tree must come before the editor");
    assert.match(indexSource, /id="taskForm" class="form-grid single" data-mode="create"/);
    assert.match(indexSource, /<input type="hidden" name="taskId">/);
    assert.match(indexSource, /id="taskEditorStatus"[^>]*aria-live="polite"/);
    assert.match(indexSource, /id="newTaskButton"/);
    assert.match(indexSource, /id="taskOpenRuntime"/);
    assert.match(appSource, /function openTaskEditor\(taskId\)/);
    assert.match(appSource, /function resetTaskEditor\(\)/);
    assert.match(appSource, /function scheduleTaskAutosave\(\)/);
    assert.match(appSource, /method: "PATCH", body: taskEditorPayload\(form\)/);
    assert.match(appSource, /tree-task-selected/);

    // 编辑态提交的字段：锁定字段绝不进入自动保存的请求体。
    const payloadStart = appSource.indexOf("function taskEditorPayload(form)");
    const payloadEnd = appSource.indexOf("\nfunction scheduleTaskAutosave", payloadStart);
    assert.ok(payloadStart >= 0 && payloadEnd > payloadStart);
    const context = { selectedValues: (select) => select.selected };
    vm.runInNewContext(`${appSource.slice(payloadStart, payloadEnd)}\nthis.taskEditorPayload = taskEditorPayload;`, context);
    const field = (value) => ({ value });
    const form = {
        dataset: { taskType: "video" },
        elements: {
            taskType: field("video"),
            title: field(" 标题 "),
            requirement: field("需求"),
            projectId: field("proj"),
            decomposeProfileId: field("gen"),
            runProfileIds: { selected: ["p1", "p2"] },
            artifactDirectoryName: field("renders"),
            outputFileName: field("clip.mp4"),
            outputFormat: field("mp4"),
            aspectRatio: field("16:9"),
            resolution: field("1920x1080"),
            durationSeconds: field("8"),
            referenceFiles: field("a.png"),
            targetFileName: field("locked.md"),
            directory: field("D:/locked"),
        },
    };
    const payload = context.taskEditorPayload(form);
    assert.deepEqual(Object.keys(payload).sort(), [
        "artifactDirectoryName", "aspectRatio", "decomposeProfileId", "durationSeconds", "outputFileName",
        "outputFormat", "projectId", "referenceFiles", "requirement", "resolution", "runProfileIds", "title",
    ]);
    assert.deepEqual(payload.runProfileIds, ["p1", "p2"]);
    form.dataset.taskType = "text";
    assert.deepEqual(Object.keys(context.taskEditorPayload(form)).sort(), ["decomposeProfileId", "projectId", "requirement", "runProfileIds", "title"]);
});

test("task creation stores information only and the runtime page owns generation", () => {
    // 3.1 表单来源四选一，创建按钮不再是「调用 Agent 生成」
    assert.match(indexSource, /id="taskSourceMode"[\s\S]*?value="manual"[\s\S]*?value="agent"[\s\S]*?value="existing"[\s\S]*?value="upload"/);
    assert.doesNotMatch(indexSource, /task\.submit\.generate/);
    assert.match(indexSource, /id="taskSubmitButton" data-i18n="task\.submit\.save"/);
    assert.match(indexSource, /id="taskRequirementLabel"/);
    // 4.1 运行页有生成提示容器
    assert.match(indexSource, /id="runtimeGenerationHint"[^>]*hidden/);

    // 3.2 buildTaskRequestBody：manual → template，agent → agent，requirementMode 透传；existing / upload 不带 requirementMode
    const start = appSource.indexOf("function buildTaskRequestBody(values)");
    const end = appSource.indexOf("\nfunction syncTaskSourceMode", start);
    assert.ok(start >= 0 && end > start);
    const context = {};
    vm.runInNewContext(`${appSource.slice(start, end)}\nthis.buildTaskRequestBody = buildTaskRequestBody;`, context);
    const manual = context.buildTaskRequestBody({ title: "a", sourceMode: "manual", sourceFile: {} });
    assert.equal(manual.sourceMode, "template");
    assert.equal(manual.requirementMode, "manual");
    assert.equal("sourceFile" in manual, false);
    const agent = context.buildTaskRequestBody({ title: "b", sourceMode: "agent" });
    assert.equal(agent.sourceMode, "agent");
    assert.equal(agent.requirementMode, "agent");
    const existing = context.buildTaskRequestBody({ title: "c", sourceMode: "existing", requirementMode: "manual" });
    assert.equal(existing.sourceMode, "existing");
    assert.equal("requirementMode" in existing, false);
    assert.equal(context.buildTaskRequestBody({ title: "d" }).sourceMode, "template", "default source is the manual task list");

    // submit 不再处理 result.generation，保存后跳转运行页
    const submitStart = appSource.indexOf('$("#taskForm").addEventListener("submit"');
    const submitEnd = appSource.indexOf('$("#deduplicateTasks").addEventListener', submitStart);
    const submitSource = appSource.slice(submitStart, submitEnd);
    assert.doesNotMatch(submitSource, /result\.generation/);
    assert.match(submitSource, /await openTaskPage\(result\.task\.id\)/);
    assert.match(submitSource, /toast\.taskCreated/);
});

test("runtime tabs include the selected task and generation state drives the controls", () => {
    const tabsStart = appSource.indexOf("function runtimeTabTasks(tasks, selectedTaskId)");
    const tabsEnd = appSource.indexOf("\nfunction renderRuntimeTabs", tabsStart);
    assert.ok(tabsStart >= 0 && tabsEnd > tabsStart);
    const context = {
        taskIsStarted: (task) => Boolean(task.isRunning),
    };
    vm.runInNewContext(`${appSource.slice(tabsStart, tabsEnd)}\nthis.runtimeTabTasks = runtimeTabTasks;`, context);
    const tasks = [
        { id: "running", isRunning: true },
        { id: "fresh", isRunning: false },
        { id: "archived", isRunning: false, archived: true },
    ];
    assert.deepEqual(context.runtimeTabTasks(tasks, "fresh").map((task) => task.id), ["running", "fresh"], "a just-created selected task without runs is listed");
    assert.deepEqual(context.runtimeTabTasks(tasks, "running").map((task) => task.id), ["running"], "no duplicate when the selected task is already started");
    assert.deepEqual(context.runtimeTabTasks(tasks, "archived").map((task) => task.id), ["running"], "archived tasks never appear");
    assert.deepEqual(context.runtimeTabTasks(tasks, "").map((task) => task.id), ["running"]);

    const viewStart = appSource.indexOf("function runtimeGenerationView(task)");
    const viewEnd = appSource.indexOf("\n// 运行页标签", viewStart);
    assert.ok(viewStart >= 0 && viewEnd > viewStart);
    const viewContext = {};
    vm.runInNewContext(`${appSource.slice(viewStart, viewEnd)}\nthis.runtimeGenerationView = runtimeGenerationView;`, viewContext);
    const pending = viewContext.runtimeGenerationView({ requirementMode: "agent", generationState: "pending" });
    assert.deepEqual([pending.showGenerate, pending.primaryGenerate, pending.blockStart, pending.hint], [true, true, true, "runtime.generationPending"]);
    const failed = viewContext.runtimeGenerationView({ requirementMode: "agent", generationState: "failed" });
    assert.deepEqual([failed.blockStart, failed.hint], [true, "runtime.generationFailed"]);
    const generated = viewContext.runtimeGenerationView({ requirementMode: "agent", generationState: "generated" });
    assert.deepEqual([generated.showGenerate, generated.primaryGenerate, generated.blockStart, generated.hint], [true, false, false, ""]);
    const manual = viewContext.runtimeGenerationView({ requirementMode: "manual", generationState: "none" });
    assert.deepEqual([manual.showGenerate, manual.blockStart], [false, false]);

    const clickStart = appSource.indexOf('$("#decomposeTask").addEventListener("click"');
    const clickEnd = appSource.indexOf('$("#copyLog").addEventListener', clickStart);
    const clickSource = appSource.slice(clickStart, clickEnd);
    assert.match(clickSource, /runtime\.generating/);
    assert.match(clickSource, /state\.generatingTaskId = taskId/);
    assert.match(clickSource, /finally \{/);
});
