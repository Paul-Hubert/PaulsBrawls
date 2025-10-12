# Paul's Brawls - Test Automation Script
# This script provides automated testing functionality

param(
    [string]$TestType = "all",
    [switch]$Verbose = $false,
    [switch]$GenerateReport = $false
)

$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$GRADLEW = Join-Path $PROJECT_ROOT "gradlew.bat"
$TEST_REPORT_DIR = Join-Path $PROJECT_ROOT "build\reports\tests"
$TEST_RESULTS_DIR = Join-Path $PROJECT_ROOT "build\test-results"

function Write-ColorOutput {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

function Run-UnitTests {
    Write-ColorOutput "🧪 Running unit tests..." "Yellow"
    
    try {
        Push-Location $PROJECT_ROOT
        & $GRADLEW test --no-daemon --info
        $testSuccess = $LASTEXITCODE -eq 0
        
        if ($testSuccess) {
            Write-ColorOutput "✅ Unit tests passed!" "Green"
        } else {
            Write-ColorOutput "❌ Unit tests failed!" "Red"
        }
        return $testSuccess
    } catch {
        Write-ColorOutput "❌ Test execution error: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Run-IntegrationTests {
    Write-ColorOutput "🔗 Running integration tests..." "Yellow"
    
    try {
        Push-Location $PROJECT_ROOT
        & $GRADLEW test --tests "*IntegrationTest*" --no-daemon --info
        $testSuccess = $LASTEXITCODE -eq 0
        
        if ($testSuccess) {
            Write-ColorOutput "✅ Integration tests passed!" "Green"
        } else {
            Write-ColorOutput "❌ Integration tests failed!" "Red"
        }
        return $testSuccess
    } catch {
        Write-ColorOutput "❌ Integration test error: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Run-PerformanceTests {
    Write-ColorOutput "⚡ Running performance tests..." "Yellow"
    
    try {
        Push-Location $PROJECT_ROOT
        & $GRADLEW test --tests "*PerformanceTest*" --no-daemon --info
        $testSuccess = $LASTEXITCODE -eq 0
        
        if ($testSuccess) {
            Write-ColorOutput "✅ Performance tests passed!" "Green"
        } else {
            Write-ColorOutput "❌ Performance tests failed!" "Red"
        }
        return $testSuccess
    } catch {
        Write-ColorOutput "❌ Performance test error: $($_.Exception.Message)" "Red"
        return $false
    } finally {
        Pop-Location
    }
}

function Generate-TestReport {
    Write-ColorOutput "📊 Generating test report..." "Yellow"
    
    if (-not (Test-Path $TEST_REPORT_DIR)) {
        Write-ColorOutput "❌ Test report directory not found: $TEST_REPORT_DIR" "Red"
        return $false
    }
    
    try {
        $reportFiles = Get-ChildItem -Path $TEST_REPORT_DIR -Recurse -Filter "*.html"
        
        if ($reportFiles.Count -gt 0) {
            Write-ColorOutput "✅ Test reports generated:" "Green"
            foreach ($file in $reportFiles) {
                Write-ColorOutput "  📄 $($file.FullName)" "Cyan"
            }
        } else {
            Write-ColorOutput "⚠️ No test reports found" "Yellow"
        }
        
        return $true
    } catch {
        Write-ColorOutput "❌ Report generation error: $($_.Exception.Message)" "Red"
        return $false
    }
}

function Show-TestSummary {
    Write-ColorOutput "📋 Test Summary" "Cyan"
    Write-ColorOutput "==============" "Cyan"
    
    if (Test-Path $TEST_RESULTS_DIR) {
        $testResultFiles = Get-ChildItem -Path $TEST_RESULTS_DIR -Recurse -Filter "*.xml"
        Write-ColorOutput "Test result files: $($testResultFiles.Count)" "White"
    }
    
    if (Test-Path $TEST_REPORT_DIR) {
        $reportFiles = Get-ChildItem -Path $TEST_REPORT_DIR -Recurse -Filter "*.html"
        Write-ColorOutput "Test report files: $($reportFiles.Count)" "White"
    }
}

function Show-Help {
    Write-ColorOutput "Paul's Brawls - Test Automation" "Cyan"
    Write-ColorOutput "===============================" "Cyan"
    Write-ColorOutput ""
    Write-ColorOutput "Usage: .\test-automation.ps1 -TestType <type> [options]" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Test Types:" "Yellow"
    Write-ColorOutput "  all           - Run all tests" "White"
    Write-ColorOutput "  unit          - Run unit tests only" "White"
    Write-ColorOutput "  integration   - Run integration tests only" "White"
    Write-ColorOutput "  performance   - Run performance tests only" "White"
    Write-ColorOutput "  report        - Generate test report only" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Options:" "Yellow"
    Write-ColorOutput "  -Verbose            - Enable verbose output" "White"
    Write-ColorOutput "  -GenerateReport     - Generate HTML test report" "White"
    Write-ColorOutput ""
    Write-ColorOutput "Examples:" "Yellow"
    Write-ColorOutput "  .\test-automation.ps1 -TestType all" "White"
    Write-ColorOutput "  .\test-automation.ps1 -TestType unit -Verbose" "White"
    Write-ColorOutput "  .\test-automation.ps1 -TestType report -GenerateReport" "White"
}

# Main execution
$allTestsPassed = $true

switch ($TestType.ToLower()) {
    "all" {
        Write-ColorOutput "🚀 Running complete test suite..." "Cyan"
        
        if (-not (Run-UnitTests)) { $allTestsPassed = $false }
        if (-not (Run-IntegrationTests)) { $allTestsPassed = $false }
        if (-not (Run-PerformanceTests)) { $allTestsPassed = $false }
        
        if ($GenerateReport) {
            Generate-TestReport
        }
        
        Show-TestSummary
    }
    "unit" {
        Run-UnitTests
        if ($GenerateReport) {
            Generate-TestReport
        }
    }
    "integration" {
        Run-IntegrationTests
        if ($GenerateReport) {
            Generate-TestReport
        }
    }
    "performance" {
        Run-PerformanceTests
        if ($GenerateReport) {
            Generate-TestReport
        }
    }
    "report" {
        Generate-TestReport
    }
    default {
        Write-ColorOutput "❌ Unknown test type: $TestType" "Red"
        Show-Help
        exit 1
    }
}

if ($allTestsPassed) {
    Write-ColorOutput "🎉 All tests completed successfully!" "Green"
    exit 0
} else {
    Write-ColorOutput "💥 Some tests failed!" "Red"
    exit 1
}
