const assert = require("node:assert/strict");
const test = require("node:test");

const {
    fillTemplate,
    generateTaskMarkdown,
    maskEnvText,
    parseArgs,
    parseEnvText,
    safeTaskFileName,
} = require("../lib/core");

test("parseArgs handles quoted prompt placeholders", () => {
    assert.deepEqual(
        parseArgs("--model test -p \"{prompt}\" --flag"),
        ["--model", "test", "-p", "{prompt}", "--flag"],
    );
});

test("parseArgs rejects unclosed quotes", () => {
    assert.throws(() => parseArgs("--name \"broken"), /未闭合/);
});

test("fillTemplate replaces supported placeholder formats", () => {
    const result = fillTemplate("file={targetFile}; cn=${目标任务文件}; prompt={{prompt}}", {
        targetFile: "tasks.md",
        prompt: "hello",
    });
    assert.equal(result, "file=tasks.md; cn=tasks.md; prompt=hello");
});

test("safeTaskFileName strips path traversal and adds markdown extension", () => {
    assert.equal(safeTaskFileName("../P3-真实笔顺评分"), "P3-真实笔顺评分.md");
});

test("parseEnvText and maskEnvText handle key value lines", () => {
    assert.deepEqual(parseEnvText("API_KEY=secret\n# comment\nBAD KEY=no\nMODEL=pro"), {
        API_KEY: "secret",
        MODEL: "pro",
    });
    assert.equal(maskEnvText("API_KEY=secret"), "API_KEY=********");
});

test("generateTaskMarkdown creates editable checklist", () => {
    const content = generateTaskMarkdown({
        title: "Web 应用",
        requirement: "实现 Profile 管理\n实现日志监控",
        createdAt: "2026-06-05T00:00:00.000Z",
    });
    assert.match(content, /^# Web 应用/);
    assert.match(content, /- \[ \] 1\. 实现 Profile 管理/);
    assert.match(content, /完成标准/);
});
