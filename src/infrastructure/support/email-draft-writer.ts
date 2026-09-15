import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredDiagnosticReport } from './diagnostic-report-store.js';

export async function writeSupportEmailDraft(report: StoredDiagnosticReport): Promise<string> {
  const draftPath = path.join(path.dirname(report.bodyPath), `${report.id}.eml`);
  const subject = `AgentKit support report ${report.id.slice(0, 8)}`;
  const message = [
    'To: support@agentkit.best',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    report.body,
  ].join('\r\n');
  await writeFile(draftPath, message, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return draftPath;
}
