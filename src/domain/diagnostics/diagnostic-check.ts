export type DiagnosticStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export function summarizeDiagnostics(checks: DiagnosticCheck[]): {
  ok: number;
  warn: number;
  fail: number;
} {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { ok: 0, warn: 0, fail: 0 },
  );
}
