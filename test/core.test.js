const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
    ALL_DONE_MARKER,
    ALL_DONE_OUTPUT,
    CODEX_AUTO_CONFIRM_FLAG,
    DEFAULT_GENERATE_PROMPT,
    DEFAULT_PROFILE_DIRECTORY,
    DEFAULT_RUN_PROMPT,
    appendTaskItemsToMarkdown,
    configEnvForProfile,
    createTaskLogEvent,
    createDefaultProfiles,
    fillTemplate,
    generateTaskMarkdown,
    isAllDoneOutput,
    maskEnvText,
    nextProfileId,
    nextTaskItemNumber,
    normalizeTaskItem,
    normalizeModalities,
    parseArgs,
    parseEnvText,
    parseTaskLogEvents,
    providerForAgentType,
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

test("task log events preserve raw multiline output and parse in sequence order", () => {
    const later = createTaskLogEvent({
        sequence: 2,
        taskId: "task-1",
        runId: "run-1",
        timestamp: "2026-07-25T00:00:02.000Z",
        type: "STDOUT",
        phase: "run",
        text: "first line\nsecond line\n",
        stream: "stdout",
        profile: { id: "profile-1", name: "codex-fast", agentType: "codex" },
    });
    const earlier = createTaskLogEvent({
        sequence: 1,
        taskId: "task-1",
        runId: "run-1",
        timestamp: "2026-07-25T00:00:01.000Z",
        type: "Process Started",
        text: "started",
    });
    const parsed = parseTaskLogEvents([
        JSON.stringify(later),
        "not-json",
        JSON.stringify(earlier),
        "",
    ].join("\n"));

    assert.deepEqual(parsed.map((event) => event.sequence), [1, 2]);
    assert.equal(parsed[0].type, "process_started");
    assert.equal(parsed[1].text, "first line\nsecond line\n");
    assert.equal(parsed[1].profile.name, "codex-fast");
});

test("fillTemplate supports multimodal provider and artifact placeholders", () => {
    const result = fillTemplate("{provider}|{taskType}|{outputFile}|{referenceFiles}", {
        provider: "replicate",
        taskType: "video",
        outputFile: "/tmp/result.mp4",
        referenceFiles: ["a.png", "b.png"],
    });
    assert.equal(result, "replicate|video|/tmp/result.mp4|a.png\nb.png");
});

test("provider and modality helpers preserve compatible defaults", () => {
    assert.equal(providerForAgentType("claude"), "anthropic");
    assert.equal(providerForAgentType("codex"), "openai");
    assert.equal(providerForAgentType("gemini"), "google");
    assert.deepEqual(normalizeModalities(["text", "image", "image", "unknown"]), ["text", "image"]);
    assert.deepEqual(normalizeModalities([], ["text"]), ["text"]);
});

test("default task prompts require step tracking and command-safe completion", () => {
    assert.equal(ALL_DONE_MARKER, "GGGG全部完成GGGG");
    assert.equal(ALL_DONE_OUTPUT, "GGGG全部完成GGGGGGGG全部完成GGGG");
    assert.match(DEFAULT_RUN_PROMPT, /GGGG全部完成GGGG/);
    const prompt = fillTemplate(DEFAULT_RUN_PROMPT, { targetFile: "任务.md" });
    assert.ok(prompt.includes("任务.md"));
    assert.ok(!prompt.includes("{targetFile}"));
    assert.match(prompt, /失败则不修改任务文件/);
    for (const template of [prompt, DEFAULT_GENERATE_PROMPT]) {
        assert.match(template, /详细方案/);
        assert.match(template, /开发步骤/);
        assert.match(template, /- \[ \]（todo）/);
        assert.match(template, /- \[x\]（done）/);
        assert.match(template, /只有所有子任务都已完成且父任务的完成标准已满足[\s\S]*?FINISHED/);
        assert.match(template, /目标任务文件末尾另起一行写入/);
        assert.match(template, /中间不要有空格、换行或其他间隔/);
        assert.match(template, /移除旧的完整结束标志/);
        assert.equal(isAllDoneOutput(template), false, "prompt instructions must not look like a completed task file");
    }
    assert.match(DEFAULT_GENERATE_PROMPT, /不得将新增任务标记为 FINISHED/);
});

