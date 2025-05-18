# Chat App Stress Testing Tool

This project provides a stress testing tool for a WebSocket-based chat application. It simulates multiple clients sending and receiving messages to measure server performance metrics like latency, throughput, and stability.

## Features

- Simulate multiple simultaneous WebSocket connections
- Measure message latency (response time)
- Track success rates of message delivery
- Monitor server CPU and memory usage during testing
- Generate performance reports with JSON results
- Customize test parameters (number of clients, messages, etc.)
- **NEW** K6-like staged execution to ramp up/down virtual users
- **NEW** Threshold checking for metrics (similar to k6)

## Installation

```bash
# Navigate to the stress-test directory
cd stress-test

# Install dependencies
npm install
```

## Usage

### Standard Test

Run the standard stress test with default parameters:

```bash
npm start
```

Customize test parameters:

```bash
npm start -- --url ws://localhost --conversation <conversation-id> --messages 10 --delay 0.1 --clients 5
```

### Enhanced Test with K6-like Features

Run the enhanced stress test with stage-based VU ramping:

```bash
node src/indexEnhanced.js
```

Customize enhanced test parameters:

```bash
node src/indexEnhanced.js --url ws://localhost --conversation <conversation-id> --stages "30s:1,60s:10,30s:50,60s:50,30s:0"
```

### Command-line Options (Standard Test)

- `--url`: WebSocket server URL (default: `ws://localhost`)
- `--conversation`: Conversation ID to use (default: from configuration)
- `--messages`: Messages per client (default: 10)
- `--delay`: Delay between messages in seconds (default: 0.1)
- `--token-file`: File containing authentication tokens (default: `tokens_only.json`)
- `--clients`: Number of client connections (default: use all available tokens)
- `--timeout`: Timeout before disconnecting in seconds (default: 10)
- `--max-connections`: Maximum concurrent connections (default: 10)

### Command-line Options (Enhanced Test)

- `--url`: WebSocket server URL (default: `ws://localhost`)
- `--conversation`: Conversation ID to use (default: from configuration)
- `--messages`: Messages per client (default: 10)
- `--min-delay`: Minimum delay between messages in seconds (default: 1)
- `--max-delay`: Maximum delay between messages in seconds (default: 3)
- `--session`: Session duration in seconds (default: 60)
- `--token-file`: File containing authentication tokens (default: `tokens_only.json`)
- `--retry-attempts`: Maximum connection retry attempts (default: 3)
- `--retry-delay`: Delay between connection retries in seconds (default: 5)
- `--stages`: Test stages in format "duration:target,duration:target" (default: "60s:1,60s:10,30s:50,120s:50,30s:0")
- `--thresholds`: Threshold checks in format "metric:check,metric:check" (default: "message_latency:p(95)<1000,connection_errors_total:count<20")

### Predefined Benchmark Scenarios

The stress test now includes predefined benchmark scenarios that can be run using:

```bash
npm run benchmark:<scenario>
```

Available scenarios:

- **light**: Light load test (10 users max)
- **moderate**: Moderate load test (50 users max)
- **heavy**: Heavy load test (100 users max)
- **spike**: Spike test (quick ramp up to 75 users, then down)
- **endurance**: Endurance test (moderate load for longer period)

Example:

```bash
npm run benchmark:moderate
```

You can also use the benchmark runner script directly:

```bash
# For PowerShell (Windows)
.\run_benchmark.ps1 moderate

# For Bash (Linux/Mac)
./run_benchmark.sh moderate
```

### Comparing Test Results

You can compare two test result files to analyze performance differences:

```bash
npm run compare results/light_2025-05-18.json results/heavy_2025-05-18.json
```

Or using the script directly:

```bash
node compare.js light_2025-05-18 heavy_2025-05-18
```

## Output

The tool generates:

1. Terminal output with test metrics
2. A JSON file with detailed test results

### Enhanced Test Specific Output

The enhanced test also provides:

1. K6-like stage progress updates
2. Threshold checks output (passed/failed)
3. Detailed metrics including p95 percentile values
4. More comprehensive JSON results with threshold evaluation

## Requirements

- Node.js v14+
- Access to authentication tokens for the chat application
- A running chat server to test against

## How It Works

### Standard Test:

1. The tool connects multiple WebSocket clients to the server
2. Each client joins a conversation and sends messages at regular intervals
3. The tool measures how long it takes for messages to be received
4. System resource usage is monitored during the test
5. Results are collected and displayed in various formats

### Enhanced Test:

1. The tool ramps up virtual users according to the defined stages
2. Each VU connects using WebSocket, authenticates, and joins a conversation
3. Each VU sends messages at random intervals within the configured range
4. The tool tracks detailed metrics for message latency, errors, and success rates
5. At the end of the test, threshold checks are performed against the metrics
6. Results are displayed and stored in a JSON file
