/**
 * Diffs the upstream `asterisk-core-sounds-es-ulaw` file list against
 * our `catalog.ts` + `passthrough.ts` to make sure we have every
 * file the official pack ships. Prints two lists:
 *
 *   missing  — present upstream, NOT in our pack (must be added!)
 *   extra    — present in our pack, NOT upstream (cosmetic, fine)
 *
 * Run:  npx tsx scripts/sound-pack/diff-upstream.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from './catalog.js';
import { PASSTHROUGH_FILES } from './passthrough.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FILE_LIST = join(ROOT, 'dist', 'sound-pack', '.upstream', 'file-list.txt');

const upstream = readFileSync(FILE_LIST, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const ours = new Set<string>([
  ...CATALOG.filter((i) => i.text).map((i) => i.path),
  ...PASSTHROUGH_FILES,
]);

// upstream has filenames lowercase EXCEPT for vm-Cust1, vm-Family,
// vm-Friends, vm-INBOX, vm-INBOXs, vm-Old, vm-Olds, vm-Urgent,
// vm-Work, digits/1F, digits/1M, ... — match exactly, no folding.
const upstreamSet = new Set(upstream);

const missing = upstream.filter((p) => !ours.has(p));
const extra = [...ours].filter((p) => !upstreamSet.has(p));

console.log(`upstream:  ${upstream.length}`);
console.log(`our pack:  ${ours.size}  (${CATALOG.filter((i) => i.text).length} catalog + ${PASSTHROUGH_FILES.length} passthrough)`);
console.log('');
console.log(`MISSING from our pack (${missing.length}):`);
for (const m of missing) console.log(`  - ${m}`);
console.log('');
console.log(`EXTRA in our pack — not upstream (${extra.length}):`);
for (const e of extra) console.log(`  + ${e}`);
