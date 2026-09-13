import { closeSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { loadLocalJson } from '../retrieval-calibration/local.js';
import { hash } from '../retrieval-calibration/data.js';
import { parseTasks, parseAnnotations, requireHuman, operating } from './schema.js';
import { confined, loadSettings, prepare, worksheet, writeLocal } from './prepare.js';
import { freezeRecord, implementationIdentity, verifyFrozen } from './freeze.js';

export const READY = {
  schemaVersion: 1,
  phase: '22B',
  status: 'READY_FOR_HUMAN_DATA',
  evaluationExecuted: false,
  productValidation: 'NOT_EVALUATED',
  missingInputs: [
    'explicit approved snapshot and scope',
    'reader/chunker settings',
    'primary available tokens and output reservation',
    'production candidate cap',
    'sampling/language coverage and real task set',
    'independent human evidence/fact/criticality judgments',
    'caller-known runtime obligations or explicit empty lists',
    'explicit evaluation approval and frozen inputs',
  ],
};
function options(args: readonly string[], keys: readonly string[]) {
  if (args.length !== keys.length * 2) throw new Error('invalid_arguments');
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1]!;
    if (!keys.includes(key) || key in result || !value || value.startsWith('--'))
      throw new Error('invalid_arguments');
    result[key] = value;
  }
  if (keys.some((key) => !(key in result))) throw new Error('invalid_arguments');
  return result;
}
export async function runDogfood(args: readonly string[], ignoredRoot = resolve('.ctxalloc')) {
  try {
    const [command, ...rest] = args;
    if (command === 'status' && !rest.length) return { exitCode: 0, report: READY };
    if (!['prepare', 'freeze', 'evaluate'].includes(command ?? ''))
      throw new Error('invalid_arguments');
    const flags = options(
      rest,
      command === 'prepare'
        ? ['--local', '--out']
        : command === 'freeze'
          ? ['--local', '--tasks', '--annotations', '--out']
          : ['--local', '--tasks', '--annotations', '--freeze', '--out'],
    );
    const { settings, baseDirectory } = loadSettings(flags['--local']!, ignoredRoot);
    const tasks =
      command === 'prepare' ? null : parseTasks(loadLocalJson(flags['--tasks']!, ignoredRoot));
    const annotations =
      command === 'prepare'
        ? null
        : parseAnnotations(loadLocalJson(flags['--annotations']!, ignoredRoot));
    // Refuse the checkpoint before reading private sources or constructing retrieval.
    if (tasks && annotations) {
      requireHuman(tasks, annotations);
      operating(settings);
    }
    const tokenizer = new O200kBaseTokenizer();
    const prepared = await prepare(settings, baseDirectory, tokenizer, ignoredRoot);
    if (command === 'prepare') {
      writeLocal(flags['--out']!, worksheet(prepared), ignoredRoot);
      return {
        exitCode: 0,
        report: {
          schemaVersion: 1,
          status: 'PREPARED_FOR_HUMAN_REVIEW',
          evaluationExecuted: false,
          sources: prepared.sources.length,
          blocks: prepared.corpus.blocks.length,
          preparationHash: prepared.fingerprint,
        },
      };
    }
    if (!tasks || !annotations) throw new Error('human_data_checkpoint');
    const frozen = freezeRecord(settings, tasks, annotations, prepared, implementationIdentity());
    if (command === 'freeze') {
      writeLocal(flags['--out']!, frozen, ignoredRoot);
      return {
        exitCode: 0,
        report: {
          schemaVersion: 1,
          status: 'FROZEN_AWAITING_EVALUATION',
          evaluationExecuted: false,
          freezeHash: hash(JSON.stringify(frozen)),
        },
      };
    }
    verifyFrozen(loadLocalJson(flags['--freeze']!, ignoredRoot), frozen);
    const target = resolve(flags['--out']!);
    confined(dirname(target), ignoredRoot);
    // Reserve a new report before retrieval. Interruption leaves this marker intact.
    const fd = openSync(target, 'wx', 0o600);
    try {
      writeSync(
        fd,
        `${JSON.stringify({ schemaVersion: 1, status: 'STARTED_NOT_COMPLETED', freezeHash: hash(JSON.stringify(frozen)) })}\n`,
        0,
        'utf8',
      );
      const { evaluateDogfood } = await import('./evaluate.js');
      const report = await evaluateDogfood(settings, tasks, annotations, prepared, tokenizer);
      const result = { ...report, freezeHash: hash(JSON.stringify(frozen)) };
      ftruncateSync(fd, 0);
      writeSync(fd, `${JSON.stringify(result)}\n`, 0, 'utf8');
      return {
        exitCode:
          report.verdict === 'DOGFOOD BASELINE PASS'
            ? 0
            : report.verdict === 'DOGFOOD BASELINE FAIL'
              ? 1
              : 2,
        report: {
          schemaVersion: 1,
          status: report.verdict,
          evaluationExecuted: true,
          queries: report.queries.length,
          freezeHash: result.freezeHash,
          preservationQualifiedSavings: report.preservationQualifiedSavings,
        },
      };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'human_data_checkpoint',
        'operating_decisions_required',
        'source_decisions_required',
      ].includes(error.message)
    )
      return { exitCode: 2, report: READY };
    return {
      exitCode: 2,
      report: {
        schemaVersion: 1,
        status: 'INPUT_OR_WORKFLOW_REJECTED',
        evaluationResult: 'NO_COMPLETED_RESULT',
        error: 'phase22b_workflow_failed',
      },
    };
  }
}
