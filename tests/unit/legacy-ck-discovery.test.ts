import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverLegacyCk } from '../../src/infrastructure/migration/legacy-ck-discovery.js';

describe('discoverLegacyCk', () => {
  it('finds explicit CK skill identities and leaves them mutation-protected', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'kk-legacy-discovery-'));
    const home = path.join(fixture, 'home');
    const project = path.join(fixture, 'project');
    const skill = path.join(home, '.agents', 'skills', 'legacy-skill');
    await mkdir(skill, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: ck:legacy-skill\n---\n');

    try {
      const result = await discoverLegacyCk({ home, project });
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          runtime: 'codex',
          scope: 'global',
          family: 'engineer',
          mutationSafe: false,
        }),
      );
    } finally {
      await rm(fixture, { recursive: true });
    }
  });

  it('does not treat symlinked known roots as safe to mutate', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'kk-legacy-symlink-'));
    const home = path.join(fixture, 'home');
    const project = path.join(fixture, 'project');
    const external = path.join(fixture, 'external');
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(
      external,
      path.join(home, '.claudekit'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      const result = await discoverLegacyCk({ home, project });
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          kind: 'source-root',
          confidence: 'low',
          mutationSafe: false,
        }),
      );
    } finally {
      await rm(fixture, { recursive: true });
    }
  });

  it('skips a symlinked Claude root before traversing its contents', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'kk-legacy-root-symlink-'));
    const home = path.join(fixture, 'home');
    const project = path.join(fixture, 'project');
    const external = path.join(fixture, 'external-claude');
    const externalSkill = path.join(external, 'skills', 'legacy');
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(externalSkill, { recursive: true });
    await writeFile(path.join(externalSkill, 'SKILL.md'), '---\nname: ck:legacy\n---\n');
    await symlink(
      external,
      path.join(home, '.claude'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      const result = await discoverLegacyCk({ home, project });
      expect(result.findings).not.toContainEqual(
        expect.objectContaining({ path: expect.stringContaining('external-claude') }),
      );
      expect(result.warnings).toContainEqual(
        expect.stringMatching(/Skipped symlinked Claude root/i),
      );
    } finally {
      await rm(fixture, { recursive: true });
    }
  });

  it('does not infer legacy settings ownership from arbitrary ck prefixes', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'kk-legacy-settings-'));
    const home = path.join(fixture, 'home');
    const project = path.join(fixture, 'project');
    const claudeHome = path.join(home, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(claudeHome, 'settings.json'),
      JSON.stringify({ unrelated: 'ck:customer-command' }),
    );

    try {
      const result = await discoverLegacyCk({ home, project });
      expect(result.findings).not.toContainEqual(
        expect.objectContaining({ kind: 'settings' }),
      );
      expect(result.findings.every((finding) => finding.mutationSafe === false)).toBe(true);
    } finally {
      await rm(fixture, { recursive: true });
    }
  });
});
