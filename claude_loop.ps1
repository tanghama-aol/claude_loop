param(
    [string]$TaskFile = "claude_loop_task.md",
    [string]$AgentCommand = "claude",
    [string[]]$AgentArguments = @("--dangerously-skip-permissions", "-p"),
    [int]$RateLimitWaitSeconds = 300,
    [int]$TaskDoneWaitSeconds = 10,
    [int]$RetryWaitSeconds = 60,
    [int]$StallLimit = 3
)

$ErrorActionPreference = "Continue"

function ConvertFrom-Utf8Base64 {
    param([string]$Value)
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

$TaskDoneMarker = ConvertFrom-Utf8Base64 "5Lu75Yqh5a6M5oiQ"
$AllDoneText = ConvertFrom-Utf8Base64 "5YWo6YOo5a6M5oiQ"
$AllDoneMarker = "GGGG" + $AllDoneText + "GGGG"
$AllDoneOutput = $AllDoneMarker + $AllDoneMarker

$Prompt = @(
    ("1. Read one task from {0} and work on it. Mark it done when finished. Do not start sub-agents; complete it in the current agent." -f $TaskFile),
    ("2. If successful, update {0}. If failed, do not update it and print the error." -f $TaskFile),
    ("3. If one task is complete, output `"{0}`"." -f $TaskDoneMarker),
    ("4. Only when every task and subtask is complete and verified, append `"{0}`" twice consecutively on one line at the end of {1}, with no spaces or line breaks between the two markers. Do not duplicate an existing completion line. Then output the same two consecutive markers. Do not put the complete marker pair in instructions, examples, or unfinished tasks." -f $AllDoneMarker, $TaskFile)
) -join [Environment]::NewLine

$lastOutput = ""
$sameCount = 0

function Write-LoopLog {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format "yyyy-MM-dd HH:mm:ss")] $Message"
}

function Get-TaskFileHash {
    if (-not (Test-Path -LiteralPath $TaskFile -PathType Leaf)) {
        return ""
    }

    try {
        return (Get-FileHash -LiteralPath $TaskFile -Algorithm MD5 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
        return ""
    }
}

function Test-TaskFileAllDone {
    if (-not (Test-Path -LiteralPath $TaskFile -PathType Leaf)) {
        return $false
    }

    try {
        $content = [string](Get-Content -LiteralPath $TaskFile -Raw -Encoding UTF8 -ErrorAction Stop)
        return $content.Contains($AllDoneOutput)
    } catch {
        return $false
    }
}

function Invoke-Agent {
    $commandInfo = Get-Command $AgentCommand -ErrorAction SilentlyContinue
    if (-not $commandInfo) {
        return @{
            ExitCode = 127
            Output = "Command not found: $AgentCommand"
        }
    }

    try {
        $rawOutput = & $AgentCommand @AgentArguments $Prompt 2>&1
        $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
        return @{
            ExitCode = $exitCode
            Output = (($rawOutput | Out-String).TrimEnd())
        }
    } catch {
        return @{
            ExitCode = 127
            Output = (($_ | Out-String).TrimEnd())
        }
    }
}

while ($true) {
    $hashBefore = Get-TaskFileHash

    Write-LoopLog "Starting $AgentCommand ..."
    $result = Invoke-Agent
    $output = [string]$result.Output
    Write-LoopLog "Exit code: $($result.ExitCode)"
    Write-LoopLog "Output: $output"

    if (Test-TaskFileAllDone) {
        Write-LoopLog "Task file marks all tasks complete; exiting."
        exit 0
    }

    if ($output -match "429") {
        Write-LoopLog "Detected 429; waiting $RateLimitWaitSeconds seconds before retry."
        Start-Sleep -Seconds $RateLimitWaitSeconds
        continue
    }

    if ($output.Contains($AllDoneOutput)) {
        Write-LoopLog "All tasks are complete; exiting."
        exit 0
    }

    if ($output.Contains($TaskDoneMarker)) {
        Write-LoopLog "Task completed; waiting $TaskDoneWaitSeconds seconds before the next run."
        $lastOutput = $output
        $sameCount = 1
        Start-Sleep -Seconds $TaskDoneWaitSeconds
        continue
    }

    Write-LoopLog "Other result; waiting $RetryWaitSeconds seconds before retry."

    $currentHash = Get-TaskFileHash
    if ($output -eq $lastOutput -and $currentHash -eq $hashBefore) {
        $sameCount += 1
        Write-LoopLog "Same output and unchanged task file: $sameCount/$StallLimit."
    } else {
        $lastOutput = $output
        $sameCount = 1
    }

    if ($sameCount -ge $StallLimit) {
        Write-LoopLog "Output stayed the same and the task file was unchanged for $StallLimit runs; exiting."
        exit 0
    }

    Start-Sleep -Seconds $RetryWaitSeconds
}
