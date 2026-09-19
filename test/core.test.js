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
    DEFAULT_TIMEOUT_SECONDS,
    FABLE_5_PRICING,
    LOOP_TIMING,
    MAX_TASK_CYCLES,
    RUN_TOKEN_PATTERN,
    appendTaskCycle,
    appendTaskItemsToMarkdown,
    configEnvForProfile,
    createTaskLogEvent,
    createTerminalLogger,
    createDefaultProfiles,
    createRunToken,
    createStreamJsonRenderer,
    ensureRunTokenInstruction,
    estimateCycleCostUsd,
    extractUsageFromOutput,
    failureBackoffMs,
    fillTemplate,
    formatTerminalLogLine,
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
    renderStreamJsonLine,
    resolveTerminalLogLevel,
    safeTaskFileName,
    summarizeTaskCycles,
    taskFileHasRunToken,
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

test("resolveTerminalLogLevel falls back to info for unknown values", () => {
    assert.equal(resolveTerminalLogLevel(undefined), "info");
    assert.equal(resolveTerminalLogLevel(" DEBUG "), "debug");
    assert.equal(resolveTerminalLogLevel("verbose"), "info");
    assert.equal(resolveTerminalLogLevel("nope", "silent"), "silent");
});

test("formatTerminalLogLine renders timestamp, level, scope and key=value fields", () => {
    const line = formatTerminalLogLine({
        level: "warn",
        scope: "server:task",
        message: "  任务开始 ",
        timestamp: "2026-09-19T00:00:00.000Z",
        fields: { taskId: "task_1", exitCode: 0, skipped: undefined, empty: null, text: "a b\nc", err: new Error("boom"), list: [1, 2] },
    });
    assert.equal(
        line,
        "[2026-09-19T00:00:00.000Z] [WARN ] [server:task] 任务开始 taskId=task_1 exitCode=0 empty=- text=\"a b c\" err=boom list=[1,2]",
    );
});

test("createTerminalLogger filters by level, routes streams and derives child scopes", () => {
    const lines = [];
    const logger = createTerminalLogger({
        level: "info",
        writer: (line, entry) => lines.push({ line, entry }),
        clock: () => "2026-09-19T00:00:00.000Z",
    });
    assert.equal(logger.debug("hidden"), false);
    assert.equal(logger.info("shown", { a: 1 }), true);
    assert.equal(logger.child("http").error("failed", { status: 500 }), true);
    assert.equal(logger.enabled("debug"), false);
    assert.equal(logger.enabled("warn"), true);
    assert.deepEqual(lines.map((item) => item.line), [
        "[2026-09-19T00:00:00.000Z] [INFO ] [server] shown a=1",
        "[2026-09-19T00:00:00.000Z] [ERROR] [server:http] failed status=500",
    ]);
    assert.equal(lines[1].entry.scope, "server:http");

    const silent = createTerminalLogger({ level: "silent", writer: (line) => lines.push({ line }) });
    assert.equal(silent.error("never"), false);
    assert.equal(lines.length, 2);

    const debug = createTerminalLogger({ level: "debug", writer: (line) => lines.push({ line }) });
    assert.equal(debug.debug("visible"), true);
    assert.equal(lines.length, 3);
});

test("run tokens are unique, embedded in the default prompt, and detected only from the task file", () => {
    const token = createRunToken();
    assert.match(token, /^任务\+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(token, createRunToken());
    assert.deepEqual(token.match(RUN_TOKEN_PATTERN), [token]);

    const prompt = fillTemplate(DEFAULT_RUN_PROMPT, { targetFile: "任务.md", runToken: token });
    assert.ok(prompt.includes(`"${token}：<本轮结果描述>"`), "default prompt must tell the agent to write the token");
    assert.match(prompt, /不读取回复文本/);
    assert.equal(ensureRunTokenInstruction(prompt, token, "任务.md"), prompt, "prompts that already carry the token are untouched");

    const custom = ensureRunTokenInstruction("自定义模板：处理 {targetFile}", token, "任务.md");
    assert.match(custom, /^自定义模板：处理 \{targetFile\}\n\n本轮执行凭据规则：/);
    assert.ok(custom.includes(token));
    assert.match(custom, /任务\.md/);
    assert.equal(ensureRunTokenInstruction("no token", "", "x.md"), "no token");

    assert.equal(taskFileHasRunToken(`- [x] 1. 步骤\n  ${token}：已验证\n`, token), true);
    assert.equal(taskFileHasRunToken("- [x] 1. 步骤\n任务完成\n", token), false, "output-style text never counts");
    assert.equal(taskFileHasRunToken(`${token}`, ""), false);
});

test("loop timing enforces a two-minute floor, exponential backoff, and a two-hour timeout default", () => {
    assert.equal(DEFAULT_TIMEOUT_SECONDS, 7200);
    assert.ok(createDefaultProfiles().every((profile) => profile.timeoutSeconds === 7200));
    assert.equal(LOOP_TIMING.minRunIntervalMs, 120000);
    assert.equal(failureBackoffMs(0), 120000);
    assert.equal(failureBackoffMs(1), 120000);
    assert.equal(failureBackoffMs(2), 240000);
    assert.equal(failureBackoffMs(3), 480000);
    assert.equal(failureBackoffMs(6), 3600000, "backoff is capped at one hour");
    assert.equal(failureBackoffMs(20), 3600000);
    assert.equal(failureBackoffMs(3, { failureBackoffBaseMs: 10, failureBackoffMaxMs: 25 }), 25);
});

test("stream-json renderer turns Claude events into readable lines and survives split chunks", () => {
    assert.equal(renderStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", model: "claude", session_id: "s1", tools: ["Bash", "Read"] })), "[system] init model=claude session=s1 tools=2");
    assert.equal(renderStreamJsonLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } })), null);
    assert.equal(renderStreamJsonLine("plain text line"), "plain text line");
    assert.equal(renderStreamJsonLine(""), null);
    assert.equal(renderStreamJsonLine(JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "先看任务文件" }, { type: "tool_use", name: "Bash", input: { command: "cat task.md" } }] },
    })), "先看任务文件\n[tool_use] Bash {\"command\":\"cat task.md\"}");
    assert.equal(renderStreamJsonLine(JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "boom" }] }] },
    })), "[tool_error] boom");
    assert.equal(renderStreamJsonLine(JSON.stringify({
        type: "result", subtype: "success", num_turns: 3, duration_ms: 1200, total_cost_usd: 0.1234, usage: { input_tokens: 10, output_tokens: 4 }, result: "done",
    })), "[result] success turns=3 duration=1200ms cost=$0.1234 tokens=in:10 out:4\ndone");

    const renderer = createStreamJsonRenderer();
    const first = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    const second = JSON.stringify({ type: "result", subtype: "success", result: "bye" });
    const combined = `${first}\n${second}`;
    const cut = first.length + 5;
    assert.equal(renderer.push(combined.slice(0, cut)), "hello");
    assert.equal(renderer.push(combined.slice(cut)), "");
    assert.equal(renderer.flush(), "[result] success\nbye");
    assert.equal(renderer.flush(), "");
});

