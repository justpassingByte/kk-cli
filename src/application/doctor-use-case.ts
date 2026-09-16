import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CommandResult } from '../domain/contracts/command-result.js';
import {
  summarizeDiagnostics,
  type DiagnosticCheck,
} from '../domain/diagnostics/diagnostic-check.js';
import type { CredentialStore } from '../infrastructure/credentials/credential-types.js';
import type { KkPaths } from '../infrastructure/paths/kk-paths.js';
import {
  discoverKkExecutables,
  type KkExecutableCandidate,
} from '../infrastructure/packages/executable-discovery.js';
import { inspectTransactionJournals } from '../infrastructure/filesystem/transaction-journal.js';
import { executeNpmCommand } from '../infrastructure/packages/npm-command-runner.js';


export interface DoctorDependencies {
  paths: KkPaths;
  credentialStore: CredentialStore;
  discoverExecutables?: () => Promise<KkExecutableCandidate[]>;
  inspectTransactions?: typeof inspectTransactionJournals;
  now?: () => Date;
  checkProjectRuntimes?: () => Promise<DiagnosticCheck>;
}

export class DoctorUseCase {
  constructor(private readonly dependencies: DoctorDependencies) {}

  async execute(): Promise<CommandResult> {
    const checks = await Promise.all([
      this.isolateCheck('node', () => this.checkNode()),
      this.isolateCheck('npm', () => this.checkNpm()),
      this.isolateCheck('kk_home', () => this.checkKkHome()),
      this.isolateCheck('login', () => this.checkLogin()),
      this.isolateCheck('kk_path', () => this.checkExecutables()),
      this.isolateCheck('recovery', () => this.checkRecoveryReceipts()),
      this.isolateCheck('project_plugins', () =>
        this.dependencies.checkProjectRuntimes
          ? this.dependencies.checkProjectRuntimes()
          : Promise.resolve({
              id: 'project_plugins',
              status: 'ok',
              summary: 'Project plugin runtime inspection is unavailable.',
            }),
      ),
    ]);
    const summary = summarizeDiagnostics(checks);
    const state = summary.fail > 0 ? 'needs_attention' : summary.warn > 0 ? 'warnings' : 'healthy';

    return {
      kind: 'doctor.report',
      data: { state, summary, checks },
      message:
        state === 'healthy'
          ? 'KK is ready.'
          : `Doctor found ${summary.fail} failure(s) and ${summary.warn} warning(s).`,
      humanLines: checks.flatMap((check) => [
        `${statusMarker(check.status)} ${check.summary}`,
        ...(check.remediation ? [`  Next: ${check.remediation}`] : []),
      ]),
    };
  }

  private async checkNode(): Promise<DiagnosticCheck> {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    const supported = (major === 22 && minor >= 14) || major >= 24;
    return supported
      ? { id: 'node', status: 'ok', summary: `Node.js ${process.versions.node}` }
      : {
          id: 'node',
          status: 'fail',
          summary: `Node.js ${process.versions.node} is unsupported.`,
          remediation: 'Install Node.js 22.14+ or Node.js 24+.',
        };
  }

  private async checkNpm(): Promise<DiagnosticCheck> {
    try {
      const { stdout } = await executeNpmCommand(['--version'], {
        timeout: 5_000,
      });
      return { id: 'npm', status: 'ok', summary: `npm ${stdout.trim()}` };
    } catch {
      return {
        id: 'npm',
        status: 'fail',
        summary: 'npm was not found on PATH.',
        remediation: 'Install npm with a supported Node.js release.',
      };
    }
  }

  private async checkKkHome(): Promise<DiagnosticCheck> {
    try {
      await access(this.dependencies.paths.home, constants.R_OK | constants.W_OK);
      return { id: 'kk_home', status: 'ok', summary: 'KK home is writable.' };
    } catch {
      return {
        id: 'kk_home',
        status: 'warn',
        summary: 'KK home does not exist yet or is not writable.',
        remediation: 'Run kk init. If it fails, verify permissions for the KK home directory.',
      };
    }
  }

