import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { array } from './data.js';
import { buildManifest, DATA_PATH, git, MANIFEST_PATH } from './integrity.js';

const root = resolve(import.meta.dirname, '../../..');
if (process.argv.length !== 2) throw new Error('The freeze generator takes no arguments.');
if (git(root, ['log', '--diff-filter=A', '--format=%H', '--', MANIFEST_PATH]) !== '')
  throw new Error('A committed freeze must not be regenerated.');
const cases = array(JSON.parse(readFileSync(resolve(root, DATA_PATH), 'utf8')));
const manifest = buildManifest(root, cases);
writeFileSync(resolve(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(
  'Freeze manifest prepared. Commit it before the first held-out compiler execution.\n',
);
