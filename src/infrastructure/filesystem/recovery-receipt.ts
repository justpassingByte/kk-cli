import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { TransactionMutation } from '../../domain/lifecycle/filesystem-transaction.js';
import { atomicWriteFile } from './atomic-write.js';
import { canonicalizeRoot } from './path-guard.js';

const MAX_RECORDED_FAILURES = 100;

export interface ExternalRecoveryFailure {
  phase: 'apply' | 'verify' | 'transaction' | 'compensate';
  error: string;
  stepId?: string;
  code?: string;
  remediation?: string;
}

export async function writeRecoveryReceipt(options: {
  recoveryDirectory: string;
  transactionId: string;
  snapshotPath: string;
  failures: Array<{ mutation: TransactionMutation; error: string }>;
  externalFailures?: ExternalRecoveryFailure[];
}): Promise<string> {
  await fs.mkdir(options.recoveryDirectory, { recursive: true, mode: 0o700 });
  const root = await canonicalizeRoot(options.recoveryDirectory);
  const relativePath = `recovery-${options.transactionId}-${randomUUID()}.json`;
  const recorded = options.failures.slice(0, MAX_RECORDED_FAILURES);
  const externalFailures = options.externalFailures ?? [];
  const recordedExternal = externalFailures.slice(0, MAX_RECORDED_FAILURES);
  const receipt = {
    version: 1,
    transactionId: options.transactionId,
    createdAt: new Date().toISOString(),
    snapshotPath: options.snapshotPath,
    failureCount: options.failures.length,
    externalFailureCount: externalFailures.length,
    truncated:
      recorded.length !== options.failures.length || recordedExternal.length !== externalFailures.length,
    failures: recorded,
    externalFailures: recordedExternal,
  };
  return atomicWriteFile(root, relativePath, `${JSON.stringify(receipt, null, 2)}\n`);
}
