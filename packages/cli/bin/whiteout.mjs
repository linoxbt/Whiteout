#!/usr/bin/env node
// Runs the TypeScript entry point through tsx so the CLI needs no build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const r = spawnSync(process.execPath, ['--import', 'tsx', main, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
