import { execFileSync, spawnSync } from 'node:child_process';
import { cpus, platform, arch, release, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceReport } from './report.js';
import { metric, type Gate } from './gates.js';
import type { AnthropicModelProvider } from '@ctxalloc/adapters';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function integration(): Gate[] {
  const run = (script: string) =>
    spawnSync(process.execPath, [join(root, 'scripts', script)], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const cli = run('smoke-cli.mjs');
  const api = run('smoke-api.mjs');
  let apiPassed = false;
  try {
    const report = JSON.parse(api.stdout) as {
      schemaVersion: unknown;
      status: unknown;
      checks?: unknown;
    };
    apiPassed =
      api.status === 0 &&
      report.schemaVersion === 1 &&
      report.status === 'PASS' &&
      Array.isArray(report.checks) &&
      report.checks.includes('cli-http-parity') &&
      report.checks.includes('api-restart-trace');
  } catch {
    /* Missing/malformed evidence is a failed smoke. */
  }
  return [
    metric(
      'builtCliWorkflow',
      cli.status === 0 ? 1 : 0,
      '= 1',
      (v) => v === 1,
      'engineering',
      'Executed scripts/smoke-cli.mjs',
    ),
    metric(
      'builtHttpWorkflowAndParity',
      apiPassed ? 1 : 0,
      '= 1',
      (v) => v === 1,
      'engineering',
      'Executed scripts/smoke-api.mjs: two formats, separate CLI/API DBs, restart, scope, privacy',
    ),
    metric(
      'dockerRuntime',
      undefined,
      'successful image build, mounted compile, SIGTERM, restart trace',
      (v) => v === 1,
      'engineering',
      'NOT_RUN: deterministic runner makes no Docker availability assumption',
    ),
  ];
}
export async function runAcceptance(
  performance: boolean,
  liveProvider?: AnthropicModelProvider,
): Promise<void> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).length > 0;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const environment = {
    node: process.version,
    packageManager: manifest.packageManager,
    os: platform(),
    osRelease: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
  const report = await buildAcceptanceReport({
    root,
    performance,
    executedAt: new Date().toISOString(),
    referenceEnvironment: `${environment.os}/${environment.arch}/${environment.node}`,
    integrationGates: integration(),
    ...(liveProvider === undefined ? {} : { liveProvider }),
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, sourceRevision: { head, dirty }, environment })}\n`,
  );
  // A measurement command can report a product FAIL without asserting a release.
  // CI rejects engineering failures; missing external evidence stays INCOMPLETE.
  if (report.engineeringAcceptance === 'FAIL') process.exitCode = 1;
}
