import fs from 'fs/promises';
import { existsSync } from 'fs';
import { io } from 'socket.io-client';
import axios from 'axios';
import path from 'path';
import chalk from 'chalk';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import systeminformation from 'systeminformation';

// For getting the current directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Metrics class for tracking various stats
class Metric {
    constructor(name, type) {
        this.name = name;
        this.type = type; // trend, counter, rate
        this.values = [];
    }

    add(value) {
        if (this.type === 'rate') {
            // For rates, we track success (1) or failure (0)
            this.values.push(value ? 1 : 0);
        } else {
            this.values.push(value);
        }
    }

    get count() {
        return this.values.length;
    }

    get avg() {
        if (this.values.length === 0) return 0;
        return this.values.reduce((a, b) => a + b, 0) / this.values.length;
    }

    get min() {
        if (this.values.length === 0) return 0;
        return Math.min(...this.values);
    }

    get max() {
        if (this.values.length === 0) return 0;
        return Math.max(...this.values);
    }

    get p95() {
        if (this.values.length === 0) return 0;
        const sortedValues = [...this.values].sort((a, b) => a - b);
        const idx = Math.floor(sortedValues.length * 0.95);
        return sortedValues[idx];
    }

    get rate() {
        if (this.values.length === 0) return 0;
        if (this.type !== 'rate') return 0;
        return this.values.filter(v => v === 1).length / this.values.length;
    }
}

export class StressTest {
    constructor(options) {
        // Configuration
        this.serverUrl = options.serverUrl || 'ws://localhost';
        this.conversationId = options.conversationId || '6810a51046d0da178e288364';
        this.messagesPerClient = options.messagesPerClient || 10;
        this.delayBetweenMessagesMin = options.delayBetweenMessagesMin || 1; // seconds
        this.delayBetweenMessagesMax = options.delayBetweenMessagesMax || 3; // seconds
        this.sessionDuration = options.sessionDuration || 60; // seconds
        this.tokenFile = options.tokenFile || 'tokens_only.json';
        this.maxConnectionAttempts = options.maxConnectionAttempts || 3;
        this.connectionRetryDelay = options.connectionRetryDelay || 5; // seconds
        this.timeout = options.timeout || 10000; // ms
        this.clientIdPrefix = '[CID:';
        this.clientIdSuffix = ']';

        // Stage configuration (similar to k6)
        this.stages = options.stages || [
            { duration: '60s', target: 1 },
            { duration: '60s', target: 10 },
            { duration: '30s', target: 50 },
            { duration: '120s', target: 50 },
            { duration: '30s', target: 0 }
        ];

        // Threshold configuration
        this.thresholds = options.thresholds || {
            'http_req_failed': ['rate<0.01'],
            'ws_connecting': ['p(95)<2000'],
            'message_latency': ['p(95)<1000'],
            'connection_errors_total': ['count<20'],
            'message_processing_errors_total': ['count<20'],
            'rate_echo_received_successfully': ['rate>0.95'],
        };

        // Create metrics
        this.metrics = {
            message_latency: new Metric('message_latency', 'trend'),
            server_acknowledgement_counter_total: new Metric('server_acknowledgement_counter_total', 'counter'),
            connection_errors_total: new Metric('connection_errors_total', 'counter'),
            connection_attempts_total: new Metric('connection_attempts_total', 'counter'),
            message_send_attempts_total: new Metric('message_send_attempts_total', 'counter'),
            message_echo_received_total: new Metric('message_echo_received_total', 'counter'),
            all_new_messages_received_total: new Metric('all_new_messages_received_total', 'counter'),
            message_processing_errors_total: new Metric('message_processing_errors_total', 'counter'),
            rate_echo_received_successfully: new Metric('rate_echo_received_successfully', 'rate'),
            http_req_failed: new Metric('http_req_failed', 'rate'),
            ws_connecting: new Metric('ws_connecting', 'trend')
        };

        // Statistics
        this.totalSent = 0;
        this.totalReceived = 0;
        this.cpuUsage = [];
        this.memoryUsage = [];
        this.sendTimestamps = new Map();
        this.conversationSizes = new Map();
        this.latencyByConversation = new Map();
        this.monitoringActive = false;
        this.clients = [];
        this.runningVUs = 0;
        this.startTime = 0;
        this.testDuration = 0;
        this.runCompleted = false;
    }

