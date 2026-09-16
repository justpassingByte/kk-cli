import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeRuntimeHandoff } from '../../src/infrastructure/packages/fresh-runtime-handoff.js';

const directories: string[] = [];
const original = process.env['AGENTKIT_RUNTIME_HANDOFF'];

afterEach(async () => {
  if (original === undefined) delete process.env['AGENTKIT_RUNTIME_HANDOFF'];
  else process.env['AGENTKIT_RUNTIME_HANDOFF'] = original;
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('consumeRuntimeHandoff', () => {
  it('accepts only the expected fresh entrypoint and version', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-handoff-'));
    directories.push(directory);
    const entrypoint = path.join(directory, 'kk.js');
    await fs.writeFile(entrypoint, '#!/usr/bin/env node\n');
    process.env['AGENTKIT_RUNTIME_HANDOFF'] = JSON.stringify({
      expectedVersion: '0.1.0-beta.1',
      entrypoint,
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    await expect(
      consumeRuntimeHandoff(
        '0.1.0-beta.1',
        entrypoint,
        Date.parse('2026-07-28T00:01:00.000Z'),
      ),
    ).resolves.toBe('0.1.0-beta.1');
    expect(process.env['AGENTKIT_RUNTIME_HANDOFF']).toBeUndefined();
  });

  it('rejects a stale or mismatched handoff', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-handoff-'));
    directories.push(directory);
    const entrypoint = path.join(directory, 'kk.js');
    await fs.writeFile(entrypoint, '#!/usr/bin/env node\n');
    process.env['AGENTKIT_RUNTIME_HANDOFF'] = JSON.stringify({
      expectedVersion: '0.1.0-beta.1',
      entrypoint,
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    await expect(
      consumeRuntimeHandoff(
        '0.1.0-beta.0',
        entrypoint,
        Date.parse('2026-07-28T00:10:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
