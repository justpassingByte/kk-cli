import { spawn } from 'node:child_process';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';

const SUPPORT_REPOSITORY = 'bestagentkits/agentkit-support';
const MAX_GH_OUTPUT_BYTES = 64 * 1024;

export type IssueProcessRunner = (
  command: string,
  args: string[],
  stdin: string,
) => Promise<{ stdout: string }>;

export async function createSupportIssue(
  body: string,
  state: string,
  reviewedReportPath?: string,
  run: IssueProcessRunner = runWithStdin,
): Promise<string> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'issue',
        'create',
        '--repo',
        SUPPORT_REPOSITORY,
        '--title',
        `ak doctor report: ${process.platform} ${state}`,
        '--body-file',
        '-',
      ],
      body,
    );
    return stdout.trim();
  } catch (error) {
    throw new AkError('GitHub could not create the support issue.', {
      code: 'dependency_unavailable',
      exitCode: EXIT_CODES.dependency,
      remediation: reviewedReportPath
        ? `Install and authenticate gh, then retry. Your reviewed report is still at ${reviewedReportPath}.`
        : 'Install and authenticate gh, then retry.',
      cause: error,
    });
  }
}

async function runWithStdin(
  command: string,
  args: string[],
  stdin: string,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('gh timed out while creating the support issue.'));
    }, 30_000);

    child.once('error', (error) => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_GH_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_GH_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (outputBytes > MAX_GH_OUTPUT_BYTES) {
        finish(new Error('gh returned more output than the safety limit.'));
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `gh exited with code ${code ?? 'unknown'}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
    });
    child.stdin.on('error', () => {
      // A failed process can close stdin before its exit event reports the useful error.
    });
    child.stdin.end(stdin, 'utf8');
  });
}
