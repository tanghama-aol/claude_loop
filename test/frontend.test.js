const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

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
