import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CandidateScorer, ContextCompiler, ContextRenderer } from '@ctxalloc/compiler';
import { verifyPhase21CHistory } from '../../benchmarks/historical/phase21c.js';
import {
  PHASE21E_INTEGRATION,
  PHASE21E_REANCHOR,
  verifyPhase21EReanchor,
} from '../../benchmarks/reanchored-v2/phase21e.js';

const root = process.cwd();
const manifestBytes = readFileSync(PHASE21E_REANCHOR);
const readManifest = () => manifestBytes;
const oldRevisions = [
  '2e1db08110523d532775a041a8406f75c624c088',
  'ebebc9b5671fc55acee4eb84fce047821d1c5ea2',
  '210efbd015b98499454a3d48dbe1208b668fdc30',
  '8dbba53b3d1d8719f932458f3e2c85e1ca264cd3',
];
const gitAt = (cwd: string, args: readonly string[]) =>
  execFileSync('git', [...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
// Component tests supply authenticated manifest bytes separately so they also
// run before the implementation commit. Committed-manifest tests use the
// isolated repository below with no reader substitutions.
const git = (args: readonly string[]) =>
  args[0] === 'show' && args[1] === `HEAD:${PHASE21E_REANCHOR}` ? manifestBytes : gitAt(root, args);
const verify = (reader = git) => verifyPhase21EReanchor(root, readManifest, reader);

let isolated: string;
let integrationOnlyHead: string;
beforeAll(() => {
  isolated = mkdtempSync(join(tmpdir(), 'ctxalloc-reanchor-test-'));
  gitAt(isolated, ['init', '--quiet']);
  // Pack only the integration lineage. No alternates, hard links, or PR refs.
  gitAt(isolated, ['fetch', '--quiet', '--no-tags', `file://${root}`, PHASE21E_INTEGRATION]);
  gitAt(isolated, ['read-tree', PHASE21E_INTEGRATION]);
  mkdirSync(join(isolated, 'docs/evidence'), { recursive: true });
  writeFileSync(join(isolated, PHASE21E_REANCHOR), manifestBytes);
  gitAt(isolated, ['add', PHASE21E_REANCHOR]);
  const tree = gitAt(isolated, ['write-tree']).toString().trim();
  integrationOnlyHead = gitAt(isolated, [
    '-c',
    'user.name=Reanchor Test',
    '-c',
    'user.email=reanchor@example.invalid',
    'commit-tree',
    tree,
    '-p',
    PHASE21E_INTEGRATION,
    '-m',
    'Test committed re-anchor',
  ])
    .toString()
    .trim();
  gitAt(isolated, ['update-ref', 'HEAD', integrationOnlyHead]);
}, 30_000);
afterAll(() => rmSync(isolated, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('Phase 21E re-anchor version 1', () => {
  it('authenticates the correct integration anchor with the separately pinned manifest', () => {
    const calls: string[][] = [];
    const result = verify((args) => {
      calls.push([...args]);
      if (args[0] === 'merge-base') {
        // Exercise the exact anchor, not just a descendant.
        return gitAt(root, [
          'merge-base',
          '--is-ancestor',
          PHASE21E_INTEGRATION,
          PHASE21E_INTEGRATION,
        ]);
      }
      return git(args);
    });
    expect(result).toMatchObject({
      status: 'PASS',
      verification: 'historical-integrity-after-squash-integration',
      immutableIntegrationFilesVerified: 21,
      originalSemanticFilesVerified: 220,
      semanticFilesMatchingIntegration: 218,
      originalWiringSnapshotsVerified: 2,
      originalBuiltArtifactHashesPreserved: 142,
      caseInputAnnotationPolicyHashesVerified: 60,
      originalAncestryRestored: false,
      orphanedCommitsRequired: false,
    });
    for (const revision of oldRevisions) expect(JSON.stringify(calls)).not.toContain(revision);
  });

  it('passes on a real committed descendant with all old experiment objects absent', () => {
    for (const revision of oldRevisions)
      expect(spawnSync('git', ['cat-file', '-e', revision], { cwd: isolated }).status).not.toBe(0);
    expect(verifyPhase21EReanchor(isolated)).toEqual(verify());
  });

  it('allows future compiler and frozen working file changes while reading integration history', () => {
    const compiler = 'packages/compiler/src/index.ts';
    const report = 'docs/evidence/phase21e-first-run.json';
    mkdirSync(join(isolated, 'packages/compiler/src'), { recursive: true });
    writeFileSync(join(isolated, compiler), '// Future compiler development\n');
    writeFileSync(join(isolated, report), 'Future working copy; historical bytes live in Git.\n');
    gitAt(isolated, ['add', compiler, report]);
    const tree = gitAt(isolated, ['write-tree']).toString().trim();
    const descendant = gitAt(isolated, [
      '-c',
      'user.name=Reanchor Test',
      '-c',
      'user.email=reanchor@example.invalid',
      'commit-tree',
      tree,
      '-p',
      integrationOnlyHead,
      '-m',
      'Future development',
    ])
      .toString()
      .trim();
    gitAt(isolated, ['update-ref', 'HEAD', descendant]);
    try {
      expect(verifyPhase21EReanchor(isolated)).toEqual(verify());
    } finally {
      gitAt(isolated, ['update-ref', 'HEAD', integrationOnlyHead]);
    }
  });

  it('rejects missing integration ancestry', () => {
    expect(() =>
      verify((args) =>
        args[0] === 'merge-base'
          ? gitAt(root, [
              'merge-base',
              '--is-ancestor',
              PHASE21E_INTEGRATION,
              `${PHASE21E_INTEGRATION}^`,
            ])
          : git(args),
      ),
    ).toThrow();
  });
  it('rejects a wrong actual integration tree', () => {
    expect(() =>
      verify((args) => (args[0] === 'rev-parse' ? Buffer.from('0'.repeat(40)) : git(args))),
    ).toThrow('Integration tree identity changed');
  });

  it.each([
    'docs/evidence/phase21e-first-run.json',
    'benchmarks/heldout-v2/v2/freeze.json',
    'benchmarks/heldout-v2/v2/cases.json',
    'benchmarks/heldout-v2/profiles.ts',
    'benchmarks/heldout-v2/gates.ts',
    'docs/PHASE21E_HELD_OUT_PROTOCOL.md',
    'packages/compiler/src/index.ts',
  ])('rejects altered historical bytes at the integration anchor: %s', (path) => {
    expect(() =>
      verify((args) => {
        const bytes = git(args);
        return args[0] === 'show' && args[1] === `${PHASE21E_INTEGRATION}:${path}`
          ? Buffer.concat([bytes, Buffer.from(' ')])
          : bytes;
      }),
    ).toThrow('Historical artifact changed');
  });

  it.each(['input', 'annotations', 'policy'])('rejects an altered case %s artifact', (field) => {
    expect(() =>
      verify((args) => {
        const bytes = git(args);
        if (args[1] !== `${PHASE21E_INTEGRATION}:benchmarks/heldout-v2/v2/cases.json`) return bytes;
        const cases = JSON.parse(bytes.toString()) as {
          input: { policy: unknown };
          annotations: unknown;
        }[];
        const first = cases[0]!;
        if (field === 'policy') first.input.policy = {};
        else if (field === 'input') first.input = { policy: {} };
        else first.annotations = {};
        return Buffer.from(JSON.stringify(cases));
      }),
    ).toThrow('Historical artifact changed');
  });

  it.each([
    ['protocolRevision', oldRevisions[0]!],
    ['freezeRevision', oldRevisions[1]!],
    ['resultsRevision', oldRevisions[2]!],
    ['finalHead', oldRevisions[3]!],
    ['integration tree', '30c355fa7b079c0f98d91f494fb4feb7e12faef0'],
    ['frozen manifest hash', 'f7210ac39e7e5b8fc97bf62608b57994c454c1f4c84ba7f97d28c179df0204b2'],
  ])('rejects a tampered re-anchor %s', (_label, value) => {
    const tampered = Buffer.from(
      manifestBytes.toString().replaceAll(value, '0'.repeat(value.length)),
    );
    expect(() => verifyPhase21EReanchor(root, () => tampered, git)).toThrow(
      'Re-anchor manifest hash changed',
    );
  });
  it('rejects re-anchor whitespace tampering', () => {
    expect(() =>
      verifyPhase21EReanchor(root, () => Buffer.concat([manifestBytes, Buffer.from(' ')]), git),
    ).toThrow('Re-anchor manifest hash changed');
  });
  it('requires the authenticated re-anchor to be committed', () => {
    expect(() =>
      verify((args) => (args[1] === `HEAD:${PHASE21E_REANCHOR}` ? Buffer.from('{}') : git(args))),
    ).toThrow('Re-anchor manifest must match committed HEAD');
  });
  it('rejects an altered integration inventory', () => {
    expect(() =>
      verify((args) =>
        args[0] === 'ls-tree'
          ? Buffer.concat([git(args), Buffer.from('benchmarks/heldout-v2/extra.ts\n')])
          : git(args),
      ),
    ).toThrow('Historical frozen inventory changed');
  });
  it('reports PASS only as historical evidence and never executes selection', () => {
    const spies = [
      vi.spyOn(ContextCompiler.prototype, 'compile'),
      vi.spyOn(CandidateScorer.prototype, 'score'),
      vi.spyOn(ContextRenderer.prototype, 'render'),
    ];
    for (const spy of spies)
      spy.mockImplementation(() => {
        throw new Error('Selection is forbidden here.');
      });
    const result = verify();
    expect(result).toMatchObject({
      compilerExecuted: false,
      selectionExecuted: false,
      originalExecutableReproduced: false,
      historicalEvidence: {
        caseCount: 60,
        successfulCompilations: 43,
        expectedFailures: 17,
        unexpectedOutcomes: 0,
        heldOutEvidenceAwareContextSelection: 'PASS',
      },
    });
    expect(result.historicalEvidence.gates).toHaveLength(19);
    expect(result).not.toHaveProperty('heldOutEvidenceAwareContextSelection');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(verify()).toEqual(result);
  });
  it('leaves the independently verified Phase 21C historical FAIL unchanged', () => {
    expect(verifyPhase21CHistory(root)).toMatchObject({
      status: 'PASS',
      heldOutContextSelectionValidation: 'FAIL',
      caseCount: 48,
      firstReportSha256: 'sha256:3144a9f8c505f46c45e142dccf1da24feef149a38ed280d630910aa39945a4e1',
      changedCompilerExecuted: false,
    });
  });
});
