import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  npmExec,
  PACKAGE_NAME,
  verifyCandidate,
} from './release-artifact-contract.mjs';

const [candidatePath, expectedCommit] = process.argv.slice(2);
if (!candidatePath || !expectedCommit) {
  throw new Error(
    'Usage: verify-release-candidate <candidate-json> <expected-commit>',
  );
}
const { candidate, tarballPath } = await verifyCandidate(
  candidatePath,
  expectedCommit,
);
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
if (
  metadata.name !== PACKAGE_NAME ||
  metadata.version !== candidate.version ||
  metadata.bin?.ak !== 'bin/ak.js'
) {
  throw new Error('Checked-out package metadata differs from the candidate.');
}

const prefix = await mkdtemp(path.join(os.tmpdir(), 'ak-release-canary-'));
try {
  npmExec([
    'install',
    '--global',
    '--prefix',
    prefix,
    tarballPath,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  const packageRoot =
    process.platform === 'win32'
      ? path.join(prefix, 'node_modules', '@bestagentkits', 'ak')
      : path.join(prefix, 'lib', 'node_modules', '@bestagentkits', 'ak');
  const entrypoint = path.join(packageRoot, 'bin', 'ak.js');
  const version = execFileSync(process.execPath, [entrypoint, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (
    version !== candidate.version &&
    !version.startsWith(`ak/${candidate.version} `)
  ) {
    throw new Error(`Installed candidate reported unexpected version ${version}.`);
  }
  execFileSync(process.execPath, [entrypoint, '--help'], {
    stdio: 'pipe',
    windowsHide: true,
  });
} finally {
  await rm(prefix, { recursive: true, force: true });
}
process.stdout.write(
  `Verified exact candidate ${candidate.package}@${candidate.version} (${candidate.tarballSha256}).\n`,
);