    async loadTokens() {
        try {
            // Try to load tokens_only.json relative to this file
            const testDir = path.join(dirname(dirname(__dirname)), 'test');

            let tokenFilePath = path.join(testDir, this.tokenFile);

            // If file doesn't exist in test directory, try current directory
            if (!existsSync(tokenFilePath)) {
                tokenFilePath = path.join(process.cwd(), this.tokenFile);
            }

            // If still doesn't exist, check for user_tokens.json
            if (!existsSync(tokenFilePath)) {
                tokenFilePath = path.join(testDir, 'user_tokens.json');
                if (!existsSync(tokenFilePath)) {
                    tokenFilePath = path.join(process.cwd(), 'user_tokens.json');
                }
            }

            if (existsSync(tokenFilePath)) {
                const data = JSON.parse(await fs.readFile(tokenFilePath, 'utf8'));

                if (Array.isArray(data)) {
                    if (typeof data[0] === 'string') {
                        return data;
                    } else if (typeof data[0] === 'object' && data[0].token) {
                        return data.map(user => user.token);
                    }
                }
            }

            console.error(chalk.red('No valid token file found. Please run register_accounts.py first.'));
            return [];
        } catch (error) {
            console.error(chalk.red(`Error loading tokens: ${error.message}`));
            return [];
        }
    }

    async getConversationInfo(conversationId, token) {
        try {
            const url = `${this.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://')}/api/conversations/${conversationId}`;
            console.log(chalk.blue(`Getting conversation info from: ${url}`));

            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });

            console.log(chalk.blue(`API Response status: ${response.status}`));

            if (response.status === 200) {
                const data = response.data;
                const participants = data.participants || [];
                const size = participants.length;
                console.log(chalk.green(`Found ${size} participants in the conversation`));
                this.conversationSizes.set(conversationId, size);
                return size;
            } else {
                console.error(chalk.red(`API Error: ${response.statusText}`));
                this.metrics.http_req_failed.add(1);
            }

