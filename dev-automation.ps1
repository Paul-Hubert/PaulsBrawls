# Paul's Brawls - Development Automation Script
# This script provides automated build, test, and restart functionality

param(
    [string]$Action = "help",
    [string]$ServerPath = "",
    [string]$ClientPath = "",
    [switch]$Watch = $false,
    [switch]$Verbose = $false
)

# Configuration
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$GRADLEW = Join-Path $PROJECT_ROOT "gradlew.bat"
$BUILD_DIR = Join-Path $PROJECT_ROOT "build"
$MOD_JAR = Join-Path $BUILD_DIR "libs\paulsbrawls-1.0.0.jar"

# Default paths (update these to match your setup)
$DEFAULT_SERVER_MODS = "$env:APPDATA\.minecraft\mods"
$DEFAULT_CLIENT_MODS = "$env:APPDATA\.minecraft\mods"

function Write-ColorOutput {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

function Test-Command {
    param([string]$Command)
    try {
        & $Command --version 2>$null
        return $true
    } catch {
        return $false
    }
}

function Build-Project {
    Write-ColorOutput "🔨 Building project..." "Yellow"
    
    if (-not (Test-Path $GRADLEW)) {
        Write-ColorOutput "❌ Gradle wrapper not found at $GRADLEW" "Red"
        return $false
    }
    
    try {
        Push-Location $PROJECT_ROOT
        & $GRADLEW clean build --no-daemon
        $buildSuccess = $LASTEXITCODE -eq 0
        
        if ($buildSuccess) {
            Write-ColorOutput "✅ Build successful!" "Green"
            return $true
        } else {
            Write-ColorOutput "❌ Build failed!" "Red"
            return $false
        }
    } catch {
        Write-ColorOutput "❌ Build error: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Test-Project {
    Write-ColorOutput "🧪 Running tests..." "Yellow"
    
    try {
        Push-Location $PROJECT_ROOT
        & $GRADLEW test --no-daemon
        $testSuccess = $LASTEXITCODE -eq 0
        
        if ($testSuccess) {
            Write-ColorOutput "✅ Tests passed!" "Green"
        } else {
            Write-ColorOutput "❌ Tests failed!" "Red"
        }
        return $testSuccess
    } catch {
        Write-ColorOutput "❌ Test error: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Start-MinecraftServer {
    param([string]$ServerPath)
    
    if (-not (Test-Path $ServerPath)) {
        Write-ColorOutput "❌ Server path not found: $ServerPath" "Red"
        return $false
    }
    
    Write-ColorOutput "🚀 Starting Minecraft server..." "Yellow"
    
    try {
        Push-Location $ServerPath
        Start-Process -FilePath "java" -ArgumentList "-Xmx2G", "-Xms1G", "-jar", "server.jar", "nogui" -WindowStyle Minimized
        Write-ColorOutput "✅ Server started!" "Green"
        return $true
    } catch {
        Write-ColorOutput "❌ Failed to start server: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Stop-MinecraftServer {
    Write-ColorOutput "🛑 Stopping Minecraft server..." "Yellow"
    
    try {
        $serverProcesses = Get-Process -Name "java" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*server*" -or $_.CommandLine -like "*server.jar*" }
        
        if ($serverProcesses) {
            $serverProcesses | Stop-Process -Force
            Write-ColorOutput "✅ Server stopped!" "Green"
        } else {
            Write-ColorOutput "ℹ️ No server process found" "Cyan"
        }
        return $true
    } catch {
        Write-ColorOutput "❌ Failed to stop server: $($_.Exception.Message)" "Red"
        return $false
    }
}

function Watch-Files {
    Write-ColorOutput "👀 Watching for file changes..." "Yellow"
    Write-ColorOutput "Press Ctrl+C to stop watching" "Cyan"
    
    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = Join-Path $PROJECT_ROOT "src"
    $watcher.Filter = "*.java"
    $watcher.IncludeSubdirectories = $true
    $watcher.EnableRaisingEvents = $true
    
    $action = {
        $path = $Event.SourceEventArgs.FullPath
        $changeType = $Event.SourceEventArgs.ChangeType
        $timestamp = Get-Date -Format "HH:mm:ss"
        
        Write-ColorOutput "[$timestamp] File $changeType`: $path" "Cyan"
        
        # Debounce: wait 2 seconds before rebuilding
        Start-Sleep -Seconds 2
        
        Write-ColorOutput "🔄 Auto-rebuilding..." "Yellow"
        if (Build-Project) {
            if ($ServerPath -and (Test-Path $ServerPath))) {
                Copy-Mod (Join-Path $ServerPath "mods")
                Write-ColorOutput "🔄 Mod updated in server!" "Green"
            }
            if ($ClientPath -and (Test-Path $ClientPath)) {
                Copy-Mod (Join-Path $ClientPath "mods")
                Write-ColorOutput "🔄 Mod updated in client!" "Green"
            }
        }
    }
    
    Register-ObjectEvent -InputObject $watcher -EventName "Changed" -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $action | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName "Deleted" -Action $action | Out-Null
    
    try {
        while ($true) {
            Start-Sleep -Seconds 1
        }
    } finally {
        $watcher.Dispose()
        Get-EventSubscriber | Unregister-Event
    }
}

function Show-Help {
    Write-ColorOutput "Paul's Brawls - Development Automation" "Cyan"
    Write-ColorOutput "=====================================" "Cyan"
    Write-ColorOutput ""
    Write-ColorOutput "Usage: .\dev-automation.ps1 -Action <action> [options]" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Actions:" "Yellow"
    Write-ColorOutput "  build          - Build the project" "White"
    Write-ColorOutput "  test           - Run tests" "White"
    Write-ColorOutput "  build-test     - Build and test" "White"
    Write-ColorOutput "  deploy         - Build and copy to mods folder" "White"
    Write-ColorOutput "  restart-server - Stop server, build, copy mod, start server" "White"
    Write-ColorOutput "  watch          - Watch files and auto-rebuild" "White"
    Write-ColorOutput "  clean          - Clean build directory" "White"
    Write-ColorOutput "  help           - Show this help" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Options:" "Yellow"
    Write-ColorOutput "  -ServerPath <path>  - Path to Minecraft server directory" "White"
    Write-ColorOutput "  -ClientPath <path>  - Path to Minecraft client mods directory" "White"
    Write-ColorOutput "  -Watch              - Enable file watching (for watch action)" "White"
    Write-ColorOutput "  -Verbose            - Enable verbose output" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Examples:" "Yellow"
    Write-ColorOutput "  .\dev-automation.ps1 -Action build" "White"
    Write-ColorOutput "  .\dev-automation.ps1 -Action deploy -ServerPath 'C:\Minecraft\Server'" "White"
    Write-ColorOutput "  .\dev-automation.ps1 -Action watch -ServerPath 'C:\Minecraft\Server'" "White"
}

# Main execution
switch ($Action.ToLower()) {
    "build" {
        Build-Project
    }
    "test" {
        Test-Project
    }
    "build-test" {
        if (Build-Project) {
            Test-Project
        }
    }
    "deploy" {
        if (Build-Project) {
            $serverModsPath = if ($ServerPath) { Join-Path $ServerPath "mods" } else { $DEFAULT_SERVER_MODS }
            $clientModsPath = if ($ClientPath) { Join-Path $ClientPath "mods" } else { $DEFAULT_CLIENT_MODS }
            
            Copy-Mod $serverModsPath
            Copy-Mod $clientModsPath
        }
    }
    "restart-server" {
        if ($ServerPath) {
            Stop-MinecraftServer
            if (Build-Project) {
                Copy-Mod (Join-Path $ServerPath "mods")
                Start-MinecraftServer $ServerPath
            }
        } else {
            Write-ColorOutput "❌ ServerPath required for restart-server action" "Red"
        }
    }
    "watch" {
        Watch-Files
    }
    "clean" {
        Write-ColorOutput "🧹 Cleaning build directory..." "Yellow"
        try {
            Push-Location $PROJECT_ROOT
            & $GRADLEW clean
            Write-ColorOutput "✅ Clean completed!" "Green"
        } catch {
            Write-ColorOutput "❌ Clean failed: $($_.Exception.Message)" "Red"
        } finally {
            Pop-Location
        }
    }
    "help" {
        Show-Help
    }
    default {
        Write-ColorOutput "❌ Unknown action: $Action" "Red"
        Show-Help
    }
}
