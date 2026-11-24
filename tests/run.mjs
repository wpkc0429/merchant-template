#!/usr/bin/env node
// Runs every tests/*.test.mjs with node:test (built in, no dependencies). Template-only.
//   node tests/run.mjs            all tests
//   node tests/run.mjs sync       only files whose name contains "sync"
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!filter || f.includes(filter))).map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