            return 0;
        } catch (error) {
            console.error(chalk.red(`Error getting conversation info: ${error.message}`));
            this.metrics.http_req_failed.add(1);
            return 0;
        }
    }

    async monitorSystemResources() {
        while (this.monitoringActive) {
            try {
                // Get CPU and memory information
                const cpu = await systeminformation.currentLoad();
                const mem = await systeminformation.mem();

                const cpuPercent = cpu.currentLoad;
                const memoryPercent = (mem.used / mem.total) * 100;

                this.cpuUsage.push(cpuPercent);
                this.memoryUsage.push(memoryPercent);

                // Wait 1 second before next measurement
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(chalk.red(`Error monitoring system resources: ${error.message}`));
                // Continue monitoring despite errors
            }
        }
    }    async connect(token, vuIndex) {
        const connectionStartTime = Date.now();
        console.log(`VU ${vuIndex}: Connecting to Socket.IO server`);
        
        // Connect directly using Socket.IO client library
        const socket = io(this.serverUrl, {
            transports: ['websocket'],
            auth: { token },
            reconnection: false
        });

        const connectPromise = new Promise((resolve, reject) => {
            const connectTimeout = setTimeout(() => {
                reject(new Error("Connection timeout"));
            }, 10000);

            socket.on('connect', () => {
                clearTimeout(connectTimeout);
                const connectionTime = Date.now() - connectionStartTime;
                this.metrics.ws_connecting.add(connectionTime);
                console.log(`VU ${vuIndex}: Connected successfully`);
                resolve(socket);
            });

            socket.on('connect_error', (error) => {
                clearTimeout(connectTimeout);
                console.error(`VU ${vuIndex}: Connection error: ${error.message}`);
                this.metrics.connection_errors_total.add(1);
                reject(error);
            });
        });

        try {
            this.metrics.connection_attempts_total.add(1);
            return await connectPromise;
        } catch (error) {
            return null;
        }
    }

    createVirtualUser(token, vuIndex) {
        return new Promise(async (resolve) => {
            let socket = null;
            let isActive = true;

            // Try to connect with retries
            for (let attempt = 1; attempt <= this.maxConnectionAttempts && isActive; attempt++) {
                socket = await this.connect(token, vuIndex);

                if (socket) {
                    console.log(chalk.green(`VU ${vuIndex}: Connected successfully on attempt ${attempt}`));
                    break;
                }

                if (attempt < this.maxConnectionAttempts && isActive) {
                    console.log(`VU ${vuIndex}: Retrying connection in ${this.connectionRetryDelay}s (${attempt}/${this.maxConnectionAttempts})`);
                    await new Promise(r => setTimeout(r, this.connectionRetryDelay * 1000));
                } else if (!socket) {
                    console.error(chalk.red(`VU ${vuIndex}: Failed to connect after ${this.maxConnectionAttempts} attempts`));
                    resolve();
                    return;
                }
            }

            if (!socket || !isActive) {
                resolve();
                return;
            }

            let messagesSent = 0;
            let messagesReceived = 0;
            const sentMessagesInfo = new Map();

            // Join conversation
            console.log(chalk.green(`VU ${vuIndex}: Joining conversation: ${this.conversationId}`));
            socket.emit('join_conversation', { data: { conversationId: this.conversationId } });

            // Set up message handling for the socket
            socket.on('new_message', (data) => {
                messagesReceived++;
                this.totalReceived++;
                this.metrics.all_new_messages_received_total.add(1);

                try {
                    const message = data.message || {};
                    const content = message.content || '';

                    // Check if this is one of our messages
                    const cidStartIndex = content.lastIndexOf(this.clientIdPrefix);
                    const cidEndIndex = content.lastIndexOf(this.clientIdSuffix);

                    if (cidStartIndex !== -1 && cidEndIndex !== -1 && cidEndIndex > cidStartIndex) {
                        const extractedClientMsgId = content.substring(
                            cidStartIndex + this.clientIdPrefix.length,
                            cidEndIndex
                        );

                        if (sentMessagesInfo.has(extractedClientMsgId)) {
                            const msgInfo = sentMessagesInfo.get(extractedClientMsgId);
                            if (!msgInfo.echoReceived) {
                                const latency = Date.now() - msgInfo.sendTime;
                                this.metrics.message_latency.add(latency);
                                msgInfo.echoReceived = true;
                                this.metrics.message_echo_received_total.add(1);
                                this.metrics.rate_echo_received_successfully.add(1);
                                sentMessagesInfo.set(extractedClientMsgId, msgInfo);
                                console.log(`VU ${vuIndex}: Echo received for: ${extractedClientMsgId}, latency: ${latency}ms`);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`VU ${vuIndex}: Error processing message: ${e.message}`);
                    this.metrics.message_processing_errors_total.add(1);
                }
            });

            socket.on('message_sent', (data) => {
                if (data && data.messageId) {
                    console.log(`VU ${vuIndex}: Server acknowledged message: ${data.messageId}`);
                    this.metrics.server_acknowledgement_counter_total.add(1);
                }
            });

            socket.on('disconnect', () => {
                console.log(chalk.yellow(`VU ${vuIndex}: Disconnected`));

                // Mark any unsent messages as failed
                for (let [clientTempId, msgInfo] of sentMessagesInfo) {
                    if (!msgInfo.echoReceived) {
                        console.log(`VU ${vuIndex}: No echo received for: ${clientTempId}`);
                        this.metrics.rate_echo_received_successfully.add(0);
                    }
                }

                isActive = false;
                resolve();
            });

            socket.on('error', (error) => {
                console.error(chalk.red(`VU ${vuIndex}: Socket error: ${error}`));
                this.metrics.connection_errors_total.add(1);
            });

            // Send messages at regular intervals
            for (let i = 0; i < this.messagesPerClient && isActive; i++) {
                await new Promise(r => setTimeout(r,
                    (Math.random() * (this.delayBetweenMessagesMax - this.delayBetweenMessagesMin) +
                        this.delayBetweenMessagesMin) * 1000
                ));

                if (!isActive) break;

                const clientGeneratedMessageId = `vu${vuIndex}-msg${i}-${Date.now()}`;
                const messageContent = `Msg ${i + 1} from VU ${vuIndex} ${this.clientIdPrefix}${clientGeneratedMessageId}${this.clientIdSuffix}`;

                this.metrics.message_send_attempts_total.add(1);
                sentMessagesInfo.set(clientGeneratedMessageId, {
                    sendTime: Date.now(),
                    echoReceived: false,
                });

                socket.emit('send_message', {
                    data: {
                        conversationId: this.conversationId,
                        content: messageContent
                    }
                });

                messagesSent++;
                this.totalSent++;
                console.log(`VU ${vuIndex}: Sent message ${i + 1}/${this.messagesPerClient}`);
            }

            // Keep connection active for session duration
            const sessionEndTime = Date.now() + (this.sessionDuration * 1000);

            const interval = setInterval(() => {
                if (!isActive || Date.now() >= sessionEndTime || this.runCompleted) {
                    clearInterval(interval);
                    if (socket.connected) {
                        console.log(`VU ${vuIndex}: Session duration reached, disconnecting`);
                        socket.disconnect();
                    }
                    isActive = false;
                    resolve();
                }
            }, 1000);
        });
    }

    // Calculate and check thresholds
    checkThresholds() {
        const results = {};

        for (const [metricName, thresholdExpressions] of Object.entries(this.thresholds)) {
            if (!this.metrics[metricName]) {
                results[metricName] = { passed: false, reason: 'Metric not found' };
                continue;
            }

            const metric = this.metrics[metricName];
            results[metricName] = { passed: true, checks: [] };

            for (const expression of thresholdExpressions) {
                let check = { expression, passed: false, actual: null };

                // Parse threshold expression (e.g., "p(95)<1000")
                const match = expression.match(/^([\w\d]+)(\((\d+)\))?([<>=]+)([\d\.]+)$/);

                if (!match) {
                    check.passed = false;
                    check.reason = `Invalid threshold expression: ${expression}`;
                    results[metricName].checks.push(check);
                    continue;
                }

                const [_, aggregation, __, percentile, operator, threshold] = match;
                const thresholdValue = parseFloat(threshold);

                let actualValue;
                switch (aggregation) {
                    case 'p':
                        actualValue = metric.p95;  // Only p95 implemented for simplicity
                        break;
                    case 'rate':
                        actualValue = metric.rate;
                        break;
                    case 'count':
                        actualValue = metric.count;
                        break;
                    case 'avg':
                        actualValue = metric.avg;
                        break;
                    case 'max':
                        actualValue = metric.max;
                        break;
                    case 'min':
                        actualValue = metric.min;
                        break;
                    default:
                        actualValue = null;
                }

                check.actual = actualValue;

                // Check if the threshold is met
                if (actualValue !== null) {
                    switch (operator) {
                        case '<':
                            check.passed = actualValue < thresholdValue;
                            break;
                        case '<=':
                            check.passed = actualValue <= thresholdValue;
                            break;
                        case '>':
                            check.passed = actualValue > thresholdValue;
                            break;
                        case '>=':
                            check.passed = actualValue >= thresholdValue;
                            break;
                        case '==':
                        case '=':
                            check.passed = actualValue === thresholdValue;
                            break;
                    }
                }

                results[metricName].checks.push(check);

                if (!check.passed) {
                    results[metricName].passed = false;
                }
            }
        }

        return results;
    }

    // Parse stage duration string (e.g., "30s", "2m") to milliseconds
    parseDuration(durationStr) {
        const match = durationStr.match(/^(\d+)(s|m|h)$/);
        if (!match) return 0;

        const value = parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case 's': return value * 1000;
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            default: return 0;
        }
    }

    // Calculate total test duration from stages configuration
    calculateTotalTestDuration() {
        return this.stages.reduce((total, stage) => {
            return total + this.parseDuration(stage.duration);
        }, 0);
    }

    // Display test results
    displayResults() {
        const testDuration = (Date.now() - this.startTime) / 1000;
        console.log('\n' + chalk.bgBlue.white(' === TEST RESULTS === ') + '\n');

        // Display performance metrics
        console.log(chalk.yellow('Performance Metrics:'));
        console.log(`Total messages sent: ${this.totalSent}`);
        console.log(`Total messages received: ${this.totalReceived}`);

        if (this.totalSent > 0) {
            const successRate = (this.metrics.message_echo_received_total.count / this.totalSent) * 100;
            console.log(`Echo success rate: ${successRate.toFixed(2)}% (${this.metrics.message_echo_received_total.count}/${this.totalSent})`);
        }

        console.log(`Test duration: ${testDuration.toFixed(2)} seconds`);
        console.log(`Send rate: ${(this.totalSent / testDuration).toFixed(2)} msg/s`);
        console.log(`Receive rate: ${(this.totalReceived / testDuration).toFixed(2)} msg/s`);

        // Display latency information
        console.log(chalk.yellow('\nLatency:'));
        console.log(`Average latency: ${this.metrics.message_latency.avg.toFixed(2)}ms`);
        console.log(`Min latency: ${this.metrics.message_latency.min.toFixed(2)}ms`);
        console.log(`Max latency: ${this.metrics.message_latency.max.toFixed(2)}ms`);
        console.log(`p95 latency: ${this.metrics.message_latency.p95.toFixed(2)}ms`);

        // Display resource usage
        const avgCpu = this.cpuUsage.length > 0
            ? this.cpuUsage.reduce((sum, val) => sum + val, 0) / this.cpuUsage.length
            : 0;

        const avgMem = this.memoryUsage.length > 0
            ? this.memoryUsage.reduce((sum, val) => sum + val, 0) / this.memoryUsage.length
            : 0;

        console.log(chalk.yellow('\nResource Usage:'));
        console.log(`Average CPU usage: ${avgCpu.toFixed(1)}%`);
        console.log(`Average memory usage: ${avgMem.toFixed(1)}%`);

        // Display threshold results
        console.log(chalk.yellow('\nThreshold Checks:'));
        const thresholdResults = this.checkThresholds();

        for (const [metricName, result] of Object.entries(thresholdResults)) {
            const status = result.passed ?
                chalk.green('PASSED') :
                chalk.red('FAILED');

            console.log(`${metricName}: ${status}`);

            if (result.checks) {
                for (const check of result.checks) {
                    const checkStatus = check.passed ?
                        chalk.green('✓') :
                        chalk.red('✗');

                    console.log(`  ${checkStatus} ${check.expression} (actual: ${check.actual})`);
                }
            }
        }

        console.log(chalk.green('\nEnhanced stress test completed.'));
    }

    // Save test results to JSON file
    async saveResultsToJson() {
        try {
            const thresholdResults = this.checkThresholds();

            const metricResults = {};
            for (const [name, metric] of Object.entries(this.metrics)) {
                metricResults[name] = {
                    count: metric.count,
                    avg: metric.avg,
                    min: metric.min,
                    max: metric.max,
                    p95: metric.p95,
                    ...(metric.type === 'rate' && { rate: metric.rate })
                };
            }

            const results = {
                testConfig: {
                    serverUrl: this.serverUrl,
                    conversationId: this.conversationId,
                    messagesPerClient: this.messagesPerClient,
                    delayBetweenMessagesMin: this.delayBetweenMessagesMin,
                    delayBetweenMessagesMax: this.delayBetweenMessagesMax,
                    sessionDuration: this.sessionDuration,
                    stages: this.stages
                },
                performance: {
                    totalSent: this.totalSent,
                    totalReceived: this.totalReceived,
                    successRate: this.totalSent > 0 ?
                        (this.metrics.message_echo_received_total.count / this.totalSent) * 100 : 0,
                    duration: (Date.now() - this.startTime) / 1000,
                },
                metrics: metricResults,
                thresholds: thresholdResults,
                system: {
                    avgCpuUsage: this.cpuUsage.length > 0 ?
                        this.cpuUsage.reduce((a, b) => a + b, 0) / this.cpuUsage.length : 0,
                    avgMemUsage: this.memoryUsage.length > 0 ?
                        this.memoryUsage.reduce((a, b) => a + b, 0) / this.memoryUsage.length : 0,
                },
                timestamp: new Date().toISOString()
            };

            const filename = `stress_test_results_${new Date().toISOString().replace(/:/g, '-')}.json`;
            await fs.writeFile(filename, JSON.stringify(results, null, 2));

            console.log(chalk.green(`\nTest results saved to: ${filename}`));

            return filename;
        } catch (error) {
            console.error(chalk.red(`Could not save results to JSON: ${error.message}`));
            return null;
        }
    }

    // Main test execution function
    async run() {
        console.log(chalk.bgBlue.white('\n=== Starting Enhanced WebSocket Stress Test ==='));
        console.log(chalk.blue(`Server URL: ${this.serverUrl}`));
        console.log(chalk.blue(`Conversation ID: ${this.conversationId}`));
        console.log(chalk.blue(`Messages per client: ${this.messagesPerClient}`));
        console.log(chalk.blue(`Delay between messages: ${this.delayBetweenMessagesMin}s - ${this.delayBetweenMessagesMax}s`));

        // Format stages for display
        console.log(chalk.yellow('\nStages:'));
        for (const [i, stage] of this.stages.entries()) {
            console.log(`  Stage ${i + 1}: ${stage.duration} → ${stage.target} VUs`);
        }

        const totalTestDuration = this.calculateTotalTestDuration();
        console.log(chalk.blue(`\nTotal test duration: ${(totalTestDuration / 1000).toFixed(0)}s`));
        console.log(chalk.blue('=====================================\n'));

        // Load tokens
        const tokens = await this.loadTokens();
        if (tokens.length === 0) {
            console.error(chalk.red('No tokens available. Please create token file first.'));
            return;
        }

        // Start system resource monitoring
        this.monitoringActive = true;
        this.monitorSystemResources();

        // Get conversation info
        if (tokens.length > 0) {
            await this.getConversationInfo(this.conversationId, tokens[0]);
        }

        // Start the test
        this.startTime = Date.now();
        let currentVUs = 0;
        let activeVUs = new Map(); // Keep track of active VUs and their promises
        let stageStartTime = Date.now();
        let currentStageIndex = 0;
        let nextTokenIndex = 0;
        this.runCompleted = false;

        // Main test loop that runs until all stages are completed
        while (currentStageIndex < this.stages.length) {
            const stage = this.stages[currentStageIndex];
            const stageDuration = this.parseDuration(stage.duration);
            const targetVUs = stage.target;

            const stageElapsed = Date.now() - stageStartTime;
            const stageProgress = Math.min(stageElapsed / stageDuration, 1);

            // Calculate VU ramping for this stage (linear ramping)
            const prevStageTarget = currentStageIndex > 0 ? this.stages[currentStageIndex - 1].target : 0;
            const targetVUsForCurrentTime = Math.round(
                prevStageTarget + (targetVUs - prevStageTarget) * stageProgress
            );

            // Add or remove VUs to match target
            if (targetVUsForCurrentTime > currentVUs) {
                // Add VUs
                const vusToAdd = Math.min(targetVUsForCurrentTime - currentVUs, tokens.length - nextTokenIndex);

                for (let i = 0; i < vusToAdd && nextTokenIndex < tokens.length; i++) {
                    const vuIndex = nextTokenIndex;
                    const promise = this.createVirtualUser(tokens[vuIndex], vuIndex);
                    activeVUs.set(vuIndex, promise);
                    nextTokenIndex++;
                    currentVUs++;
                }

                console.log(chalk.blue(`Stage ${currentStageIndex + 1} progress: ${Math.round(stageProgress * 100)}%, VUs: ${currentVUs}`));
            } else if (targetVUsForCurrentTime < currentVUs) {
                // For simplicity, we'll just let VUs finish naturally as we don't remove them
                // In a real implementation, you'd want to disconnect some VUs here
                console.log(chalk.blue(`Stage ${currentStageIndex + 1} progress: ${Math.round(stageProgress * 100)}%, VUs: ${currentVUs} (ramping down)`));
            } else {
                // Display progress update every 10% of stage completion
                if (Math.floor(stageProgress * 10) % 2 === 0) {
                    console.log(chalk.blue(`Stage ${currentStageIndex + 1} progress: ${Math.round(stageProgress * 100)}%, VUs: ${currentVUs}`));
                }
            }

            // Clean up completed VUs
            for (const [vuIndex, promise] of activeVUs.entries()) {
                if (promise.status === 'fulfilled') {
                    activeVUs.delete(vuIndex);
                    currentVUs--;
                }
            }

            // Check if stage is complete
            if (stageElapsed >= stageDuration) {
                console.log(chalk.green(`Stage ${currentStageIndex + 1} completed`));
                currentStageIndex++;
                stageStartTime = Date.now();

                // If this was the last stage, exit the loop
                if (currentStageIndex >= this.stages.length) {
                    break;
                }
            }

            // Small sleep to avoid tight loop
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(chalk.green('All stages completed. Waiting for active VUs to finish...'));
        this.runCompleted = true;

        // Wait for all VUs to finish
        await Promise.all(Array.from(activeVUs.values()));

        // Stop system monitoring
        this.monitoringActive = false;

        // Display results
        this.displayResults();

        // Save results to JSON
        await this.saveResultsToJson();

        return {
            metrics: this.metrics,
            thresholds: this.checkThresholds()
        };
    }
}
