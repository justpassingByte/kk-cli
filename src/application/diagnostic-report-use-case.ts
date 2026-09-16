import os from 'node:os';
import type { CommandResult } from '../domain/contracts/command-result.js';
import { KkError, EXIT_CODES } from '../domain/contracts/kk-error.js';
import { redactReport } from '../domain/diagnostics/redact-report.js';
import type {
  DiagnosticReportStore,
  ReportDestination,
} from '../infrastructure/support/diagnostic-report-store.js';
import { createSupportIssue } from '../infrastructure/support/github-issue-reporter.js';
import { writeSupportEmailDraft } from '../infrastructure/support/email-draft-writer.js';

type IssueReporter = (
  body: string,
  state: string,
  reviewedReportPath?: string,
) => Promise<string>;

export class DiagnosticReportUseCase {
  constructor(
    private readonly doctor: {
      execute(): Promise<CommandResult>;
    },
    private readonly store: DiagnosticReportStore,
    private readonly cliVersion: string,
    private readonly issueReporter: IssueReporter = createSupportIssue,
  ) {}

  async prepare(destination: ReportDestination): Promise<CommandResult> {
    const doctor = await this.doctor.execute();
    const raw = buildReport(this.cliVersion, doctor.data);
    const redacted = redactReport(raw, {
      redactEmails: true,
      redactPaths: true,
    });
    const stored = await this.store.save(destination, redacted.text);
    const next =
      destination === 'file'
        ? undefined
        : `kk doctor --submit ${stored.id} --yes`;
    return {
      kind: 'doctor.report_preview',
      data: {
        report_id: stored.id,
        destination,
        sha256: stored.sha256,
        path: stored.bodyPath,
        preview: stored.body,
        replacements: redacted.replacements,
        submitted: false,
        ...(next ? { submit_command: next } : {}),
      },
      message:
        destination === 'file'
          ? `Saved a scrubbed diagnostic report to ${stored.bodyPath}.`
          : 'Review the exact report below. Nothing has been sent.',
      humanLines: [
        '',
        stored.body,
        ...(next ? ['', `Send this exact report: ${next}`] : []),
      ],
    };
  }

  async submit(id: string, yes: boolean): Promise<CommandResult> {
    if (!yes) {
      throw new KkError('Sending a diagnostic report requires explicit confirmation.', {
        code: 'cancelled',
        exitCode: EXIT_CODES.cancelled,
        remediation: `Review the saved report, then run kk doctor --submit ${id} --yes.`,
      });
    }
    const report = await this.store.load(id);
    if (report.destination === 'file') {
      throw new KkError('This report was saved for local use and has no send destination.', {
        code: 'invalid_input',
        exitCode: EXIT_CODES.invalidInput,
      });
    }
    if (report.destination === 'email') {
      const draftPath = await writeSupportEmailDraft(report);
      return {
        kind: 'doctor.email_draft',
        data: {
          report_id: report.id,
          destination: 'support@agentkit.best',
          draft_path: draftPath,
          sent: false,
        },
        message: `Email draft created at ${draftPath}. Open it and send when ready.`,
      };
    }
    const state = extractDoctorState(report.body);
    const issueUrl = await this.issueReporter(report.body, state, report.bodyPath);
    return {
      kind: 'doctor.issue_created',
      data: {
        report_id: report.id,
        destination: 'bestagentkits/agentkit-support',
        issue_url: issueUrl,
        submitted: true,
      },
      message: `Support issue created: ${issueUrl}`,
    };
  }
}

function buildReport(version: string, doctorData: Record<string, unknown>): string {
  return [
    '# AgentKit CLI diagnostic report',
    '',
    '## Environment',
    '',
    `- ak: ${version}`,
    `- Node.js: ${process.versions.node}`,
    `- OS: ${process.platform} ${os.release()} (${process.arch})`,
    `- shell: ${process.env['TERM_PROGRAM'] || process.env['SHELL'] || 'unknown'}`,
    `- CI: ${Boolean(process.env['CI'])}`,
    '',
    '## Doctor result',
    '',
    '```json',
    JSON.stringify(doctorData, undefined, 2),
    '```',
    '',
  ].join('\n');
}

function extractDoctorState(body: string): string {
  const match = body.match(/"state":\s*"([^"]+)"/);
  return match?.[1] || 'unknown';
}
