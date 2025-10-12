# Paul's Brawls - Advanced File Watcher
# This script provides intelligent file watching with debouncing and smart rebuilds

param(
    [string]$WatchPath = "src",
    [string]$ServerPath = "",
    [string]$ClientPath = "",
    [int]$DebounceMs = 2000,
    [switch]$Verbose = $false,
    [switch]$TestOnChange = $false,
    [switch]$AutoRestart = $false
)

$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$GRADLEW = Join-Path $PROJECT_ROOT "gradlew.bat"
$WATCH_DIR = Join-Path $PROJECT_ROOT $WatchPath
$LAST_BUILD_TIME = 0
$BUILD_IN_PROGRESS = $false

# File patterns to watch
$WATCH_PATTERNS = @("*.java", "*.json", "*.gradle", "*.properties")
$IGNORE_PATTERNS = @("*.class", "*.jar", "*.tmp", "*~", "*.swp")

function Write-ColorOutput {
    param([string]$Message, [string]$Color = "White")
    $timestamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$timestamp] $Message" -ForegroundColor $Color
}

function Test-ShouldIgnore {
    param([string]$FilePath)
    
    foreach ($pattern in $IGNORE_PATTERNS) {
        if ($FilePath -like $pattern) {
            return $true
        }
    }
    return $false
}

function Test-ShouldWatch {
    param([string]$FilePath)
    
    foreach ($pattern in $WATCH_PATTERNS) {
        if ($FilePath -like $pattern) {
            return $true
        }
    }
    return $false
}

function Start-Build {
    param([string]$Reason)
    
    if ($BUILD_IN_PROGRESS) {
        Write-ColorOutput "⏳ Build already in progress, skipping..." "Yellow"
        return
    }
    
    $BUILD_IN_PROGRESS = $true
    $LAST_BUILD_TIME = Get-Date
    
    Write-ColorOutput "🔨 Building project ($Reason)..." "Yellow"
    
    try {
        Push-Location $PROJECT_ROOT
        
        if ($TestOnChange) {
            & $GRADLEW devTest --no-daemon
        } else {
            & $GRADLEW devBuild --no-daemon
        }
        
        $buildSuccess = $LASTEXITCODE -eq 0
        
        if ($buildSuccess) {
            Write-ColorOutput "✅ Build successful!" "Green"
            
            # Copy to mods folders if paths are provided
            if ($ServerPath -and (Test-Path $ServerPath)) {
                $serverModsPath = Join-Path $ServerPath "mods"
                if (Test-Path $serverModsPath) {
                    Copy-Item (Join-Path $PROJECT_ROOT "build\libs\paulsbrawls-1.0.0.jar") $serverModsPath -Force
                    Write-ColorOutput "📦 Mod copied to server" "Cyan"
                }
            }
            
            if ($ClientPath -and (Test-Path $ClientPath)) {
                $clientModsPath = Join-Path $ClientPath "mods"
                if (Test-Path $clientModsPath) {
                    Copy-Item (Join-Path $PROJECT_ROOT "build\libs\paulsbrawls-1.0.0.jar") $clientModsPath -Force
                    Write-ColorOutput "📦 Mod copied to client" "Cyan"
                }
            }
            
            if ($AutoRestart -and $ServerPath) {
                Restart-Server
            }
        } else {
            Write-ColorOutput "❌ Build failed!" "Red"
        }
    } catch {
        Write-ColorOutput "❌ Build error: $($_.Exception.Message)" "Red"
    } finally {
        Pop-Location
        $BUILD_IN_PROGRESS = $false
    }
}

