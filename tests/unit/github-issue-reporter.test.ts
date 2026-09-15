import { describe, expect, it } from 'vitest';
import { createSupportIssue } from '../../src/infrastructure/support/github-issue-reporter.js';

describe('createSupportIssue', () => {
  it('passes the reviewed report through stdin instead of rereading a path', async () => {
    const reviewedBody = '# exact reviewed bytes\n';
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];

    const url = await createSupportIssue(
      reviewedBody,
      'warnings',
      '/private/report.md',
      async (command, args, stdin) => {
        calls.push({ command, args, stdin });
        return {
          stdout: 'https://github.com/bestagentkits/agentkit-support/issues/1\n',
        };
      },
    );

    expect(url).toBe('https://github.com/bestagentkits/agentkit-support/issues/1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'gh',
      stdin: reviewedBody,
    });
    expect(calls[0]?.args).toContain('--body-file');
    expect(calls[0]?.args).toContain('-');
    expect(calls[0]?.args).not.toContain('/private/report.md');
  });
});
