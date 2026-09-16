#!/usr/bin/env node

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major === 22 ? minor >= 14 : major >= 24;

if (!supported) {
  console.error(
    `KK CLI requires Node.js 22.14 or newer. You are using ${process.versions.node}.\n` +
      'Install an active Node.js LTS release, then run this command again.',
  );
  process.exitCode = 4;
} else {
  await import('../dist/index.js');
}
