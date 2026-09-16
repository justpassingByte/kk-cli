import { describe, expect, it } from 'vitest';
import { normalizeArgv } from '../../src/cli/argv-normalization.js';
import { normalizeGlobalOptions } from '../../src/cli/global-options.js';

describe('CLI argv contract', () => {
  it('maps kk kit init to the same init route without changing flags', () => {
    expect(normalizeArgv(['node', 'kk', 'kit', 'init', '--runtime', 'codex'])).toEqual([
      'node',
      'kk',
      'init',
      '--runtime',
      'codex',
    ]);
  });

  it('maps the kit init alias after leading global flags', () => {
    expect(
      normalizeArgv([
        'node',
        'kk',
        '--json',
        '-q',
        'kit',
        'init',
        '--scope',
        'project',
      ]),
    ).toEqual([
      'node',
      'kk',
      '--json',
      '-q',
      'init',
      '--scope',
      'project',
    ]);
  });

  it('does not reinterpret kit init after an unknown option', () => {
    const input = ['node', 'kk', '--project-dir', 'kit', 'init'];
    expect(normalizeArgv(input)).toBe(input);
  });

  it('makes JSON non-interactive and honors CAC negated options', () => {
    expect(normalizeGlobalOptions({ json: true })).toMatchObject({
      json: true,
      noInteractive: true,
    });
    expect(normalizeGlobalOptions({ interactive: false })).toMatchObject({
      noInteractive: true,
    });
  });
});
