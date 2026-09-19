const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ALL_DONE_MARKER, ALL_DONE_OUTPUT } = require("../lib/core");

const bashCommand = process.platform === "win32"
    ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
const shells = [
    { name: "PowerShell", command: process.platform === "win32" ? "powershell.exe" : "pwsh", probeArgs: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] },
    { name: "Bash", command: bashCommand, probeArgs: ["--version"] },
];

const scenarios = [
    { name: "file completion without an output marker", marker: ALL_DONE_OUTPUT, runs: 1 },
    { name: "file completion before a 429 failure", marker: ALL_DONE_OUTPUT, output: "429 rate limit", exitCode: 1, runs: 1 },
    { name: "output completion remains supported", output: ALL_DONE_OUTPUT, runs: 1 },
    { name: "a single marker is incomplete", marker: ALL_DONE_MARKER, output: ALL_DONE_MARKER, runs: 3 },
    { name: "a space between markers is incomplete", marker: `${ALL_DONE_MARKER} ${ALL_DONE_MARKER}`, output: `${ALL_DONE_MARKER} ${ALL_DONE_MARKER}`, runs: 3 },
    { name: "a newline between markers is incomplete", marker: `${ALL_DONE_MARKER}\n${ALL_DONE_MARKER}`, output: `${ALL_DONE_MARKER}\n${ALL_DONE_MARKER}`, runs: 3 },
];

for (const shell of shells) {
    const probe = childProcess.spawnSync(shell.command, shell.probeArgs, {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
    });
    test(`${shell.name} loop checks consecutive completion markers`, { skip: probe.status !== 0 }, async (t) => {
        for (const scenario of scenarios) {
            await t.test(scenario.name, (t) => {
                const tempParent = fs.realpathSync(os.tmpdir());
                const tempRoot = fs.mkdtempSync(path.join(tempParent, "claude-loop-script-"));
                t.after(() => {
                    assert.equal(path.dirname(tempRoot), tempParent);
                    fs.rmSync(tempRoot, { recursive: true, force: true });
                });
                fs.writeFileSync(path.join(tempRoot, "claude_loop_task.md"), "# task\n", "utf8");

                let args;
                if (shell.name === "PowerShell") {
                    const agentPath = path.join(tempRoot, "mock-agent.ps1");
                    fs.writeFileSync(agentPath, [
                        "$count = 0",
                        "if (Test-Path -LiteralPath 'invocations.txt') { $count = [int](Get-Content -LiteralPath 'invocations.txt' -Raw) }",
                        "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'invocations.txt'), [string]($count + 1))",
                        "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'claude_loop_task.md'), $env:CLAUDE_LOOP_TEST_CONTENT, [System.Text.Encoding]::UTF8)",
                        "Write-Output $env:CLAUDE_LOOP_TEST_OUTPUT",
                        "exit ([int]$env:CLAUDE_LOOP_TEST_EXIT_CODE)",
                        "",
                    ].join("\n"), "utf8");
                    args = [
                        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                        "-File", path.join(__dirname, "..", "claude_loop.ps1"),
                        "-AgentCommand", agentPath,
                        "-RateLimitWaitSeconds", "0",
                        "-TaskDoneWaitSeconds", "0",
                        "-RetryWaitSeconds", "0",
                    ];
                } else {
                    const binDir = path.join(tempRoot, "bin");
                    fs.mkdirSync(binDir);
                    fs.writeFileSync(path.join(binDir, "claude"), [
                        "#!/bin/bash",
                        "count=0",
                        "if [ -f invocations.txt ]; then count=$(cat invocations.txt); fi",
                        "printf '%s' \"$((count + 1))\" > invocations.txt",
                        "printf '%s' \"$CLAUDE_LOOP_TEST_CONTENT\" > claude_loop_task.md",
                        "printf '%s\\n' \"$CLAUDE_LOOP_TEST_OUTPUT\"",
                        "exit \"$CLAUDE_LOOP_TEST_EXIT_CODE\"",
                        "",
                    ].join("\n"), { encoding: "utf8", mode: 0o755 });
                    fs.writeFileSync(path.join(binDir, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
                    args = [
                        "--noprofile", "--norc", "-c",
                        'export PATH="$PWD/bin:$PATH"\nexec bash "$1"',
                        "loop-test", path.join(__dirname, "..", "claude_loop.sh").replace(/\\/g, "/"),
                    ];
                }

                const result = childProcess.spawnSync(shell.command, args, {
                    cwd: tempRoot,
                    encoding: "utf8",
                    timeout: 10000,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        CLAUDE_LOOP_TEST_CONTENT: `# task\n\n${scenario.marker || ""}\n`,
                        CLAUDE_LOOP_TEST_OUTPUT: scenario.output || "ordinary output",
                        CLAUDE_LOOP_TEST_EXIT_CODE: String(scenario.exitCode || 0),
                    },
                });
                assert.ifError(result.error);
                assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
                const invocations = fs.readFileSync(path.join(tempRoot, "invocations.txt"), "utf8");
                assert.equal(Number(invocations), scenario.runs, `${result.stdout}\n${result.stderr}`);
            });
        }
    });
}