test("usage extraction reads structured output and cost follows Fable 5.1 rates", () => {
    const claude = [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
        "not json",
        JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.42, usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 4000, cache_read_input_tokens: 80000 } }),
    ].join("\n");
    const usage = extractUsageFromOutput(claude);
    assert.deepEqual(usage, { inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 4000, cacheReadTokens: 80000, reportedCostUsd: 0.42, found: true });
    assert.equal(FABLE_5_PRICING.inputPerMillion, 10);
    assert.equal(FABLE_5_PRICING.outputPerMillion, 50);
    assert.equal(FABLE_5_PRICING.cacheWritePerMillion, 12.5);
    assert.equal(FABLE_5_PRICING.cacheReadPerMillion, 0.25);
    // 1000*10 + 200*50 + 4000*12.5 + 80000*0.25 = 10000+10000+50000+20000 = 90000 / 1e6
    assert.equal(estimateCycleCostUsd(usage), 0.09);

    const codex = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 31, cached_input_tokens: 5, output_tokens: 4 } });
    assert.deepEqual(extractUsageFromOutput(codex), { inputTokens: 31, outputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 5, reportedCostUsd: null, found: true });
    assert.equal(extractUsageFromOutput("plain text only").found, false);
    assert.equal(estimateCycleCostUsd(extractUsageFromOutput("plain text only")), 0);
});

test("cycle summaries count outcomes, tokens, cost, elapsed time, and average call interval", () => {
    const task = { cycles: [] };
    appendTaskCycle(task, { startedAt: "2026-09-20T10:00:00Z", endedAt: "2026-09-20T10:05:00Z", durationMs: 300000, success: true, inputTokens: 100, outputTokens: 50, costUsd: 0.0035 });
    appendTaskCycle(task, { startedAt: "2026-09-20T10:07:00Z", endedAt: "2026-09-20T10:08:00Z", durationMs: 60000, success: false, inputTokens: 10, outputTokens: 5, costUsd: 0.00035 });
    appendTaskCycle(task, { startedAt: "2026-09-20T10:11:00Z", endedAt: "2026-09-20T10:12:00Z", durationMs: 60000, success: true, inputTokens: 20, outputTokens: 10, cacheReadTokens: 1000, costUsd: 0.00095 });
    const summary = summarizeTaskCycles(task.cycles);
    assert.equal(summary.cycles, 3);
    assert.equal(summary.successes, 2);
    assert.equal(summary.failures, 1);
    assert.equal(summary.inputTokens, 130);
    assert.equal(summary.outputTokens, 65);
    assert.equal(summary.cacheReadTokens, 1000);
    assert.equal(summary.totalTokens, 1195);
    assert.equal(summary.costUsd, 0.0048);
    assert.equal(summary.elapsedMs, 12 * 60000);
    assert.equal(summary.averageIntervalMs, (7 + 4) / 2 * 60000, "interval is measured between consecutive agent starts");
    assert.equal(summary.averageDurationMs, 140000);
    assert.equal(summary.firstStartedAt, "2026-09-20T10:00:00Z");
    assert.equal(summary.lastEndedAt, "2026-09-20T10:12:00Z");
    assert.equal(summarizeTaskCycles([]).averageIntervalMs, null);

    const bounded = { cycles: [] };
    for (let index = 0; index < MAX_TASK_CYCLES + 5; index += 1) appendTaskCycle(bounded, { startedAt: new Date(index * 1000).toISOString(), success: true });
    assert.equal(bounded.cycles.length, MAX_TASK_CYCLES);
    assert.equal(bounded.cycles[0].startedAt, new Date(5000).toISOString(), "oldest cycles are dropped first");
});
