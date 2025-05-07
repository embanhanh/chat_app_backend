import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

/**
 * Compare two benchmark result files to analyze performance differences
 */
async function compareResults(file1Path, file2Path) {
    try {
        // Load result files
        const file1Content = await fs.readFile(file1Path, 'utf8');
        const file2Content = await fs.readFile(file2Path, 'utf8');

        const result1 = JSON.parse(file1Content);
        const result2 = JSON.parse(file2Content);

        const file1Name = path.basename(file1Path);
        const file2Name = path.basename(file2Path);

        console.log(chalk.bgBlue.white(`\n === Comparing Results: ${file1Name} vs ${file2Name} === \n`));

        // Basic test information
        console.log(chalk.yellow('Test Information:'));
        console.log(`${file1Name}: ${new Date(result1.timestamp).toLocaleString()}`);
        console.log(`${file2Name}: ${new Date(result2.timestamp).toLocaleString()}`);

        // Compare performance metrics
        console.log(chalk.yellow('\nPerformance Comparison:'));

        const messageSentDiff = result2.performance.totalSent - result1.performance.totalSent;
        const sentDiffPercent = ((messageSentDiff / result1.performance.totalSent) * 100).toFixed(2);

        console.log(`Total Messages Sent: ${result1.performance.totalSent} → ${result2.performance.totalSent} ` +
            formatDiff(messageSentDiff, sentDiffPercent, true));

        const successRateDiff = result2.performance.successRate - result1.performance.successRate;
        console.log(`Success Rate: ${result1.performance.successRate.toFixed(2)}% → ${result2.performance.successRate.toFixed(2)}% ` +
            formatDiff(successRateDiff, successRateDiff.toFixed(2), true));

        // Compare latency metrics
        console.log(chalk.yellow('\nLatency Comparison:'));

        const avgLatencyDiff = result2.metrics.message_latency.avg - result1.metrics.message_latency.avg;
        const avgLatencyDiffPercent = ((avgLatencyDiff / result1.metrics.message_latency.avg) * 100).toFixed(2);

        console.log(`Average Latency: ${result1.metrics.message_latency.avg.toFixed(2)}ms → ${result2.metrics.message_latency.avg.toFixed(2)}ms ` +
            formatDiff(avgLatencyDiff, avgLatencyDiffPercent, false));

        const p95LatencyDiff = result2.metrics.message_latency.p95 - result1.metrics.message_latency.p95;
        const p95LatencyDiffPercent = ((p95LatencyDiff / result1.metrics.message_latency.p95) * 100).toFixed(2);

        console.log(`P95 Latency: ${result1.metrics.message_latency.p95.toFixed(2)}ms → ${result2.metrics.message_latency.p95.toFixed(2)}ms ` +
            formatDiff(p95LatencyDiff, p95LatencyDiffPercent, false));

        // Compare error metrics
        console.log(chalk.yellow('\nError Metrics Comparison:'));

        const connErrorsDiff = result2.metrics.connection_errors_total.count - result1.metrics.connection_errors_total.count;
        console.log(`Connection Errors: ${result1.metrics.connection_errors_total.count} → ${result2.metrics.connection_errors_total.count} ` +
            formatDiff(connErrorsDiff, '', false));

        const procErrorsDiff = result2.metrics.message_processing_errors_total.count - result1.metrics.message_processing_errors_total.count;
        console.log(`Processing Errors: ${result1.metrics.message_processing_errors_total.count} → ${result2.metrics.message_processing_errors_total.count} ` +
            formatDiff(procErrorsDiff, '', false));

        // Compare threshold results
        console.log(chalk.yellow('\nThresholds Comparison:'));

        for (const [metricName, threshold1] of Object.entries(result1.thresholds)) {
            if (result2.thresholds[metricName]) {
                const status1 = threshold1.passed ? chalk.green('PASSED') : chalk.red('FAILED');
                const status2 = result2.thresholds[metricName].passed ? chalk.green('PASSED') : chalk.red('FAILED');
                console.log(`${metricName}: ${status1} → ${status2}`);
            }
        }

        // Compare system resource usage
        console.log(chalk.yellow('\nSystem Resource Usage:'));

        const cpuDiff = result2.system.avgCpuUsage - result1.system.avgCpuUsage;
        const cpuDiffPercent = ((cpuDiff / result1.system.avgCpuUsage) * 100).toFixed(2);

        console.log(`Avg CPU Usage: ${result1.system.avgCpuUsage.toFixed(1)}% → ${result2.system.avgCpuUsage.toFixed(1)}% ` +
            formatDiff(cpuDiff, cpuDiffPercent, false));

        const memDiff = result2.system.avgMemUsage - result1.system.avgMemUsage;
        const memDiffPercent = ((memDiff / result1.system.avgMemUsage) * 100).toFixed(2);

        console.log(`Avg Memory Usage: ${result1.system.avgMemUsage.toFixed(1)}% → ${result2.system.avgMemUsage.toFixed(1)}% ` +
            formatDiff(memDiff, memDiffPercent, false));

        console.log(chalk.green('\nComparison complete!'));

    } catch (error) {
        console.error(chalk.red(`Error comparing results: ${error.message}`));
        if (error.stack) console.error(chalk.red(error.stack));
    }
}

/**
 * Format a difference value with color coding
 * @param {number} diff - The numerical difference
 * @param {string|number} percent - The percentage difference or empty string
 * @param {boolean} higherIsBetter - Whether higher values are better
 * @returns {string} - Formatted string with color coding
 */
function formatDiff(diff, percent, higherIsBetter) {
    if (diff === 0) return chalk.gray('(no change)');

    const isPositive = diff > 0;
    const changeSymbol = isPositive ? '↑' : '↓';
    const changePercent = percent ? ` (${Math.abs(percent)}%)` : '';

    const changeText = `${changeSymbol} ${Math.abs(diff).toFixed(2)}${changePercent}`;

    if (higherIsBetter) {
        return isPositive ? chalk.green(changeText) : chalk.red(changeText);
    } else {
        return isPositive ? chalk.red(changeText) : chalk.green(changeText);
    }
}

// Check if this script is being run directly
if (process.argv[1].includes('compareResults.js')) {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log('Usage: node compareResults.js <file1.json> <file2.json>');
        process.exit(1);
    }

    compareResults(args[0], args[1]).catch(err => {
        console.error('Failed to compare results:', err);
        process.exit(1);
    });
}

export default compareResults;
