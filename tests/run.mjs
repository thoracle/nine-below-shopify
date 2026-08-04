#!/usr/bin/env node
/* Run every suite, report, and exit non-zero if anything failed.
   A suite that cannot fail is a report, not a test — each one below tracks
   assertions and exits accordingly. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort();

let failed = 0;
const results = [];

for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(HERE, s)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(/all (\d+) passed|(\d+) failed, (\d+) passed/);
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ suite: s.replace('.test.mjs', ''), ok, counts: m ? m[0] : 'no summary' });
}

console.log('\n' + '─'.repeat(58));
for (const r of results) {
  console.log(`  ${r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${r.suite.padEnd(14)} ${r.counts}`);
}
console.log('─'.repeat(58));
console.log(failed ? `\n\x1b[31m${failed} of ${suites.length} suites failed\x1b[0m\n`
                   : `\n\x1b[32mall ${suites.length} suites passed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
