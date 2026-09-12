// Offline, score-blind importer. Input is the original QASPER 0.3 training JSON.
// No retrieval, model, annotation generation, or network request occurs here.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync(process.argv[2], 'utf8');
const papers = JSON.parse(input);
const selected = Object.keys(papers)
  .filter((id) => {
    const n = papers[id].full_text.flatMap((s) => s.paragraphs).filter((s) => s.trim()).length;
    return n >= 10 && n <= 100;
  })
  .sort((a, b) => hash(a).localeCompare(hash(b), 'en'))
  .slice(0, 12);
const documents = [];
const queries = [];
let duplicateParagraphs = 0;
for (const id of selected) {
  const paper = papers[id];
  const seen = new Map();
  const blocks = [];
  for (const [index, content] of paper.full_text.flatMap((s) => s.paragraphs).entries()) {
    if (!content.trim()) continue;
    if (seen.has(content)) {
      duplicateParagraphs++;
      continue;
    }
    const blockId = `${id}:${index}`;
    seen.set(content, blockId);
    blocks.push({ id: blockId, content });
  }
  documents.push({ id, sourceType: 'text', blocks });
  for (const q of paper.qas) {
    const answers = q.answers.map((a) => a.answer);
    const evidence = [...new Set(answers.flatMap((a) => a.evidence))];
    const useful = [...new Set(evidence.flatMap((s) => (seen.has(s) ? [seen.get(s)] : [])))];
    queries.push({
      id: q.question_id,
      documentId: id,
      query: q.question,
      answerability: answers.every((a) => a.unanswerable)
        ? 'unanswerable'
        : answers.some((a) => a.unanswerable)
          ? 'disputed'
          : 'answerable',
      useful,
      irrelevant: [],
      facts: evidence.map((s) => ({
        id: hash(s),
        blockIds: seen.has(s) ? [seen.get(s)] : [],
        critical: null,
      })),
      annotationHashes: q.answers.map((a) => hash(JSON.stringify(a.answer))),
    });
  }
}
const data = {
  schemaVersion: 1,
  labelProvenance: 'independent-human-annotations',
  documents,
  queries,
};
const dir = 'benchmarks/retrieval-calibration/data';
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/corpus.json`, JSON.stringify(data, null, 2) + '\n');
writeFileSync(
  `${dir}/provenance.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      datasetId: 'ctxalloc-phase22a-qasper-train-v1',
      split: 'DEVELOPMENT',
      upstream: 'QASPER 0.3 train',
      source: 'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz',
      license: 'CC-BY-4.0',
      originalTrainingFileSha256: hash(input),
      logicalCorpusSha256: hash(JSON.stringify(data)),
      selection:
        'First 12 paper IDs by SHA-256, with 10–100 nonblank paragraphs; all their questions',
      selectedPaperIds: selected,
      duplicateParagraphsRemoved: duplicateParagraphs,
      documentCount: documents.length,
      blockCount: documents.reduce((n, d) => n + d.blocks.length, 0),
      queryCount: queries.length,
      positiveJudgments: queries.reduce((n, q) => n + q.useful.length, 0),
      negativeJudgments: 0,
      evidenceUnits: queries.reduce((n, q) => n + q.facts.length, 0),
      unavailableEvidenceUnits: queries.reduce(
        (n, q) => n + q.facts.filter((f) => !f.blockIds.length).length,
        0,
      ),
      criticalAnnotations: 0,
      annotationMethod:
        'Original human evidence paragraphs, exact text join; no model-authored labels',
      limitations: [
        'Unmarked paragraphs are unjudged',
        'Evidence units are paragraphs, not atomic facts',
        'No criticality annotations',
      ],
    },
    null,
    2,
  ) + '\n',
);
