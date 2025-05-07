#!/usr/bin/env node
// filepath: c:\React\chat_app_backend\stress-test\compare.js
import compareResults from './src/compareResults.js';
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

program
    .name('Compare Benchmark Results')
    .description('Compare two benchmark result files')
    .version('1.0.0')
    .arguments('<file1> <file2>')
    .option('-d, --directory <dir>', 'Directory to search for result files', './results')
    .action(async (file1, file2, options) => {
        const dir = options.directory;

        // Helper function to resolve file paths
        const resolvePath = (filePath) => {
            if (fs.existsSync(filePath)) {
                return filePath;
            }

            // Try with directory prefix
            const withDir = path.join(dir, filePath);
            if (fs.existsSync(withDir)) {
                return withDir;
            }

            // Try with .json extension
            const withExt = filePath.endsWith('.json') ? filePath : `${filePath}.json`;
            if (fs.existsSync(withExt)) {
                return withExt;
            }

            // Try with directory and extension
            const withDirExt = path.join(dir, withExt);
            if (fs.existsSync(withDirExt)) {
                return withDirExt;
            }

            return null;
        };

        // Resolve file paths
        const resolvedFile1 = resolvePath(file1);
        const resolvedFile2 = resolvePath(file2);

        if (!resolvedFile1) {
            console.error(chalk.red(`First file not found: ${file1}`));
            process.exit(1);
        }

        if (!resolvedFile2) {
            console.error(chalk.red(`Second file not found: ${file2}`));
            process.exit(1);
        }

        // Compare the results
        await compareResults(resolvedFile1, resolvedFile2);
    })
    .on('--help', () => {
        console.log('');
        console.log('Examples:');
        console.log('  $ node compare.js light_2025-05-18.json heavy_2025-05-18.json');
        console.log('  $ node compare.js --directory ./results light_2025-05-18 heavy_2025-05-18');
    });

program.parse(process.argv);
