import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import type { TransactionFileWrite } from '../../domain/lifecycle/filesystem-transaction.js';
import type {
  PreparedRuntimeProjection,
  PreparedRuntimeUnprojection,
  RuntimeProjectionInput,
  RuntimeProjector,
  RuntimeUnprojectionInput,
} from '../../domain/runtime/runtime-projector.js';
import { sha256Bytes, sha256File } from '../filesystem/file-hash.js';
import { assertPortableRelativePath, canonicalizeRoot } from '../filesystem/path-guard.js';
import {
  PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
  PROJECT_RUNTIME_OWNERSHIP_VERSION,
  type ProjectRuntimeOwnershipV1,
} from '../../domain/runtime/project-runtime-ownership.js';
import {
  loadProjectRuntimeOwnership,
  serializeProjectRuntimeOwnership,
} from './project-runtime-ownership-store.js';

const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

export class AgyProjectPluginProjector implements RuntimeProjector {
  async assertSupported(
    input: Pick<RuntimeProjectionInput, 'runtime' | 'scope' | 'projectDirectory'>,
  ): Promise<void> {
    if (input.runtime !== 'agy' && input.runtime !== 'antigravity') {
      throw unsupported(`AgyProjectPluginProjector only supports runtime "agy" or "antigravity".`);
    }
    const projectRoot = path.resolve(input.projectDirectory);
    try {
      await fs.access(projectRoot);
    } catch {
      await fs.mkdir(projectRoot, { recursive: true, mode: 0o755 });
    }
  }

  async prepare(input: RuntimeProjectionInput): Promise<PreparedRuntimeProjection> {
    const isGlobal = input.scope === 'global';
    const projectRoot = isGlobal
      ? await canonicalizeRoot(path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'config'))
      : await canonicalizeRoot(path.resolve(input.projectDirectory));
    const agentsDir = isGlobal
      ? projectRoot
      : path.join(projectRoot, '.agents');
    await fs.mkdir(agentsDir, { recursive: true, mode: 0o755 });

    const pluginLabel = isGlobal ? '.gemini/config' : '.agents';
    const pluginReference = `agy-${input.kitId}@antigravity`;
    const artifactFiles = await collectArtifactFiles(input.artifactDirectory);

    const writes: TransactionFileWrite[] = [];
    for (const file of artifactFiles) {
      // Map artifact files into layout
      const targetRelPath = isGlobal
        ? file.relativePath
        : `.agents/${file.relativePath}`;
      assertPortableRelativePath(targetRelPath);

      const targetAbsPath = path.join(projectRoot, ...targetRelPath.split('/'));
      let previousSha256: string | undefined;
      try {
        previousSha256 = await sha256File(targetAbsPath);
      } catch {
        // New file
      }

      writes.push({
        root: projectRoot,
        relativePath: targetRelPath,
        contents: file.contents,
        mode: file.mode,
        ...(previousSha256 ? { expectedPreviousSha256: previousSha256 } : {}),
      });
    }

    // Auto-generate slash commands routing rule for Antigravity (AGY)
    const commandsRuleContent = generateCommandsRuleContent(artifactFiles);
    const commandsRuleRelPath = isGlobal
      ? 'rules/commands.md'
      : '.agents/rules/commands.md';
    assertPortableRelativePath(commandsRuleRelPath);
    const commandsRuleAbsPath = path.join(projectRoot, ...commandsRuleRelPath.split('/'));
    let previousCmdSha256: string | undefined;
    try {
      previousCmdSha256 = await sha256File(commandsRuleAbsPath);
    } catch {
      // New file
    }
    writes.push({
      root: projectRoot,
      relativePath: commandsRuleRelPath,
      contents: Buffer.from(commandsRuleContent, 'utf8'),
      mode: 0o644,
      ...(previousCmdSha256 ? { expectedPreviousSha256: previousCmdSha256 } : {}),
    });

    const ownership = await loadProjectRuntimeOwnership(projectRoot);
    const nextOwnership: ProjectRuntimeOwnershipV1 = {
      version: PROJECT_RUNTIME_OWNERSHIP_VERSION,
      runtime: 'agy',
      projectDirectory: projectRoot,
      marketplaceName: 'antigravity',
      marketplacePath: path.join(agentsDir, 'plugins.json'),
      marketplaceSha256: sha256Bytes('antigravity'),
      providerSource: { kind: 'directory', path: agentsDir },
      plugins: {
        ...(ownership?.state.plugins ?? {}),
        [pluginReference]: {
          kitId: input.kitId,
          version: input.version,
          enabled: true,
        },
      },
      residues: { ...(ownership?.state.residues ?? {}) },
      updatedAt: new Date().toISOString(),
    };

    const ownershipContents = serializeProjectRuntimeOwnership(nextOwnership);
    const ownershipWrite: TransactionFileWrite = {
      root: projectRoot,
      relativePath: PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
      contents: ownershipContents,
      mode: 0o600,
      ...(ownership ? { expectedPreviousSha256: ownership.sha256 } : {}),
    };

