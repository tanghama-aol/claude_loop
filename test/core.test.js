const assert = require("node:assert/strict");
const test = require("node:test");

const {
    ALL_DONE_MARKER,
    CODEX_AUTO_CONFIRM_FLAG,
    DEFAULT_RUN_PROMPT,
    configEnvForProfile,
    createDefaultProfiles,
    fillTemplate,
    generateTaskMarkdown,
    maskEnvText,
    nextProfileId,
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

test("fillTemplate preserves dollar signs in replacement values", () => {
    const result = fillTemplate("{prompt}", {
        prompt: "literal $$ value",
    });
    assert.equal(result, "literal $$ value");
});

test("default run prompt uses the command-safe all-done marker", () => {
    assert.equal(ALL_DONE_MARKER, "GGGG全部完成GGGG");
    assert.match(DEFAULT_RUN_PROMPT, /GGGG全部完成GGGG/);
});

test("nextProfileId rotates through configured profiles", () => {
    assert.equal(nextProfileId("a", ["a", "b", "c"]), "b");
    assert.equal(nextProfileId("c", ["a", "b", "c"]), "a");
    assert.equal(nextProfileId("missing", ["a", "b"]), "a");
});

test("configEnvForProfile maps agent config directories", () => {
    assert.deepEqual(configEnvForProfile({ agentType: "claude", configDirectory: "/tmp/claude" }), {
        CLAUDE_CONFIG_DIR: "/tmp/claude",
    });
    assert.deepEqual(configEnvForProfile({ agentType: "codex", configDirectory: "/tmp/codex" }), {
        CODEX_HOME: "/tmp/codex",
    });
    assert.deepEqual(configEnvForProfile({ agentType: "gemini", configDirectory: "/tmp/gemini" }), {
        GEMINI_CONFIG_DIR: "/tmp/gemini",
        GEMINI_CLI_HOME: "/tmp/gemini",
    });
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

test("default codex profile bypasses confirmations", () => {
    const codexProfile = createDefaultProfiles("/tmp/project").find((profile) => profile.id === "profile_codex_default");
    assert.ok(codexProfile);
    assert.match(codexProfile.args, new RegExp(CODEX_AUTO_CONFIRM_FLAG));
});
