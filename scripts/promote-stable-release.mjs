import { writeFile } from 'node:fs/promises';
import {
  assertArtifactId,
  assertRunId,
  assertSha256,
  npmExec,
  readJson,
  RECEIPT_ARTIFACT_NAME,
  verifyCandidate,
} from './release-artifact-contract.mjs';

const [
  candidatePath,
  receiptPath,
  runEvidencePath,
  artifactEvidencePath,
  requestedVersion,
  requestedRunId,
] = process.argv.slice(2);
if (
  !candidatePath ||
  !receiptPath ||
  !runEvidencePath ||
  !artifactEvidencePath ||
  !requestedVersion ||
  !requestedRunId
) {
  throw new Error(
    'Usage: promote-stable-release <candidate-json> <receipt-json> <run-json> <artifacts-json> <version> <beta-run-id>',
  );
}
assertRunId(requestedRunId);
const { candidate } = await verifyCandidate(candidatePath);
const receipt = await readJson(receiptPath);
if (
  receipt?.schemaVersion !== 1 ||
  receipt.package !== candidate.package ||
  receipt.version !== requestedVersion ||
  receipt.version !== candidate.version ||
  receipt.tag !== 'beta' ||
  receipt.commit !== candidate.commit ||
  receipt.workflowRunId !== requestedRunId ||
  receipt.candidateArtifactName !== 'npm-release-candidate' ||
  receipt.tarball !== candidate.tarball ||
  receipt.tarballSha256 !== candidate.tarballSha256 ||
  receipt.tarballIntegrity !== candidate.tarballIntegrity ||
  receipt.registryIntegrity !== candidate.tarballIntegrity
) {
  throw new Error('Beta publisher receipt does not match the exact candidate.');
}
assertArtifactId(receipt.candidateArtifactId);
assertSha256(receipt.candidateArtifactDigest, 'Candidate artifact digest');
assertGitHubReleaseEvidence(
  await readJson(runEvidencePath),
  await readJson(artifactEvidencePath),
  candidate,
  receipt,
  requestedRunId,
);

const registryIntegrity = JSON.parse(
  npmExec([
    'view',
    `${candidate.package}@${candidate.version}`,
    'dist.integrity',
    '--json',
  ]),
);
const beforeTags = JSON.parse(
  npmExec(['view', candidate.package, 'dist-tags', '--json']),
);
if (
  registryIntegrity !== candidate.tarballIntegrity ||
  beforeTags.beta !== candidate.version
) {
  throw new Error('npm beta tag or immutable artifact integrity changed.');
}

npmExec(['dist-tag', 'add', `${candidate.package}@${candidate.version}`, 'latest']);
const afterTags = JSON.parse(
  npmExec(['view', candidate.package, 'dist-tags', '--json']),
);
const afterIntegrity = JSON.parse(
  npmExec([
    'view',
    `${candidate.package}@${candidate.version}`,
    'dist.integrity',
    '--json',
  ]),
);
if (
  afterTags.latest !== candidate.version ||
  afterIntegrity !== candidate.tarballIntegrity
) {
  throw new Error('Stable promotion verification failed.');
}

await writeFile(
  'npm-stable-promotion-receipt.json',
  `${JSON.stringify(
    {
      schemaVersion: 1,
      package: candidate.package,
      version: candidate.version,
      sourceTag: 'beta',
      targetTag: 'latest',
      betaWorkflowRunId: requestedRunId,
      publisherReceiptArtifact: RECEIPT_ARTIFACT_NAME,
      commit: candidate.commit,
      tarballSha256: candidate.tarballSha256,
      registryIntegrity: afterIntegrity,
      previousLatest: beforeTags.latest ?? null,
      promotedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
process.stdout.write(
  `Promoted ${candidate.package}@${candidate.version} from beta to latest without rebuilding.\n`,
);

function assertGitHubReleaseEvidence(
  run,
  artifactResponse,
  candidate,
  receipt,
  requestedRunId,
) {
  if (
    String(run?.id) !== requestedRunId ||
    run.path !== '.github/workflows/publish-beta.yml' ||
    run.event !== 'workflow_dispatch' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.head_sha !== candidate.commit ||
    run.repository?.full_name !== 'justpassingByte/kk-cli'
  ) {
    throw new Error('GitHub run is not the successful main Publish beta run.');
  }
  if (!Array.isArray(artifactResponse?.artifacts)) {
    throw new Error('GitHub artifact evidence is invalid.');
  }
  const candidateArtifact = artifactResponse.artifacts.find(
    (artifact) =>
      artifact.name === receipt.candidateArtifactName &&
      String(artifact.id) === receipt.candidateArtifactId,
  );
  const publisherReceipt = artifactResponse.artifacts.find(
    (artifact) => artifact.name === RECEIPT_ARTIFACT_NAME,
  );
  const digest = String(candidateArtifact?.digest ?? '').replace(
    /^sha256:/u,
    '',
  );
  if (
    !candidateArtifact ||
    candidateArtifact.expired === true ||
    digest !== receipt.candidateArtifactDigest ||
    String(candidateArtifact.workflow_run?.id ?? requestedRunId) !==
      requestedRunId ||
    !publisherReceipt ||
    publisherReceipt.expired === true
  ) {
    throw new Error('GitHub release artifacts do not match the publisher receipt.');
  }
}
