
# This script provides easy execution of different benchmark scenarios for Windows users

# Default values
$serverUrl = "ws://localhost"
$conversationId = "6810a51046d0da178e288364"
$tokenFile = "tokens_only.json"
$outputDir = ".\results"

# Ensure output directory exists
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

# Get timestamp for result filenames
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

# Function to display help
function Show-Help {
    Write-Host "Usage: .\run_benchmark.ps1 [options] [scenario]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Help                    Show this help message"
    Write-Host "  -ServerUrl <url>         Set server URL (default: ws://localhost)"
    Write-Host "  -ConversationId <id>     Set conversation ID"
    Write-Host "  -TokenFile <path>        Set token file path"
    Write-Host ""
    Write-Host "Available scenarios:"
    Write-Host "  light       - Light load test (10 users max)"
    Write-Host "  moderate    - Moderate load test (50 users max)"
    Write-Host "  heavy       - Heavy load test (100 users max)"
    Write-Host "  spike       - Spike test (quick ramp up to 75 users, then down)"
    Write-Host "  endurance   - Endurance test (moderate load for longer period)"
    Write-Host ""
    Write-Host "Example:"
    Write-Host "  .\run_benchmark.ps1 -ServerUrl ws://example.com moderate"
}

# Parse command line arguments
$scenario = $null

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "-Help" { 
            Show-Help
            exit 0
        }
        "-ServerUrl" { 
            $serverUrl = $args[$i + 1]
            $i++
        }
        "-ConversationId" { 
            $conversationId = $args[$i + 1]
            $i++
        }
        "-TokenFile" { 
            $tokenFile = $args[$i + 1]
            $i++
        }
        default {
            if ($null -eq $scenario) {
                $scenario = $args[$i]
            } else {
                Write-Host "Unknown option: $($args[$i])"
                Show-Help
                exit 1
            }
        }
    }
}

# Check if scenario is provided
if ($null -eq $scenario) {
    Write-Host "Error: No scenario specified." -ForegroundColor Red
    Show-Help
    exit 1
}

# Set benchmark parameters based on scenario
switch ($scenario) {
    "light" {
        Write-Host "Running light load test scenario..." -ForegroundColor Cyan
        $stages = "30s:1,30s:5,1m:10,1m:10,30s:0"
        $messagesPerClient = 5
        $minDelay = 0.5
        $maxDelay = 2
    }
    "moderate" {
        Write-Host "Running moderate load test scenario..." -ForegroundColor Cyan
        $stages = "1m:1,1m:25,1m:50,2m:50,1m:0"
        $messagesPerClient = 10
        $minDelay = 1
        $maxDelay = 3
    }
    "heavy" {
        Write-Host "Running heavy load test scenario..." -ForegroundColor Cyan
        $stages = "1m:1,2m:50,1m:100,3m:100,1m:0"
        $messagesPerClient = 15
        $minDelay = 0.5
        $maxDelay = 2
    }
    "spike" {
        Write-Host "Running spike test scenario..." -ForegroundColor Cyan
        $stages = "30s:1,30s:75,1m:75,30s:0"
        $messagesPerClient = 5
        $minDelay = 0.2
        $maxDelay = 1
    }
    "endurance" {
        Write-Host "Running endurance test scenario..." -ForegroundColor Cyan
        $stages = "2m:1,3m:30,10m:30,1m:0"
        $messagesPerClient = 20
        $minDelay = 2
        $maxDelay = 5
    }
    default {
        Write-Host "Unknown scenario: $scenario" -ForegroundColor Red
        Show-Help
        exit 1
    }
}

# Execute the benchmark
Write-Host "Starting benchmark with the following configuration:" -ForegroundColor Green
Write-Host "Server URL: $serverUrl"
Write-Host "Conversation ID: $conversationId"
Write-Host "Stages: $stages"
Write-Host "Messages per client: $messagesPerClient"
Write-Host "Delay between messages: $minDelay-$maxDelay seconds"
Write-Host "Token file: $tokenFile"
Write-Host ""

# Build the command
$command = "node src/indexEnhanced.js --url `"$serverUrl`" --conversation `"$conversationId`" --messages $messagesPerClient --min-delay $minDelay --max-delay $maxDelay --token-file `"$tokenFile`" --stages `"$stages`""

# Execute the command
Write-Host "Executing: $command" -ForegroundColor DarkGray
Invoke-Expression $command

# Check if benchmark was successful
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Benchmark completed successfully!" -ForegroundColor Green
    
    # Copy the most recent results file to the results directory with scenario name
    $latestResults = Get-ChildItem -Path "stress_test_results_*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    
    if ($null -ne $latestResults) {
        $destFile = "$outputDir\${scenario}_${timestamp}.json"
        Copy-Item $latestResults.FullName -Destination $destFile
        Write-Host "Results saved to $destFile" -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "Benchmark failed!" -ForegroundColor Red
}