  private async checkLogin(): Promise<DiagnosticCheck> {
    try {
      const credential = await this.dependencies.credentialStore.load();
      if (!credential) {
        return {
          id: 'login',
          status: 'warn',
          summary: 'No saved login.',
          remediation: 'Run kk login before installing private kits.',
        };
      }
      const now = (this.dependencies.now?.() || new Date()).getTime();
      const accessExpiry = parseExpiry(credential.accessTokenExpiresAt);
      const refreshExpiry = parseExpiry(credential.refreshTokenExpiresAt);
      const hasRefreshFallback =
        Boolean(credential.refreshToken) &&
        (refreshExpiry === undefined || refreshExpiry > now);
      const hasApiKeyFallback = Boolean(credential.apiKey);

      if (
        credential.refreshToken &&
        refreshExpiry !== undefined &&
        refreshExpiry <= now &&
        !hasApiKeyFallback
      ) {
        return {
          id: 'login',
          status: 'fail',
          summary: 'The saved login session has expired.',
          remediation: 'Run kk login again.',
          details: {
            auth_method: credential.authMethod,
            refresh_session: true,
          },
        };
      }
      if (accessExpiry !== undefined && accessExpiry <= now) {
        if (hasRefreshFallback || hasApiKeyFallback) {
          return {
            id: 'login',
            status: 'warn',
            summary: 'The access token expired, but kk can refresh it on the next request.',
            remediation: 'Retry the intended command. If refresh fails, run kk login.',
            details: {
              auth_method: credential.authMethod,
              refresh_session: hasRefreshFallback,
              api_key_remint: hasApiKeyFallback,
            },
          };
        }
        return {
          id: 'login',
          status: 'fail',
          summary: 'The saved login has expired.',
          remediation: 'Run kk login again.',
          details: {
            auth_method: credential.authMethod,
            refresh_session: false,
          },
        };
      }
      if (credential.refreshToken && refreshExpiry === undefined) {
        return {
          id: 'login',
          status: 'warn',
          summary: 'The saved refresh session has no verifiable expiry.',
          remediation: 'Run kk login to replace this legacy credential.',
          details: {
            auth_method: credential.authMethod,
            refresh_session: true,
          },
        };
      }
      if (accessExpiry === undefined) {
        return {
          id: 'login',
          status: 'warn',
          summary: 'The saved access token has no verifiable expiry.',
          remediation: 'Run kk login to replace this legacy credential.',
          details: {
            auth_method: credential.authMethod,
            refresh_session: hasRefreshFallback,
          },
        };
      }
      return {
        id: 'login',
        status: 'ok',
        summary: `Signed in using ${credential.authMethod}.`,
        details: {
          auth_method: credential.authMethod,
          refresh_session: Boolean(credential.refreshToken),
        },
      };
    } catch {
      return {
        id: 'login',
        status: 'fail',
        summary: 'Saved login could not be read safely.',
        remediation: 'Run kk logout, then kk login.',
      };
    }
  }

  private async checkExecutables(): Promise<DiagnosticCheck> {
    const candidates = await (
      this.dependencies.discoverExecutables || discoverKkExecutables
    )();
    const npmCandidates = candidates.filter((candidate) => candidate.kind === 'npm');
    const competing = candidates.filter((candidate) => candidate.kind !== 'npm');
    if (npmCandidates.length === 1 && competing.length === 0) {
      return {
        id: 'kk_path',
        status: 'ok',
        summary: 'One npm-managed kk executable is active on PATH.',
        details: { candidates: sanitizeCandidates(candidates) },
      };
    }
    if (candidates.length === 0) {
      return {
        id: 'kk_path',
        status: 'fail',
        summary: 'No kk executable was found on PATH.',
        remediation: 'Run npm install --global github:justpassingByte/kk-cli.',
      };
    }
    return {
      id: 'kk_path',
      status: 'warn',
      summary: `${candidates.length} kk executable candidates were found on PATH.`,
      remediation: 'Run kk migrate for copy-ready PATH guidance.',
      details: { candidates: sanitizeCandidates(candidates) },
    };
  }

  private async checkRecoveryReceipts(): Promise<DiagnosticCheck> {
    const [entries, journals] = await Promise.all([
      readdir(this.dependencies.paths.recovery).catch(() => []),
      (
        this.dependencies.inspectTransactions || inspectTransactionJournals
      )(this.dependencies.paths.snapshots),
    ]);
    if (journals.pending > 0 || journals.invalid > 0) {
      return {
        id: 'recovery',
        status: 'fail',
        summary: `${journals.pending} interrupted and ${journals.invalid} invalid transaction journal(s) need recovery.`,
        remediation:
          'Retry the lifecycle command to recover safely. If it remains blocked, prepare a scrubbed support report.',
        details: {
          pending_journals: journals.pending,
          invalid_journals: journals.invalid,
          receipt_count: entries.length,
        },
      };
    }
    return entries.length === 0
      ? { id: 'recovery', status: 'ok', summary: 'No pending recovery receipt.' }
      : {
          id: 'recovery',
          status: 'warn',
          summary: `${entries.length} recovery receipt(s) need review.`,
          remediation: 'Run kk doctor --verbose and review the recovery directory before retrying.',
          details: { receipt_count: entries.length },
        };
  }

  private async isolateCheck(
    id: string,
    check: () => Promise<DiagnosticCheck>,
  ): Promise<DiagnosticCheck> {
    try {
      return await check();
    } catch {
      return {
        id,
        status: 'fail',
        summary: `Doctor could not complete the ${id.replaceAll('_', ' ')} check.`,
        remediation: 'Retry kk doctor. If this persists, prepare a diagnostic report for support.',
      };
    }
  }
}

function parseExpiry(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const expiry = Date.parse(value);
  return Number.isFinite(expiry) ? expiry : undefined;
}

function sanitizeCandidates(candidates: KkExecutableCandidate[]) {
  return candidates.map((candidate, index) => ({
    precedence: index + 1,
    kind: candidate.kind,
    package_version: candidate.packageVersion,
    path: candidate.path,
    real_path: candidate.realPath,
  }));
}

function statusMarker(status: DiagnosticCheck['status']): string {
  if (status === 'ok') return '✓';
  if (status === 'warn') return '!';
  return '✗';
}
