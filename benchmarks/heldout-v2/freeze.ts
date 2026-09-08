import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { array } from './data.js';
import {
  buildManifest,
  DATA_PATH,
  git,
  MANIFEST_PATH,
  requireProtocolCommit,
} from './integrity.js';
const root = resolve(import.meta.dirname, '../../..');
if (process.argv.length !== 2) throw new Error('The freeze generator takes no arguments.');
requireProtocolCommit(root);
if (git(root, ['log', '--diff-filter=A', '--format=%H', '--', MANIFEST_PATH]) !== '')
  throw new Error('A committed freeze must never be regenerated.');
const raw = array(JSON.parse(readFileSync(resolve(root, DATA_PATH), 'utf8')));
const manifest = buildManifest(root, raw, new O200kBaseTokenizer());
writeFileSync(resolve(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write('Static freeze prepared. Commit it before first compiler execution.\n');
