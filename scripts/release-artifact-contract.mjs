import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

export const PACKAGE_NAME = 'kk-cli';
export const CANDIDATE_FILE = 'release-candidate.json';
export const CANDIDATE_ARTIFACT_NAME = 'npm-release-candidate';
export const RECEIPT_ARTIFACT_NAME = 'npm-publisher-receipt';

const REQUIRED_PACKAGE_FILES = [
  'LICENSE',
  'README.md',
  'bin/kk.js',
  'dist/index.js',
  'dist/index.js.map',
  'package.json',
];

export function assertBetaVersion(version) {
  const prerelease = semver.prerelease(version);
  if (
    semver.valid(version) !== version ||
    !prerelease ||
    !prerelease.some((identifier) => identifier === 'beta')
  ) {
    throw new Error(`Expected an exact beta semantic version, received ${version}.`);
  }
}

export function assertCommit(commit) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Release commit must be an exact 40-character Git SHA.');
  }
}

export function assertRunId(runId) {
  if (!/^[1-9][0-9]*$/u.test(runId)) {
    throw new Error('Workflow run ID must be a positive integer.');
  }
}

export function assertArtifactId(artifactId) {
  if (!/^[1-9][0-9]*$/u.test(artifactId)) {
    throw new Error('Candidate artifact ID must be a positive integer.');
  }
}

export function assertSha256(value, label = 'SHA-256') {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

export function assertPackageInventory(files) {
  if (!Array.isArray(files)) throw new Error('Package inventory is missing.');
  const paths = files.map((entry) => entry?.path);
  if (
    paths.some((filePath) => typeof filePath !== 'string') ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('Package inventory contains invalid or duplicate paths.');
  }
  const sorted = [...paths].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(REQUIRED_PACKAGE_FILES)) {
    throw new Error(`Unexpected npm package inventory: ${sorted.join(', ')}`);
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function verifyCandidate(candidatePath, expectedCommit) {
  const candidate = await readJson(candidatePath);
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.package !== PACKAGE_NAME ||
    typeof candidate.version !== 'string' ||
    typeof candidate.commit !== 'string' ||
    typeof candidate.tarball !== 'string' ||
    path.basename(candidate.tarball) !== candidate.tarball ||
    !candidate.tarball.endsWith('.tgz') ||
    typeof candidate.tarballSha256 !== 'string' ||
    typeof candidate.tarballIntegrity !== 'string'
  ) {
    throw new Error('Release candidate metadata is invalid.');
  }
  assertBetaVersion(candidate.version);
  assertCommit(candidate.commit);
  if (expectedCommit && candidate.commit !== expectedCommit) {
    throw new Error('Release candidate commit does not match the workflow commit.');
  }
  assertSha256(candidate.tarballSha256, 'Candidate tarball SHA-256');
  assertPackageInventory(candidate.files);
  const tarballPath = path.resolve(path.dirname(candidatePath), candidate.tarball);
  const bytes = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (
    sha256 !== candidate.tarballSha256 ||
    integrity !== candidate.tarballIntegrity
  ) {
    throw new Error('Release candidate tarball bytes do not match metadata.');
  }
  return { candidate, tarballPath };
}

export function npmExec(args, options = {}) {
  const invocation = npmInvocation();
  return execFileSync(
    invocation.executable,
    [...invocation.argsPrefix, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      ...options,
    },
  ).trim();
}

export async function retryRegistry(operation, attempts = 12) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }
  throw lastError;
}

function npmInvocation() {
  if (process.platform !== 'win32') {
    return { executable: 'npm', argsPrefix: [] };
  }
  return {
    executable: process.execPath,
    argsPrefix: [
      path.join(
        path.dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      ),
    ],
  };
}
