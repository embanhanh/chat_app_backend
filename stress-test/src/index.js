#!/usr/bin/env node
// filepath: c:\React\chat_app_backend\stress-test\src\indexEnhanced.js
import { program } from 'commander';
import { StressTest } from './stressTest.js';

// Parse command line arguments with enhanced options
program
    .name('Enhanced Chat App Stress Test')
    .description('Performance testing tool for Chat App WebSocket server with k6-like features')
    .version('1.0.0')
    .option('--url <string>', 'WebSocket server URL', 'ws://localhost')
    .option('--conversation <string>', 'Conversation ID to use', '6810a51046d0da178e288364')
    .option('--messages <number>', 'Messages per client', '10')
    .option('--min-delay <number>', 'Minimum delay between messages (seconds)', '1')
    .option('--max-delay <number>', 'Maximum delay between messages (seconds)', '3')
    .option('--session <number>', 'Session duration (seconds)', '60')
    .option('--token-file <string>', 'File containing tokens', 'tokens_only.json')
    .option('--retry-attempts <number>', 'Maximum connection retry attempts', '3')
    .option('--retry-delay <number>', 'Delay between connection retries (seconds)', '5')
    .option('--stages <string>', 'Test stages in format "duration:target,duration:target"', '60s:1,60s:10,30s:50,120s:50,30s:0')
    .option('--thresholds <string>', 'Threshold checks in format "metric:check,metric:check"', 'message_latency:p(95)<1000,connection_errors_total:count<20')
    .parse();

const options = program.opts();

// Parse stages from command line
function parseStages(stagesStr) {
    try {
        return stagesStr.split(',').map(stage => {
            const [duration, target] = stage.split(':');
            return { duration, target: parseInt(target) };
        });
    } catch (e) {
        console.error('Invalid stages format. Using default stages.');
        return [
            { duration: '60s', target: 1 },
            { duration: '60s', target: 10 },
            { duration: '30s', target: 50 },
            { duration: '120s', target: 50 },
            { duration: '30s', target: 0 }
        ];
    }
}

// Parse thresholds from command line
function parseThresholds(thresholdsStr) {
    try {
        const thresholds = {};
        thresholdsStr.split(',').forEach(threshold => {
            const [metric, check] = threshold.split(':');
            if (!thresholds[metric]) {
                thresholds[metric] = [];
            }
            thresholds[metric].push(check);
        });
        return thresholds;
    } catch (e) {
        console.error('Invalid thresholds format. Using default thresholds.');
        return {
            'message_latency': ['p(95)<1000'],
            'connection_errors_total': ['count<20'],
            'message_processing_errors_total': ['count<20'],
            'rate_echo_received_successfully': ['rate>0.95']
        };
    }
}

// Initialize stress test with provided options
const stressTest = new StressTest({
    serverUrl: options.url,
    conversationId: options.conversation,
    messagesPerClient: parseInt(options.messages),
    delayBetweenMessagesMin: parseFloat(options.minDelay),
    delayBetweenMessagesMax: parseFloat(options.maxDelay),
    sessionDuration: parseInt(options.session),
    tokenFile: options.tokenFile,
    maxConnectionAttempts: parseInt(options.retryAttempts),
    connectionRetryDelay: parseInt(options.retryDelay),
    stages: parseStages(options.stages),
    thresholds: parseThresholds(options.thresholds)
});

// Run the test
stressTest.run().catch(err => {
    console.error('Error during stress test:', err);
    process.exit(1);
});
