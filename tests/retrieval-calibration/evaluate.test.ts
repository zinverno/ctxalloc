import { describe, expect, it } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { loadPublicDataset } from '../../benchmarks/retrieval-calibration/data.js';
import { evaluate } from '../../benchmarks/retrieval-calibration/evaluate.js';

const tokenizer = new O200kBaseTokenizer();
describe('Phase 22A end-to-end development measurement', () => {
  it('preserves the human-labeled weak lexical hit before allocation and reports its cost', async () => {
    const data = loadPublicDataset();
    data.queries = [data.queries[35]!];
    data.documents = data.documents.filter((d) => d.id === data.queries[0]!.documentId);
    const report = await evaluate(data, tokenizer);
    expect(report.contractChecks).toBe('PASS');
    expect(report.generous.admissionRecall.value).toBe(1);
    expect(report.generous.usefulBlocks).toMatchObject({
      total: 1,
      preserved: 1,
      admissionMisses: 0,
    });
    expect(report.generous.renderedTokenReduction.value).toBe(0);
    expect(report.constrained.usefulBlocks).toMatchObject({
      admissionMisses: 0,
      allocationMisses: 1,
    });
    expect(report.constrained.runtimeRequiredPreservation.value).toBe(1);
  });
  it('keeps retrieval misses out of the per-query admission recall denominator', async () => {
    const data = loadPublicDataset();
    data.queries = [data.queries[16]!];
    data.documents = data.documents.filter((d) => d.id === data.queries[0]!.documentId);
    const report = await evaluate(data, tokenizer);
    expect(report.raw.usefulRetrievalRecall.value).toBeLessThan(1);
    expect(report.queries[0]!.generous.admission.recall.value).toBe(1);
  });
  it('emits only identifiers, hashes, counts and fixed metadata even for private-content canaries', async () => {
    // A modified public copy tests privacy only. It is never committed or used as calibration truth.
    const data = loadPublicDataset();
    data.queries = [data.queries[0]!];
    data.documents = data.documents.filter((d) => d.id === data.queries[0]!.documentId);
    data.queries[0]!.query += ' PRIVATE_QUERY_CANARY';
    data.documents[0]!.blocks = data.documents[0]!.blocks.map((b) => ({
      ...b,
      content: b.content + ' PRIVATE_SOURCE_CANARY',
    }));
    const encoded = JSON.stringify(await evaluate(data, tokenizer));
    expect(encoded).not.toContain('PRIVATE_QUERY_CANARY');
    expect(encoded).not.toContain('PRIVATE_SOURCE_CANARY');
    expect(encoded).not.toContain(data.documents[0]!.blocks[0]!.content);
    expect(encoded).not.toContain(data.queries[0]!.id);
  });
});
