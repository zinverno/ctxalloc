import { readFileSync } from 'node:fs';

/**
 * `ctxalloc version` (DEC-042).
 *
 * It reads no git revision, no clock, no hostname, no environment variable, and
 * no network resource. Every one of those would make two runs of the same build
 * report different identities, which is the opposite of what a version is for
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 *
 * The package version is read from the CLI's **module-relative** manifest, never
 * from `process.cwd()`: running `ctxalloc version` inside some other project's
 * directory must not report that project's version. The path is the same in
 * source and in `dist`, because the build mirrors `src/` under `dist/`.
 *
 * No SemVer release number is invented. The repository publishes `0.0.0` for
 * every workspace package, and reporting anything else here would be a claim
 * about a release that does not exist.
 */

/** The name of the executable, which is not the workspace package name. */
export const CLI_NAME = 'ctxalloc';

/**
 * The version of the CLI's own command, option, output, and error contracts.
 *
 * It is deliberately separate from the package version. A build can change
 * without the contract changing, and a script that pins behavior needs to read
 * the contract rather than the build.
 */
export const CLI_CONTRACT_VERSION = 1;

/** The version envelope. */
export interface CliVersion {
  readonly name: typeof CLI_NAME;
  readonly packageVersion: string;
  readonly cliContractVersion: typeof CLI_CONTRACT_VERSION;
}

/** Reads the CLI's own package version, or `0.0.0` when the manifest is unreadable. */
function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null) {
      const version: unknown = (manifest as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // A packaging accident must not make `version` fail: the command's job is to
    // identify the build, and the declared fallback is still a truthful
    // statement about a repository whose packages are all `0.0.0`.
  }
  return '0.0.0';
}

export function runVersionCommand(): CliVersion {
  return {
    name: CLI_NAME,
    packageVersion: packageVersion(),
    cliContractVersion: CLI_CONTRACT_VERSION,
  };
}
