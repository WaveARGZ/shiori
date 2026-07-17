// Copies non-TypeScript renderer assets (HTML/CSS) into the build output.
// Deliberately dependency-free: no bundler, no copy plugin.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'renderer');
const to = join(root, 'dist-electron', 'renderer');

mkdirSync(to, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  cpSync(join(from, file), join(to, file));
  console.log(`copied renderer/${file}`);
}
