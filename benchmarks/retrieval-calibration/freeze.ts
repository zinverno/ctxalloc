import { readFileSync } from 'node:fs';
import { hash } from './data.js';
import { PROFILE, profilePolicy } from './profile.js';

/** Reviewed repository trust root; this freezes a development interpretation, not a validation claim. */
export function verifyProfileFreeze(): void {
  const freeze: unknown = JSON.parse(
    readFileSync('benchmarks/retrieval-calibration/profile-freeze.json', 'utf8'),
  );
  if (
    typeof freeze !== 'object' ||
    freeze === null ||
    !('profileHash' in freeze) ||
    !('implementationHash' in freeze) ||
    !('firstRawReportHash' in freeze) ||
    freeze.profileHash !== hash(JSON.stringify({ profile: PROFILE, policy: profilePolicy() })) ||
    freeze.implementationHash !==
      hash(readFileSync('benchmarks/retrieval-calibration/profile.ts', 'utf8')) ||
    freeze.firstRawReportHash !==
      hash(readFileSync('docs/evidence/phase22a-native-first.json', 'utf8'))
  )
    throw new Error('profile_freeze_mismatch');
}
