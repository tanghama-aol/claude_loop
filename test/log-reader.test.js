const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLogReader, selectLogEntries } = require("../lib/log-reader");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-log-reader-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "events.jsonl");
}

test("log index reads only appended bytes on warm polls and retains no output text", (t) => {
    const file = fixture(t);
    const event = (sequence) => ({ sequence, runId: "run_a", timestamp: "2026-09-13", type: "stdout", text: "输出 😀".repeat(200) });
    fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => JSON.stringify(event(i + 1))).join("\n") + "\n");
    const reader = createLogReader();
    const initial = reader.inspect(file);
    assert.equal(initial.events.length, 1000);
    assert.equal(initial.events[0].text, undefined);
    const originalRead = fs.readSync;
    let bytesRead = 0;
    fs.readSync = (...args) => {
        const bytes = originalRead(...args);
        bytesRead += bytes;
        return bytes;
    };
    try {
        assert.equal(reader.inspect(file), initial);
        assert.equal(bytesRead, 0, "unchanged polls must not reread the log");
        const appendedLine = `${JSON.stringify(event(1001))}\n`;
        fs.appendFileSync(file, appendedLine);
        const appended = reader.inspect(file);
        assert.equal(appended.events.length, 1001);
        assert.ok(bytesRead <= Buffer.byteLength(appendedLine) + 1024, `${bytesRead} bytes read`);
        const page = selectLogEntries(appended.events, { after: 1000, limit: 20 });
        assert.deepEqual(reader.readEvents(file, page.entries), [event(1001)]);
    } finally {
        fs.readSync = originalRead;
    }
});

test("log index handles split UTF-8 lines, corrupt data, rewrites, replacement and missing files", (t) => {
    const file = fixture(t);
    const reader = createLogReader();
    const first = { sequence: 1, type: "stdout", text: "开头 😀" };
    const second = { sequence: 2, type: "stdout", text: "跨块 中文 😀".repeat(40000) };
    const line = Buffer.from(JSON.stringify(second));
    fs.writeFileSync(file, `${JSON.stringify(first)}\ninvalid\n`);
    fs.appendFileSync(file, line.subarray(0, line.length - 3));
    assert.equal(reader.inspect(file).malformedLines, 2);
    fs.appendFileSync(file, line.subarray(line.length - 3));
    let result = reader.inspect(file);
    assert.equal(result.malformedLines, 1);
    assert.deepEqual(reader.readEvents(file, result.events), [first, second]);
    fs.appendFileSync(file, `\n${JSON.stringify({ sequence: 3, text: "最后一行" })}\n`);
    assert.equal(reader.inspect(file).events.length, 3);

    fs.writeFileSync(file, JSON.stringify({ sequence: 8, text: "rewritten" }) + "\n");
    result = reader.inspect(file);
    assert.deepEqual(result.events.map((event) => event.sequence), [8]);
    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, JSON.stringify({ sequence: 9, text: "replaced!" }) + "\n");
    fs.renameSync(replacement, file);
    assert.deepEqual(reader.inspect(file).events.map((event) => event.sequence), [9]);
    fs.unlinkSync(file);
    assert.equal(reader.inspect(file).exists, false);
});

test("log pages support latest, older and catch-up cursors without skipping events", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, length: 10 }));
    assert.deepEqual(selectLogEntries(events, { limit: 3 }).entries.map((event) => event.sequence), [8, 9, 10]);
    const older = selectLogEntries(events, { before: 8, limit: 3 });
    assert.deepEqual(older.entries.map((event) => event.sequence), [5, 6, 7]);
    assert.equal(older.hasMoreBefore, true);
    assert.equal(older.hasMoreAfter, true);
    assert.deepEqual(selectLogEntries(events, { after: 3, limit: 3 }).entries.map((event) => event.sequence), [4, 5, 6]);
    assert.equal(selectLogEntries(events, { before: 4, limit: 3 }).hasMoreBefore, false);
    assert.deepEqual(selectLogEntries(events, { after: 10, limit: 3 }).entries, []);
    assert.deepEqual(selectLogEntries(events, { limit: 8, maxBytes: 25 }).entries.map((event) => event.sequence), [9, 10]);
});
