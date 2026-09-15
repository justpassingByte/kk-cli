export interface RedactionOptions {
  redactEmails?: boolean;
  redactPaths?: boolean;
  environment?: NodeJS.ProcessEnv;
  pathReplacements?: Record<string, string>;
}

export interface RedactionResult {
  text: string;
  replacements: Record<string, number>;
}

const detectors: Array<[string, RegExp, string]> = [
  ['bearer_token', /(authorization:\s*bearer\s+)[^\s"',}\]]+/gi, '$1[redacted]'],
  ['agentkit_api_key', /\bak_live_[A-Za-z0-9_-]+\b/g, 'ak_live_[redacted]'],
  ['npm_token', /\bnpm_[A-Za-z0-9_-]{20,}\b/g, 'npm_[redacted]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]'],
  [
    'url_token',
    /([?&](?:token|artifact_token|download_token)=)[^&\s"',}\]]+/gi,
    '$1[redacted]',
  ],
  [
    'github_token',
    /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    '[redacted-github-token]',
  ],
  ['llm_api_key', /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g, 'sk-[redacted]'],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, 'xox[redacted]'],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted-aws-access-key]'],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIza[redacted]'],
  [
    'private_key',
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[redacted-private-key]',
  ],
  ['basic_auth_url', /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@'],
  [
    'secret_assignment',
    /(["']?(?:api[_-]?key|secret|password|passwd|pwd|token)["']?\s*[:=]\s*)["'][^"']{8,}["']/gi,
    '$1"[redacted]"',
  ],
  [
    'secret_assignment',
    /\b((?:api[_-]?key|secret|password|passwd|pwd|token)\s*[:=]\s*)[^\s,;}"'\]]{8,}/gi,
    '$1[redacted]',
  ],
];

export function redactReport(input: string, options: RedactionOptions = {}): RedactionResult {
  const replacements: Record<string, number> = {};
  let text = input;
  for (const [name, pattern, replacement] of detectors) {
    text = replaceAndCount(text, pattern, replacement, name, replacements);
  }
  if (options.redactEmails) {
    text = replaceAndCount(
      text,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '[redacted-email]',
      'email',
      replacements,
    );
  }
  if (options.redactPaths) text = redactLocalPaths(text, options, replacements);
  return { text, replacements };
}

function redactLocalPaths(
  input: string,
  options: RedactionOptions,
  counts: Record<string, number>,
): string {
  const environment = options.environment || process.env;
  const replacements = new Map<string, string>();
  for (const [key, marker] of Object.entries({
    HOME: '$HOME',
    USERPROFILE: '%USERPROFILE%',
    AGENTKIT_HOME: '$AGENTKIT_HOME',
    AGENTKIT_CLAUDE_HOME: '$AGENTKIT_CLAUDE_HOME',
    AGENTKIT_PLUGIN_DIR: '$AGENTKIT_PLUGIN_DIR',
    AGENTKIT_CODEX_SKILLS_ROOT: '$AGENTKIT_CODEX_SKILLS_ROOT',
    CODEX_HOME: '$CODEX_HOME',
    XDG_CONFIG_HOME: '$XDG_CONFIG_HOME',
    XDG_CACHE_HOME: '$XDG_CACHE_HOME',
    XDG_DATA_HOME: '$XDG_DATA_HOME',
  })) {
    const value = environment[key];
    if (isUsefulPrefix(value)) replacements.set(value, marker);
  }
  for (const [value, marker] of Object.entries(options.pathReplacements || {})) {
    if (isUsefulPrefix(value) && marker) replacements.set(value, marker);
  }

  let text = input;
  const ordered = [...replacements].sort(([left], [right]) => right.length - left.length);
  for (const [value, marker] of ordered) {
    for (const variant of new Set([
      value,
      value.replaceAll('\\', '/'),
      value.replaceAll('\\', '\\\\'),
    ])) {
      const count = text.split(variant).length - 1;
      if (count === 0) continue;
      counts['local_path'] = (counts['local_path'] || 0) + count;
      text = text.replaceAll(variant, marker);
    }
  }

  text = replaceAndCount(text, /\/Users\/[^/"'\s]+/g, '$HOME', 'local_path', counts);
  text = replaceAndCount(text, /\/home\/[^/"'\s]+/g, '$HOME', 'local_path', counts);
  text = replaceAndCount(
    text,
    /[A-Z]:\\Users\\[^\\/"'\s]+/gi,
    '%USERPROFILE%',
    'local_path',
    counts,
  );
  text = replaceAndCount(
    text,
    /[A-Z]:\\\\Users\\\\[^\\/"'\s]+/gi,
    '%USERPROFILE%',
    'local_path',
    counts,
  );
  return text;
}

function replaceAndCount(
  input: string,
  pattern: RegExp,
  replacement: string,
  detector: string,
  counts: Record<string, number>,
): string {
  const matches = input.match(pattern);
  if (!matches) return input;
  counts[detector] = (counts[detector] || 0) + matches.length;
  return input.replace(pattern, replacement);
}

function isUsefulPrefix(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed && trimmed.length >= 4 && trimmed !== '/' && trimmed !== '\\');
}