    return {
      projectRoot,
      projectionRoot: agentsDir,
      pluginLabel,
      pluginReference,
      writes,
      metadataWrites: [ownershipWrite],
      projectOwnership: {
        projectId: `project:${projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        path: path.join(projectRoot, ...PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH.split('/')),
        ...(ownership ? { previousSha256: ownership.sha256 } : {}),
        nextSha256: sha256Bytes(ownershipContents),
      },
      externalStep: {
        id: `antigravity:project-plugin:${pluginReference}`,
        apply: async () => undefined,
        verify: async () => undefined,
        compensate: async () => undefined,
      },
    };
  }

  async prepareUninstall(
    input: RuntimeUnprojectionInput,
  ): Promise<PreparedRuntimeUnprojection> {
    const isGlobal = input.scope === 'global';
    const projectRoot = isGlobal
      ? await canonicalizeRoot(path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'config'))
      : await canonicalizeRoot(path.resolve(input.projectDirectory));
    const agentsDir = isGlobal
      ? projectRoot
      : path.join(projectRoot, '.agents');

    const pluginLabel = isGlobal ? '.gemini/config' : '.agents';
    const pluginReference = `agy-${input.kitId}@antigravity`;
    const ownership = await loadProjectRuntimeOwnership(projectRoot);

    const nextPlugins = { ...(ownership?.state.plugins ?? {}) };
    delete nextPlugins[pluginReference];

    const nextOwnership: ProjectRuntimeOwnershipV1 = {
      version: PROJECT_RUNTIME_OWNERSHIP_VERSION,
      runtime: 'agy',
      projectDirectory: projectRoot,
      marketplaceName: 'antigravity',
      marketplacePath: path.join(agentsDir, 'plugins.json'),
      marketplaceSha256: sha256Bytes('antigravity'),
      providerSource: { kind: 'directory', path: agentsDir },
      plugins: nextPlugins,
      residues: { ...(ownership?.state.residues ?? {}) },
      updatedAt: new Date().toISOString(),
    };

    const ownershipContents = serializeProjectRuntimeOwnership(nextOwnership);
    const ownershipWrite: TransactionFileWrite = {
      root: projectRoot,
      relativePath: PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
      contents: ownershipContents,
      mode: 0o600,
      ...(ownership ? { expectedPreviousSha256: ownership.sha256 } : {}),
    };

    return {
      projectRoot,
      projectionRoot: agentsDir,
      pluginLabel,
      pluginReference,
      writes: [],
      metadataWrites: [ownershipWrite],
      projectOwnership: {
        projectId: `project:${projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        path: path.join(projectRoot, ...PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH.split('/')),
        previousSha256: ownership?.sha256 ?? '',
        nextSha256: sha256Bytes(ownershipContents),
      },
      sharedConfigResidue: false,
      externalStep: {
        id: `antigravity:unproject-plugin:${pluginReference}`,
        apply: async () => undefined,
        verify: async () => undefined,
        compensate: async () => undefined,
      },
    };
  }
}

interface CollectedArtifactFile {
  relativePath: string;
  contents: Buffer;
  mode: number;
}

async function collectArtifactFiles(artifactDirectory: string): Promise<CollectedArtifactFile[]> {
  const files: CollectedArtifactFile[] = [];
  let totalBytes = 0;

  async function walk(currentDir: string, relativeDir = ''): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        totalBytes += stat.size;
        if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) {
          throw new KkError('Kit artifact exceeds file or size limit.', {
            code: 'invalid_input',
            exitCode: EXIT_CODES.invalidInput,
          });
        }
        let contents = await fs.readFile(full);
        if (/\.(md|markdown|txt|json|yaml|yml)$/i.test(entry.name)) {
          let text = contents.toString('utf8');
          text = text
            .replace(/~\/\.claude\//g, '~/.gemini/config/')
            .replace(/\.claude\//g, '.agents/')
            .replace(/claude plugin install/gi, 'kk init --runtime agy')
            .replace(/Claude Code/gi, 'Antigravity')
            .replace(/^name:\s*ak:([a-z0-9-]+)/gm, 'name: $1');
          contents = Buffer.from(text, 'utf8');
        }
        files.push({
          relativePath: rel,
          contents,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
        });
      }
    }
  }

  await walk(artifactDirectory);
  return files;
}

function unsupported(message: string): KkError {
  return new KkError(message, {
    code: 'unsupported_environment',
    exitCode: EXIT_CODES.invalidInput,
  });
}

function generateCommandsRuleContent(artifactFiles: CollectedArtifactFile[]): string {
  const skillNames = new Set<string>();
  const skillDescriptions = new Map<string, string>();

  for (const file of artifactFiles) {
    const match = file.relativePath.match(/^skills\/([^/]+)\/(?:SKILL\.md)?$/i);
    if (match?.[1]) {
      const skillName = match[1];
      skillNames.add(skillName);
      if (file.relativePath.endsWith('SKILL.md')) {
        const text = file.contents.toString('utf8');
        const descMatch = text.match(/description:\s*["']?([^"'\r\n]+)["']?/i);
        if (descMatch?.[1]) {
          skillDescriptions.set(skillName, descMatch[1].trim());
        }
      }
    }
  }

  const lines = [
    '# Custom Slash Command Routing',
    '',
    'When the user starts a message with any of the following slash commands, immediately execute the corresponding skill without asking for clarification:',
    '',
  ];

  for (const skill of Array.from(skillNames).sort()) {
    const cleanCmd = skill.replace(/^ak-/, '');
    const desc = skillDescriptions.get(skill) ?? `Invoke skill ${skill}`;
    lines.push(`- \`/${cleanCmd} [args]\`: Invoke skill \`${skill}\` - ${desc}`);
    if (cleanCmd !== skill) {
      lines.push(`- \`/${skill} [args]\`: Invoke skill \`${skill}\` - ${desc}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

