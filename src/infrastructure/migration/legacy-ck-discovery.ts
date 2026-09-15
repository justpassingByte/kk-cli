import os from 'node:os';
import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type {
  LegacyArtifactKind,
  LegacyCkDiscovery,
  LegacyCkFinding,
  LegacyKitFamily,
  LegacyRuntime,
  LegacyScope,
} from '../../domain/migration/legacy-ck-types.js';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SKILL_ENTRIES = 10_000;

export interface LegacyDiscoveryOptions {
  home?: string;
  project?: string;
  claudeHome?: string;
}

export async function discoverLegacyCk(
  options: LegacyDiscoveryOptions = {},
): Promise<LegacyCkDiscovery> {
  const home = path.resolve(options.home || os.homedir());
  const project = path.resolve(options.project || process.cwd());
  const claudeHome = path.resolve(options.claudeHome || path.join(home, '.claude'));
  const findings: LegacyCkFinding[] = [];
  const warnings: string[] = [];

  await scanClaudeRoot(claudeHome, 'global', findings, warnings);
  await scanClaudeRoot(path.join(project, '.claude'), 'project', findings, warnings);
  await scanSkillsRoot(
    path.join(home, '.agents', 'skills'),
    'codex',
    'global',
    findings,
    warnings,
  );
  await scanSkillsRoot(
    path.join(project, '.agents', 'skills'),
    'codex',
    'project',
    findings,
    warnings,
  );
  await inspectKnownPath(
    path.join(home, '.claudekit'),
    'claude-code',
    'global',
    'unknown',
    'source-root',
    'legacy ClaudeKit source root',
    findings,
  );
  await inspectKnownPath(
    path.join(project, '.claudekit'),
    'claude-code',
    'project',
    'unknown',
    'source-root',
    'legacy project ClaudeKit source root',
    findings,
  );

  return {
    schemaVersion: 1,
    findings: dedupeFindings(findings),
    warnings,
  };
}

async function scanClaudeRoot(
  root: string,
  scope: LegacyScope,
  findings: LegacyCkFinding[],
  warnings: string[],
): Promise<void> {
  const safeRoot = await canonicalTraversalRoot(root, 'Claude root', warnings);
  if (!safeRoot) return;

  for (const [directory, family] of [
    ['claudekit-engineer', 'engineer'],
    ['claudekit-marketing', 'marketing'],
  ] as const) {
    await inspectKnownPath(
      path.join(safeRoot, 'plugins', directory),
      'claude-code',
      scope,
      family,
      'plugin',
      'legacy ClaudeKit plugin directory',
      findings,
    );
  }
  await scanSkillsRoot(
    path.join(safeRoot, 'skills'),
    'claude-code',
    scope,
    findings,
    warnings,
  );

  for (const fileName of ['settings.json', 'settings.local.json']) {
    const filePath = path.join(safeRoot, fileName);
    const text = await readBoundedText(filePath);
    if (text === undefined || !looksLegacySettings(text)) continue;
    const families = familiesInText(text);
    for (const family of families.length > 0 ? families : ['unknown' as const]) {
      findings.push({
        runtime: 'claude-code',
        scope,
        family,
        kind: 'settings',
        path: filePath,
        confidence: family === 'unknown' ? 'low' : 'high',
        mutationSafe: false,
        reason: 'settings contains legacy ClaudeKit markers; manual key-level review required',
      });
    }
  }
}

async function scanSkillsRoot(
  skillsRoot: string,
  runtime: LegacyRuntime,
  scope: LegacyScope,
  findings: LegacyCkFinding[],
  warnings: string[],
): Promise<void> {
  const safeRoot = await canonicalTraversalRoot(skillsRoot, 'skills root', warnings);
  if (!safeRoot) return;
  const entries = await readdir(safeRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, MAX_SKILL_ENTRIES)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillPath = path.join(safeRoot, entry.name);
    const document = await readBoundedText(path.join(skillPath, 'SKILL.md'));
    if (document === undefined) continue;
    const family = familyFromSkill(document);
    if (!family) continue;
    findings.push({
      runtime,
      scope,
      family,
      kind: 'native-skill',
      path: skillPath,
      confidence: 'high',
      mutationSafe: false,
      reason: 'legacy CK/CKM skill identity; preserve until replacement install is verified',
    });
  }
}

async function canonicalTraversalRoot(
  root: string,
  label: string,
  warnings: string[],
): Promise<string | undefined> {
  const state = await lstat(root).catch(() => undefined);
  if (!state) return undefined;
  if (state.isSymbolicLink()) {
    warnings.push(`Skipped symlinked ${label}: ${root}`);
    return undefined;
  }
  if (!state.isDirectory()) return undefined;
  try {
    return await realpath(root);
  } catch {
    warnings.push(`Could not canonicalize ${label}: ${root}`);
    return undefined;
  }
}

async function inspectKnownPath(
  candidatePath: string,
  runtime: LegacyRuntime,
  scope: LegacyScope,
  family: LegacyKitFamily,
  kind: LegacyArtifactKind,
  reason: string,
  findings: LegacyCkFinding[],
): Promise<void> {
  const state = await lstat(candidatePath).catch(() => undefined);
  if (!state) return;
  findings.push({
    runtime,
    scope,
    family,
    kind,
    path: candidatePath,
    confidence: state.isSymbolicLink() ? 'low' : 'high',
    mutationSafe: false,
    reason: state.isSymbolicLink() ? `${reason}; symlink requires manual review` : reason,
  });
}

async function readBoundedText(filePath: string): Promise<string | undefined> {
  const state = await lstat(filePath).catch(() => undefined);
  if (!state?.isFile() || state.size > MAX_CONFIG_BYTES) return undefined;
  return readFile(filePath, 'utf8').catch(() => undefined);
}

function familyFromSkill(document: string): LegacyKitFamily | undefined {
  const frontmatter = document.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const name = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
  if (!name) return undefined;
  if (/^(ckm:|ckm-)/i.test(name)) return 'marketing';
  if (/^(ck:|ck-)/i.test(name)) return 'engineer';
  return undefined;
}

function looksLegacySettings(text: string): boolean {
  return /claudekit(?:-engineer|-marketing)?/i.test(text);
}

function familiesInText(text: string): LegacyKitFamily[] {
  const families: LegacyKitFamily[] = [];
  if (/claudekit-engineer/i.test(text)) families.push('engineer');
  if (/claudekit-marketing/i.test(text)) families.push('marketing');
  return families;
}

function dedupeFindings(findings: LegacyCkFinding[]): LegacyCkFinding[] {
  const unique = new Map<string, LegacyCkFinding>();
  for (const finding of findings) {
    unique.set(`${finding.runtime}:${finding.scope}:${finding.kind}:${finding.path}`, finding);
  }
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}
