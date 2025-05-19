#!/usr/bin/env node
// filepath: c:\React\chat_app_backend\stress-test\benchmark.js
import { StressTest } from './src/stressTest.js';

/**
 * This script demonstrates how to use the enhanced stress test with 
 * predefined stages and thresholds for benchmarking.
 */

// Configuration for a standard benchmark
const config = {
    serverUrl: 'ws://localhost',
    conversationId: '6810a51046d0da178e288364',
    messagesPerClient: 10,
    delayBetweenMessagesMin: 1,
    delayBetweenMessagesMax: 4,
    sessionDuration: 80,
    tokenFile: 'tokens_only.json',
    maxConnectionAttempts: 5,
    connectionRetryDelay: 5,

    // stages configuration
    stages: [
        { duration: '30s', target: 10 }, // Ramp up to 10 users over 30 seconds
        { duration: '60s', target: 50 }, // Hold at 50 users for 60 seconds
        { duration: '30s', target: 100 }, // Ramp up to 100 users over 30 seconds
        { duration: '2m', target: 100 }, // Hold at 100 users for 2 minutes
        { duration: '30s', target: 0 }, // Ramp down to 0 users over 30 seconds
    ],

    // Threshold checks (similar to k6)
    thresholds: {
        'http_req_failed': ['rate<0.01'],         // Less than 1% of HTTP requests should fail
        'ws_connecting': ['p(95)<2000'],          // 95% of WebSocket connections should connect in less than 2 seconds
        'message_latency': ['p(95)<1000'],        // 95% of messages should have latency less than 1000ms
        'connection_errors_total': ['count<20'],  // Less than 20 connection errors allowed
        'message_processing_errors_total': ['count<20'], // Less than 20 message processing errors allowed
        'rate_echo_received_successfully': ['rate>0.95'] // Message echo success rate should be above 95%
    }
};

// Run the benchmark
console.log('Starting benchmark with K6-like staged execution and thresholds...');
const stressTest = new StressTest(config);

stressTest.run().then(results => {
    console.log('Benchmark completed!');

    // Check if all thresholds passed
    const thresholdResults = results.thresholds;
    const allPassed = Object.values(thresholdResults).every(result => result.passed);

    if (allPassed) {
        console.log('✅ All thresholds passed. The system meets performance requirements.');
        process.exit(0);
    } else {
        console.log('❌ Some thresholds failed. The system does not meet performance requirements.');
        // Exit with error code for CI integration
        process.exit(1);
    }
}).catch(err => {
    console.error('Benchmark failed with error:', err);
    process.exit(1);
});
