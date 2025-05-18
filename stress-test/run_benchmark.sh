#!/bin/bash
# filepath: c:\React\chat_app_backend\stress-test\run_benchmark.sh

# This script provides easy execution of different benchmark scenarios

# Default values
SERVER_URL="ws://localhost"
CONVERSATION_ID="6810a51046d0da178e288364"
TOKEN_FILE="tokens_only.json"
OUTPUT_DIR="./results"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Get timestamp for result filenames
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")

# Function to display help
show_help() {
  echo "Usage: ./run_benchmark.sh [options] [scenario]"
  echo
  echo "Options:"
  echo "  -h, --help                 Show this help message"
  echo "  -u, --url <url>            Set server URL (default: ws://localhost)"
  echo "  -c, --conversation <id>    Set conversation ID"
  echo "  -t, --token-file <path>    Set token file path"
  echo
  echo "Available scenarios:"
  echo "  light       - Light load test (10 users max)"
  echo "  moderate    - Moderate load test (50 users max)"
  echo "  heavy       - Heavy load test (100 users max)"
  echo "  spike       - Spike test (quick ramp up to 75 users, then down)"
  echo "  endurance   - Endurance test (moderate load for longer period)"
  echo
  echo "Example:"
  echo "  ./run_benchmark.sh --url ws://example.com moderate"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    -u|--url)
      SERVER_URL="$2"
      shift 2
      ;;
    -c|--conversation)
      CONVERSATION_ID="$2"
      shift 2
      ;;
    -t|--token-file)
      TOKEN_FILE="$2"
      shift 2
      ;;
    -*|--*)
      echo "Unknown option: $1"
      show_help
      exit 1
      ;;
    *)
      SCENARIO="$1"
      shift
      ;;
  esac
done

# Check if scenario is provided
if [ -z "$SCENARIO" ]; then
  echo "Error: No scenario specified."
  show_help
  exit 1
fi

# Set benchmark parameters based on scenario
case "$SCENARIO" in
  light)
    echo "Running light load test scenario..."
    STAGES="30s:1,30s:5,1m:10,1m:10,30s:0"
    MESSAGES_PER_CLIENT=5
    MIN_DELAY=0.5
    MAX_DELAY=2
    ;;
  moderate)
    echo "Running moderate load test scenario..."
    STAGES="1m:1,1m:25,1m:50,2m:50,1m:0"
    MESSAGES_PER_CLIENT=10
    MIN_DELAY=1
    MAX_DELAY=3
    ;;
  heavy)
    echo "Running heavy load test scenario..."
    STAGES="1m:1,2m:50,1m:100,3m:100,1m:0"
    MESSAGES_PER_CLIENT=15
    MIN_DELAY=0.5
    MAX_DELAY=2
    ;;
  spike)
    echo "Running spike test scenario..."
    STAGES="30s:1,30s:75,1m:75,30s:0"
    MESSAGES_PER_CLIENT=5
    MIN_DELAY=0.2
    MAX_DELAY=1
    ;;
  endurance)
    echo "Running endurance test scenario..."
    STAGES="2m:1,3m:30,10m:30,1m:0"
    MESSAGES_PER_CLIENT=20
    MIN_DELAY=2
    MAX_DELAY=5
    ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    show_help
    exit 1
    ;;
esac

# Execute the benchmark
echo "Starting benchmark with the following configuration:"
echo "Server URL: $SERVER_URL"
echo "Conversation ID: $CONVERSATION_ID"
echo "Stages: $STAGES"
echo "Messages per client: $MESSAGES_PER_CLIENT"
echo "Delay between messages: $MIN_DELAY-$MAX_DELAY seconds"
echo "Token file: $TOKEN_FILE"
echo

node src/indexEnhanced.js \
  --url "$SERVER_URL" \
  --conversation "$CONVERSATION_ID" \
  --messages "$MESSAGES_PER_CLIENT" \
  --min-delay "$MIN_DELAY" \
  --max-delay "$MAX_DELAY" \
  --token-file "$TOKEN_FILE" \
  --stages "$STAGES"

# Check if benchmark was successful
if [ $? -eq 0 ]; then
  echo
  echo "Benchmark completed successfully!"
  # Copy the most recent results file to the results directory with scenario name
  LATEST_RESULTS=$(ls -t stress_test_results_*.json | head -1)
  if [ -n "$LATEST_RESULTS" ]; then
    cp "$LATEST_RESULTS" "$OUTPUT_DIR/${SCENARIO}_${TIMESTAMP}.json"
    echo "Results saved to $OUTPUT_DIR/${SCENARIO}_${TIMESTAMP}.json"
  fi
else
  echo
  echo "Benchmark failed!"
fi
