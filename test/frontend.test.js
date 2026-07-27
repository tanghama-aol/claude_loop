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
