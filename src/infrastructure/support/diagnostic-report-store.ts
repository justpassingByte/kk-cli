import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';

export type ReportDestination = 'file' | 'github' | 'email';

export interface StoredDiagnosticReport {
  id: string;
  destination: ReportDestination;
  body: string;
  sha256: string;
  consentSha256: string;
  createdAt: string;
  bodyPath: string;
}

const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/u;

export class DiagnosticReportStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async save(destination: ReportDestination, body: string): Promise<StoredDiagnosticReport> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const bodyPath = path.join(this.root, `${id}.md`);
    const metadataPath = path.join(this.root, `${id}.json`);
    const consent = {
      id,
      destination,
      sha256: sha256(body),
      createdAt,
      bodyPath,
    };
    const record = {
      ...consent,
      consentSha256: sha256(JSON.stringify(consent)),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWrite(bodyPath, body);
    await atomicWrite(metadataPath, `${JSON.stringify(record, undefined, 2)}\n`);
    return { ...record, body };
  }

  async load(id: string): Promise<StoredDiagnosticReport> {
    if (!REPORT_ID.test(id)) throw invalidReport();
    const metadataPath = path.join(this.root, `${id}.json`);
    try {
      const metadata = parseMetadata(
        JSON.parse(await readFile(metadataPath, 'utf8')),
        id,
        this.root,
      );
      const consent = {
        id: metadata.id,
        destination: metadata.destination,
        sha256: metadata.sha256,
        createdAt: metadata.createdAt,
        bodyPath: metadata.bodyPath,
      };
      if (sha256(JSON.stringify(consent)) !== metadata.consentSha256) {
        throw invalidReport();
      }
      const body = await readFile(metadata.bodyPath, 'utf8');
      if (sha256(body) !== metadata.sha256) {
        throw new KkError('The diagnostic preview changed after it was approved.', {
          code: 'security_error',
          exitCode: EXIT_CODES.security,
          remediation: 'Run kk doctor --report again and review the new preview.',
        });
      }
      return { ...metadata, body };
    } catch (error) {
      if (error instanceof KkError) throw error;
      throw invalidReport();
    }
  }
}

function parseMetadata(
  value: unknown,
  id: string,
  root: string,
): Omit<StoredDiagnosticReport, 'body'> {
  if (
    !isRecord(value) ||
    value.id !== id ||
    (value.destination !== 'file' &&
      value.destination !== 'github' &&
      value.destination !== 'email') ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    typeof value.consentSha256 !== 'string' ||
    !SHA256.test(value.consentSha256) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.bodyPath !== path.join(root, `${id}.md`)
  ) {
    throw invalidReport();
  }
  return {
    id,
    destination: value.destination,
    sha256: value.sha256,
    consentSha256: value.consentSha256,
    createdAt: value.createdAt,
    bodyPath: value.bodyPath,
  };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidReport(): KkError {
  return new KkError('That diagnostic report was not found or is no longer valid.', {
    code: 'not_found',
    exitCode: EXIT_CODES.notFound,
    remediation: 'Run kk doctor --report again.',
  });
}
