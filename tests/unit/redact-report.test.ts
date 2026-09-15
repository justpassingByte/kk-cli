import { describe, expect, it } from 'vitest';
import { redactReport } from '../../src/domain/diagnostics/redact-report.js';

describe('redactReport', () => {
  it('removes credential families while preserving useful report shape', () => {
    const input = [
      'Authorization: Bearer secret-token',
      'agentkit=ak_live_abcdefghijklmnopqrstuvwxyz',
      'npm=npm_abcdefghijklmnopqrstuvwxyz1234567890',
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.signature',
      'url=https://agentkit.best/download?token=secret&x=1',
      'github=ghp_abcdefghijklmnopqrstuvwxyz123456',
      'openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'PASSWORD=super-secret-value',
      '{"api_key":"secret-value-12345"}',
    ].join('\n');

    const result = redactReport(input);

    for (const secret of [
      'secret-token',
      'ak_live_abcdefghijklmnopqrstuvwxyz',
      'npm_abcdefghijklmnopqrstuvwxyz1234567890',
      'eyJhbGciOiJIUzI1NiJ9',
      'token=secret',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'super-secret-value',
      'secret-value-12345',
    ]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).toContain('"api_key":"[redacted]"');
    expect(result.replacements).toMatchObject({
      bearer_token: 1,
      agentkit_api_key: 1,
      npm_token: 1,
      jwt: 1,
      url_token: 1,
    });
  });

  it('redacts local home paths including escaped Windows paths', () => {
    const input =
      '{"mac":"/Users/alice/.agentkit","linux":"/home/bob/.agentkit","windows":"C:\\\\Users\\\\Carol\\\\.agentkit"}';
    const result = redactReport(input, {
      redactPaths: true,
      environment: {},
    });

    expect(result.text).not.toContain('/Users/alice');
    expect(result.text).not.toContain('/home/bob');
    expect(result.text).not.toContain('C:\\\\Users\\\\Carol');
    expect(result.replacements['local_path']).toBeGreaterThanOrEqual(3);
  });
});
