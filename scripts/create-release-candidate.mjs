import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertBetaVersion,
  assertCommit,
  assertPackageInventory,
  CANDIDATE_FILE,
  npmExec,
  PACKAGE_NAME,
} from './release-artifact-contract.mjs';

const [commit, outputDirectory = 'release-candidate'] = process.argv.slice(2);
if (!commit) {
  throw new Error('Usage: create-release-candidate <commit> [output-directory]');
}
assertCommit(commit);

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
if (metadata.name !== PACKAGE_NAME) {
  throw new Error(`Expected package ${PACKAGE_NAME}.`);
}
assertBetaVersion(metadata.version);

await mkdir(outputDirectory);
const packed = JSON.parse(
  npmExec([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    outputDirectory,
  ]),
);
const artifact = packed[0];
if (
  !artifact?.filename ||
  !artifact.integrity ||
  !Array.isArray(artifact.files)
) {
  throw new Error('npm pack did not return complete artifact metadata.');
}
assertPackageInventory(artifact.files);

const tarball = path.basename(artifact.filename);
const bytes = await readFile(path.join(outputDirectory, tarball));
const tarballSha256 = createHash('sha256').update(bytes).digest('hex');
const tarballIntegrity = `sha512-${createHash('sha512')
  .update(bytes)
  .digest('base64')}`;
if (tarballIntegrity !== artifact.integrity) {
  throw new Error('npm pack integrity does not match the packed tarball bytes.');
}

const candidate = {
  schemaVersion: 1,
  package: metadata.name,
  version: metadata.version,
  commit,
  tarball,
  tarballSha256,
  tarballIntegrity,
  files: artifact.files
    .map(({ path: filePath, size }) => ({ path: filePath, size }))
    .sort((left, right) => left.path.localeCompare(right.path)),
  createdAt: new Date().toISOString(),
};
await writeFile(
  path.join(outputDirectory, CANDIDATE_FILE),
  `${JSON.stringify(candidate, null, 2)}\n`,
  { flag: 'wx' },
);
process.stdout.write(
  `Created ${metadata.name}@${metadata.version} candidate ${tarballSha256}.\n`,
);