test("all-done output requires two consecutive markers", () => {
    assert.equal(isAllDoneOutput(`done\n${ALL_DONE_OUTPUT}\n`), true);
    assert.equal(isAllDoneOutput(ALL_DONE_MARKER), false);
    assert.equal(isAllDoneOutput(`${ALL_DONE_MARKER}\n${ALL_DONE_MARKER}`), false);
    assert.equal(isAllDoneOutput(`${ALL_DONE_MARKER} ${ALL_DONE_MARKER}`), false);
    assert.equal(isAllDoneOutput("全部任务完成"), false);
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

test("generateTaskMarkdown gives each parent an unfinished plan and nested development steps", () => {
    const content = generateTaskMarkdown({
        title: "Web 应用",
        requirement: "实现 Profile 管理\n实现日志监控",
        createdAt: "2026-06-05T00:00:00.000Z",
    });
    assert.match(content, /^# Web 应用/);
    assert.match(content, /- \[ \] 1\. 实现 Profile 管理/);
    assert.match(content, /完成标准/);
    const taskBlocks = content.split(/(?=^- \[ \] \d+\.)/m).slice(1);
    assert.equal(taskBlocks.length, 2);
    for (const block of taskBlocks) {
        assert.match(block, /^  - 状态：未开始$/m);
        assert.match(block, /^  - 详细方案：.+$/m);
        assert.match(block, /^  - 开发步骤：$/m);
        assert.equal(block.match(/^    - \[ \] \d+\./gm).length, 3);
        assert.doesNotMatch(block, /\[x\]|状态：FINISHED/);
    }
    assert.equal(nextTaskItemNumber(content), 3);
    assert.match(content, /目标任务文件末尾另起一行写入/);
    assert.equal(isAllDoneOutput(content), false);
});

test("generateTaskMarkdown documents media artifact requirements", () => {
    const content = generateTaskMarkdown({
        title: "海报生成",
        requirement: "生成复古海报",
        taskType: "image",
        artifactDirectory: "/tmp/artifacts",
        outputFile: "/tmp/artifacts/result.webp",
        outputFormat: "webp",
        aspectRatio: "3:4",
        resolution: "1536x2048",
        referenceFiles: ["assets/reference.png"],
    });
    assert.match(content, /多模态产物设置/);
    assert.match(content, /任务类型：image/);
    assert.match(content, /result\.webp/);
    assert.match(content, /assets\/reference\.png/);
});

test("appendTaskItemsToMarkdown appends numbered checklist blocks without rewriting old content", () => {
    const original = "# 历史任务\n\n## 任务列表\n\n- [x] 1. 已完成\n";
    const result = appendTaskItemsToMarkdown(original, [
        "新增第一项",
        { text: "新增第二项", completionCriteria: "通过自动化测试" },
    ]);

    assert.equal(result.items.map((item) => item.number).join(","), "2,3");
    assert.equal(result.content.slice(0, original.length), original);
    assert.match(result.content, /- \[ \] 2\. 新增第一项/);
    assert.match(result.content, /- \[ \] 3\. 新增第二项/);
    assert.match(result.content, /完成标准：通过自动化测试/);
    assert.equal(result.content.match(/^  - 详细方案：/gm).length, 2);
    assert.equal(result.content.match(/^    - \[ \] /gm).length, 6);
    assert.equal(nextTaskItemNumber(result.content), 4);
    const next = appendTaskItemsToMarkdown(result.content, ["再次追加"]);
    assert.equal(next.items[0].number, 4);
    assert.ok(next.content.startsWith(result.content));
    assert.equal(nextTaskItemNumber(next.content), 5);
    assert.deepEqual(normalizeTaskItem("  多行\n任务  "), {
        text: "多行 任务",
        completionStandard: "实现并验证该任务项，必要时更新相关文件。",
    });
});

test("appending work clears stale completion markers only when there are new items", () => {
    const history = "# 历史任务\r\n\r\n- [x] 1. 已完成\r\n  - 状态：FINISHED\r\n  - 执行记录：验证通过\r\n";
    const original = `${history}\r\n${ALL_DONE_OUTPUT}\r\n${ALL_DONE_OUTPUT}\r\n`;
    for (const items of [[], ["  "]]) {
        assert.equal(appendTaskItemsToMarkdown(original, items).content, original);
    }
    const result = appendTaskItemsToMarkdown(original, ["后续工作"]);
    assert.equal(isAllDoneOutput(result.content), false);
    assert.ok(result.content.startsWith(history));
    assert.match(result.content, /- \[ \] 2\. 后续工作/);
    assert.equal(result.nextNumber, 3);

    const instructions = `${history}\r\n结束规则：输出 ${ALL_DONE_MARKER} 两遍，不要有间隔。\r\n`;
    assert.ok(appendTaskItemsToMarkdown(instructions, ["后续工作"]).content.startsWith(instructions));
});

test("parent task numbering ignores nested steps and fenced Markdown examples", () => {
    const markdown = [
        "# 任务列表",
        "```markdown",
        "- [ ] 99. 示例任务",
        "```",
        "- [x] 1. 已完成父任务",
        "  - 状态：FINISHED",
        "  - 开发步骤：",
        "    - [x] 20. 已完成子任务",
        "- [ ] 4. 待处理父任务",
        "  - 开发步骤：",
        "    - [ ] 50. 待处理子任务",
        "~~~markdown",
        "- [ ] 100. 另一种围栏中的示例",
        "~~~",
    ].join("\n");
    assert.equal(nextTaskItemNumber(markdown), 5);
    const result = appendTaskItemsToMarkdown(markdown, ["新增父任务"]);
    assert.equal(result.items[0].number, 5);
    assert.equal(nextTaskItemNumber(result.content), 6);
    assert.equal(nextTaskItemNumber("  - [ ] 2. 缩进父任务\n    - [ ] 30. 子任务\n  - [ ] 5. 另一父任务"), 6);
    assert.equal(nextTaskItemNumber("1. [x] 旧任务\n7. [ ] 新任务\n    - [ ] 100. 子任务"), 8);
    assert.equal(nextTaskItemNumber("- [x] 无编号任务\n  - [x] 20. 子任务\n- [ ] 另一任务"), 3);
    assert.equal(nextTaskItemNumber("```markdown\n- [ ] 99. 仅有示例\n```"), 1);
});

test("default codex profile bypasses confirmations", () => {
    const codexProfile = createDefaultProfiles().find((profile) => profile.id === "profile_codex_default");
    assert.ok(codexProfile);
    assert.match(codexProfile.args, new RegExp(CODEX_AUTO_CONFIRM_FLAG));
    assert.equal(codexProfile.provider, "openai");
    assert.deepEqual(codexProfile.outputModalities, ["text"]);
});

test("default profiles use a project-relative working directory", () => {
    for (const profile of createDefaultProfiles()) {
        assert.equal(profile.defaultDirectory, DEFAULT_PROFILE_DIRECTORY);
        assert.equal(path.isAbsolute(profile.defaultDirectory), false);
    }
});
