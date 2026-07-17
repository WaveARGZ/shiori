// The chrome renderer is loaded as a classic <script>, so its compiled output
// must contain no ESM syntax. tsc emits a bare `export {};` for any file it
// considers a module — including one whose only imports were type-only — and
// that is a hard SyntaxError at load time, which shows up as a blank window
// rather than a build failure. So we check the emitted artifact instead.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'dist-electron', 'renderer', 'renderer.js');
const source = readFileSync(file, 'utf8');

const offenders = source
  .split('\n')
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter(({ line }) => /^(import|export)\b/.test(line) && !/^import\s*\(/.test(line));

if (offenders.length > 0) {
  console.error('renderer.js contains ESM syntax and will not load as a classic script:');
  for (const { line, n } of offenders) console.error(`  renderer.js:${n}: ${line}`);
  console.error('\nUse `type X = import("...").X` type queries instead of import statements.');
  process.exit(1);
}

console.log('renderer.js is import-free (classic-script safe)');
