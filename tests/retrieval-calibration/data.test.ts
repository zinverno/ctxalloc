import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import {
  hash,
  loadPublicDataset,
  parseDataset,
  prepareDocument,
} from '../../benchmarks/retrieval-calibration/data.js';

const data = loadPublicDataset();
describe('Phase 22A human annotation provenance and join integrity', () => {
  it('pins the score-blind training subset independently of report metrics', () => {
    expect(hash(JSON.stringify(data))).toBe(
      '7a6deb92da803766b76204d26c0fcddaf388b516f5908e4f0b32c84820d17e82',
    );
    expect(data.queries).toHaveLength(39);
    expect(data.documents.flatMap((d) => d.blocks)).toHaveLength(529);
    expect(data.queries.flatMap((q) => q.irrelevant)).toHaveLength(0);
    expect(data.queries.flatMap((q) => q.facts).filter((f) => !f.blockIds.length)).toHaveLength(8);
  });
  it('preserves the first native FAIL instead of rewriting it after selecting a profile', () => {
    const first = JSON.parse(readFileSync('docs/evidence/phase22a-native-first.json', 'utf8'));
    expect(first.contractChecks).toBe('FAIL');
    expect(first.compilerExecuted).toBe(false);
    expect(first.profileSelected).toBe(false);
    expect(
      first.queries.filter(
        (q: { checks: { permutationStable: boolean } }) => !q.checks.permutationStable,
      ),
    ).toHaveLength(13);
  });
  it('rejects absent human-annotation provenance', () => {
    expect(() => parseDataset({ ...data, labelProvenance: 'model-generated' })).toThrow();
  });
  it('rejects extra source metadata rather than passing it to reports', () => {
    const changed = structuredClone(data);
    Object.assign(changed.documents[0]!, { privateMetadata: 'PRIVATE_CANARY' });
    expect(() => parseDataset(changed)).toThrow();
  });
  it('rejects contradictory positive and negative judgments', () => {
    const changed = structuredClone(data);
    changed.queries[0]!.irrelevant = [...changed.queries[0]!.useful];
    expect(() => parseDataset(changed)).toThrow();
  });
  it('rejects orphan evidence carriers', () => {
    const changed = structuredClone(data);
    changed.queries[0]!.facts[0]!.blockIds = ['absent'];
    expect(() => parseDataset(changed)).toThrow();
  });
  it('rejects duplicate query identity', () => {
    expect(() => parseDataset({ ...data, queries: [data.queries[0], data.queries[0]] })).toThrow();
  });
  it('retains correct provenance offsets in the explicit assembled source document', () => {
    const d = data.documents[0]!,
      prepared = prepareDocument(d, new O200kBaseTokenizer());
    const text = d.blocks.map((b) => b.content).join('\n\n');
    for (const block of prepared.blocks) {
      const location = block.sourceLocation!;
      if (location.kind !== 'text-range') throw new Error();
      expect(text.slice(location.startOffset, location.endOffset)).toBe(block.content);
    }
  });
});
