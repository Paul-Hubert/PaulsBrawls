# Supervisor wake-up digest: new-since-last-offset view of the village run.
# Reads/updates supervisor/state.json offsets. Output is intentionally compact —
# full logs stay on disk for targeted investigation.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$mcp  = Join-Path $root 'minecraft-mcp-server'
$statePath = Join-Path $PSScriptRoot 'state.json'

$state = @{ villageLog = ''; villageOffset = 0; skillsLog = ''; skillsOffset = 0 }
if (Test-Path $statePath) {
    $loaded = Get-Content $statePath -Raw | ConvertFrom-Json
    foreach ($k in @('villageLog','villageOffset','skillsLog','skillsOffset')) {
        if ($null -ne $loaded.$k) { $state[$k] = $loaded.$k }
    }
    # Preserve run bookkeeping keys managed by the supervisor itself.
    foreach ($p in $loaded.PSObject.Properties) {
        if (-not $state.ContainsKey($p.Name)) { $state[$p.Name] = $p.Value }
    }
}

function Read-NewTail($file, $offset) {
    if (-not (Test-Path $file)) { return @{ text = ''; offset = 0 } }
    $len = (Get-Item $file).Length
    if ($offset -gt $len) { $offset = 0 }  # file rotated/truncated
    if ($len -eq $offset) { return @{ text = ''; offset = $len } }
    $fs = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
    try {
        $null = $fs.Seek($offset, 'Begin')
        $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
    } finally { $fs.Close() }
    return @{ text = $text; offset = $len }
}

# --- village log (newest file wins; reset offset on rotation) ---
$latestLog = Get-ChildItem (Join-Path $mcp 'logs\village-*.log') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestLog) {
    if ($state.villageLog -ne $latestLog.FullName) { $state.villageLog = $latestLog.FullName; $state.villageOffset = 0 }
    $r = Read-NewTail $latestLog.FullName $state.villageOffset
    $state.villageOffset = $r.offset
    $lines = $r.text -split "`n"
    $total = $lines.Count
    $interesting = $lines | Where-Object { $_ -match '\[error\]|\[warn\]|FAILED|ERROR|DISABLED|unhandled|exception|kicked|installed reflex|wrote skill|benchmark:|voix divine|→ .*: ' -and $_ -notmatch 'act .* ok ' }
    Write-Output "=== VILLAGE LOG: $($latestLog.Name) — $total new lines, $($interesting.Count) flagged ==="
    if ($interesting.Count -gt 120) {
        Write-Output "(showing tally of $($interesting.Count) flagged lines, then last 40)"
        $interesting | ForEach-Object { ($_ -replace '^\S+ ','' ) -replace 'after \d+ms','after Nms' } | Group-Object | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object { "{0,4}x {1}" -f $_.Count, $_.Name.Substring(0, [Math]::Min(150, $_.Name.Length)) }
        $interesting | Select-Object -Last 40
    } else {
        $interesting
    }
} else {
    Write-Output '=== VILLAGE LOG: none found ==='
}

# --- skill audit ---
$latestSkills = Get-ChildItem (Join-Path $mcp 'logs\skills-*.jsonl') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestSkills) {
    if ($state.skillsLog -ne $latestSkills.FullName) { $state.skillsLog = $latestSkills.FullName; $state.skillsOffset = 0 }
    $r = Read-NewTail $latestSkills.FullName $state.skillsOffset
    $state.skillsOffset = $r.offset
    Write-Output "=== SKILL EVENTS: $($latestSkills.Name) (new) ==="
    foreach ($line in ($r.text -split "`n" | Where-Object { $_.Trim() })) {
        $e = $line | ConvertFrom-Json
        $err = if ($e.error) { " err=$($e.error.Substring(0, [Math]::Min(110, $e.error.Length)))" } else { '' }
        Write-Output "$($e.t) $($e.bot) $($e.event) '$($e.name)' v$($e.version)$err"
    }
}

# --- benchmark + status ---
try {
    $m = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/village/metrics' -TimeoutSec 5
    $v = $m.village
    Write-Output "=== BENCHMARK === acquired=$($v.foodAcquired) held=$($v.foodHeld) chest~$($v.chestFoodEstimate) deposited=$($v.foodDeposited) withdrawn=$($v.foodWithdrawn) deaths=$($v.deaths) uptime=$($m.uptimeSeconds)s"
    foreach ($p in $m.bots.PSObject.Properties) {
        $items = ($p.Value.perItem.PSObject.Properties | ForEach-Object { "$($_.Name):$($_.Value)" }) -join ','
        Write-Output "  $($p.Name): acquired=$($p.Value.foodAcquired) held=$($p.Value.foodHeld) deaths=$($p.Value.deaths) [$items]"
    }
} catch { Write-Output "=== BENCHMARK === metrics UNREACHABLE: $($_.Exception.Message)" }

try {
    $s = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/village/status' -TimeoutSec 5
    $bots = ($s.bots | ForEach-Object { "$($_.name)[$($_.state)$(if ($_.job) { ",job=$($_.job)" })$(if ($_.inConversation) { ',talking' })]" }) -join ' '
    Write-Output "=== STATUS === sched: pend=$($s.scheduler.pending) infl=$($s.scheduler.inFlight) done=$($s.scheduler.completed) drop=$($s.scheduler.dropped) paused=$($s.scheduler.paused) | $bots"
} catch { Write-Output "=== STATUS === admin API UNREACHABLE: $($_.Exception.Message)" }

$state | ConvertTo-Json | Out-File -Encoding utf8 $statePath
