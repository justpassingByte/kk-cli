import { writeFile } from 'node:fs/promises';
import {
  assertArtifactId,
  assertCommit,
  assertRunId,
  assertSha256,
  CANDIDATE_ARTIFACT_NAME,
  npmExec,
  retryRegistry,
  verifyCandidate,
} from './release-artifact-contract.mjs';

const [
  candidatePath,
  expectedCommit,
  workflowRunId,
  candidateArtifactId,
  candidateArtifactDigest,
] = process.argv.slice(2);
if (
  !candidatePath ||
  !expectedCommit ||
  !workflowRunId ||
  !candidateArtifactId ||
  !candidateArtifactDigest
) {
  throw new Error(
    'Usage: publish-release-candidate <candidate-json> <commit> <run-id> <artifact-id> <artifact-digest>',
  );
}
assertCommit(expectedCommit);
assertRunId(workflowRunId);
assertArtifactId(candidateArtifactId);
assertSha256(candidateArtifactDigest, 'Candidate artifact digest');

const { candidate, tarballPath } = await verifyCandidate(
  candidatePath,
  expectedCommit,
);
const existing = readPublishedCandidate(candidate);
if (existing) {
  if (
    existing.version !== candidate.version ||
    existing.integrity !== candidate.tarballIntegrity ||
    existing.betaVersion !== candidate.version
  ) {
    throw new Error(
      'This npm version already exists but does not match the exact beta candidate.',
    );
  }
} else {
  npmExec([
    'publish',
    tarballPath,
    '--tag',
    'beta',
    '--access',
    'public',
    '--provenance',
  ]);
}

const registry = await retryRegistry(() => {
  const version = JSON.parse(
    npmExec(['view', `${candidate.package}@${candidate.version}`, 'version', '--json']),
  );
  const integrity = JSON.parse(
    npmExec([
      'view',
      `${candidate.package}@${candidate.version}`,
      'dist.integrity',
      '--json',
    ]),
  );
  const tags = JSON.parse(
    npmExec(['view', candidate.package, 'dist-tags', '--json']),
  );
  if (
    version !== candidate.version ||
    integrity !== candidate.tarballIntegrity ||
    tags.beta !== candidate.version
  ) {
    throw new Error('npm registry has not exposed the exact beta artifact yet.');
  }
  return { version, integrity };
});

const receipt = {
  schemaVersion: 1,
  package: candidate.package,
  version: candidate.version,
  tag: 'beta',
  commit: candidate.commit,
  workflowRunId,
  candidateArtifactName: CANDIDATE_ARTIFACT_NAME,
  candidateArtifactId,
  candidateArtifactDigest,
  tarball: candidate.tarball,
  tarballSha256: candidate.tarballSha256,
  tarballIntegrity: candidate.tarballIntegrity,
  registryIntegrity: registry.integrity,
  publishedAt: new Date().toISOString(),
};
await writeFile(
  'npm-publisher-receipt.json',
  `${JSON.stringify(receipt, null, 2)}\n`,
  { flag: 'wx' },
);
process.stdout.write(
  `Published or reconciled exact candidate ${candidate.package}@${candidate.version} on beta.\n`,
);

function readPublishedCandidate(candidate) {
  try {
    const version = JSON.parse(
      npmExec([
        'view',
        `${candidate.package}@${candidate.version}`,
        'version',
        '--json',
      ]),
    );
    const integrity = JSON.parse(
      npmExec([
        'view',
        `${candidate.package}@${candidate.version}`,
        'dist.integrity',
        '--json',
      ]),
    );
    const tags = JSON.parse(
      npmExec(['view', candidate.package, 'dist-tags', '--json']),
    );
    return { version, integrity, betaVersion: tags.beta };
  } catch (error) {
    const stderr =
      typeof error?.stderr === 'string'
        ? error.stderr
        : Buffer.isBuffer(error?.stderr)
          ? error.stderr.toString('utf8')
          : '';
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
      return undefined;
    }
    throw error;
  }
}