function Restart-Server {
    if (-not $ServerPath -or -not (Test-Path $ServerPath)) {
        Write-ColorOutput "⚠️ Server path not configured or not found" "Yellow"
        return
    }
    
    Write-ColorOutput "🔄 Restarting server..." "Yellow"
    
    try {
        # Stop existing server processes
        $serverProcesses = Get-Process -Name "java" -ErrorAction SilentlyContinue | 
            Where-Object { $_.CommandLine -like "*server.jar*" -or $_.MainWindowTitle -like "*server*" }
        
        if ($serverProcesses) {
            $serverProcesses | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
        
        # Start server
        Push-Location $ServerPath
        Start-Process -FilePath "java" -ArgumentList "-Xmx2G", "-Xms1G", "-jar", "server.jar", "nogui" -WindowStyle Minimized
        Write-ColorOutput "🚀 Server restarted!" "Green"
    } catch {
        Write-ColorOutput "❌ Server restart failed: $($_.Exception.Message)" "Red"
    } finally {
        Pop-Location
    }
}

function Start-FileWatcher {
    Write-ColorOutput "👀 Starting intelligent file watcher..." "Cyan"
    Write-ColorOutput "Watching: $WATCH_DIR" "Cyan"
    Write-ColorOutput "Debounce: ${DebounceMs}ms" "Cyan"
    Write-ColorOutput "Test on change: $TestOnChange" "Cyan"
    Write-ColorOutput "Auto restart: $AutoRestart" "Cyan"
    Write-ColorOutput "Press Ctrl+C to stop" "Cyan"
    Write-ColorOutput ""
    
    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $WATCH_DIR
    $watcher.IncludeSubdirectories = $true
    $watcher.EnableRaisingEvents = $true
    
    $pendingChanges = @{}
    $debounceTimer = $null
    
    $action = {
        $path = $Event.SourceEventArgs.FullPath
        $changeType = $Event.SourceEventArgs.ChangeType
        $timestamp = Get-Date -Format "HH:mm:ss"
        
        # Check if we should ignore this file
        if (Test-ShouldIgnore $path) {
            return
        }
        
        # Check if we should watch this file
        if (-not (Test-ShouldWatch $path)) {
            return
        }
        
        # Debounce logic
        $pendingChanges[$path] = $changeType
        
        if ($debounceTimer) {
            $debounceTimer.Dispose()
        }
        
        $debounceTimer = [System.Timers.Timer]::new($DebounceMs)
        $debounceTimer.AutoReset = $false
        $debounceTimer.add_Elapsed({
            $debounceTimer.Dispose()
            $debounceTimer = $null
            
            if ($pendingChanges.Count -gt 0) {
                $changeSummary = ($pendingChanges.Keys | ForEach-Object { "$_ ($($pendingChanges[$_]))" }) -join ", "
                Write-ColorOutput "📝 Files changed: $changeSummary" "Cyan"
                
                Start-Build "File changes detected"
                $pendingChanges.Clear()
            }
        })
        $debounceTimer.Start()
    }
    
    # Register events
    Register-ObjectEvent -InputObject $watcher -EventName "Changed" -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName "Deleted" -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName "Renamed" -Action $action | Out-Null
    
    try {
        while ($true) {
            Start-Sleep -Seconds 1
        }
    } finally {
        if ($debounceTimer) {
            $debounceTimer.Dispose()
        }
        $watcher.Dispose()
        Get-EventSubscriber | Unregister-Event
    }
}

function Show-Help {
    Write-ColorOutput "Paul's Brawls - Advanced File Watcher" "Cyan"
    Write-ColorOutput "====================================" "Cyan"
    Write-ColorOutput ""
    Write-ColorOutput "Usage: .\watch-files.ps1 [options]" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Options:" "Yellow"
    Write-ColorOutput "  -WatchPath <path>     - Directory to watch (default: src)" "White"
    Write-ColorOutput "  -ServerPath <path>    - Minecraft server directory" "White"
    Write-ColorOutput "  -ClientPath <path>    - Minecraft client mods directory" "White"
    Write-ColorOutput "  -DebounceMs <ms>      - Debounce time in milliseconds (default: 2000)" "White"
    Write-ColorOutput "  -TestOnChange         - Run tests on file changes" "White"
    Write-ColorOutput "  -AutoRestart          - Auto-restart server after build" "White"
    Write-ColorOutput "  -Verbose              - Enable verbose output" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Examples:" "Yellow"
    Write-ColorOutput "  .\watch-files.ps1" "White"
    Write-ColorOutput "  .\watch-files.ps1 -ServerPath 'C:\Minecraft\Server' -AutoRestart" "White"
    Write-ColorOutput "  .\watch-files.ps1 -TestOnChange -DebounceMs 3000" "White"
}

# Main execution
if ($args -contains "-h" -or $args -contains "--help") {
    Show-Help
    exit 0
}

if (-not (Test-Path $WATCH_DIR)) {
    Write-ColorOutput "❌ Watch directory not found: $WATCH_DIR" "Red"
    exit 1
}

Start-FileWatcher
