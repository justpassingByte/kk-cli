import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageMetadata = JSON.parse(readFileSync('package.json', 'utf8'));
const npm = npmInvocation();
const packed = JSON.parse(
  execFileSync(npm.executable, [...npm.argsPrefix, 'pack', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    windowsHide: true,
  }),
);
const artifact = packed[0];
if (!artifact?.filename || !Array.isArray(artifact.files)) {
  throw new Error('npm pack did not return a verifiable file inventory.');
}

const allowedFiles = new Set([
  'LICENSE',
  'README.md',
  'bin/kk.js',
  'dist/index.js',
  'dist/index.js.map',
  'package.json',
]);
const unexpected = artifact.files
  .map((entry) => entry.path)
  .filter((filePath) => !allowedFiles.has(filePath));
if (unexpected.length > 0) {
  throw new Error(`Unexpected files in npm package: ${unexpected.join(', ')}`);
}
for (const required of ['bin/kk.js', 'dist/index.js', 'package.json']) {
  if (!artifact.files.some((entry) => entry.path === required)) {
    throw new Error(`Required npm package file is missing: ${required}`);
  }
}
if (packageMetadata.name !== 'kk-cli' || packageMetadata.bin?.kk !== 'bin/kk.js') {
  throw new Error('npm package identity or kk binary contract is incorrect.');
}

const prefix = mkdtempSync(path.join(os.tmpdir(), 'kk-package-canary-'));
const tarball = path.resolve(artifact.filename);
try {
  execFileSync(
    npm.executable,
    [...npm.argsPrefix, 'install', '--global', '--prefix', prefix, tarball, '--ignore-scripts', '--no-audit', '--no-fund'],
    { stdio: 'pipe', windowsHide: true },
  );
  const packageRoot =
    process.platform === 'win32'
      ? path.join(prefix, 'node_modules', 'kk-cli')
      : path.join(prefix, 'lib', 'node_modules', 'kk-cli');
  const entrypoint = path.join(packageRoot, 'bin', 'kk.js');
  const version = execFileSync(process.execPath, [entrypoint, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (version !== packageMetadata.version && !version.startsWith(`kk/${packageMetadata.version} `)) {
    throw new Error(`Installed package version ${version} does not match ${packageMetadata.version}.`);
  }
  execFileSync(process.execPath, [entrypoint, '--help'], {
    stdio: 'pipe',
    windowsHide: true,
  });
} finally {
  rmSync(prefix, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

process.stdout.write(
  `Verified ${packageMetadata.name}@${packageMetadata.version} (${artifact.integrity}).\n`,
);

function npmInvocation() {
  if (process.platform !== 'win32') {
    return { executable: 'npm', argsPrefix: [] };
  }
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return { executable: process.execPath, argsPrefix: [npmCli] };
}
