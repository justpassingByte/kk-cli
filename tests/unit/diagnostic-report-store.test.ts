import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticReportUseCase } from '../../src/application/diagnostic-report-use-case.js';
import { DiagnosticReportStore } from '../../src/infrastructure/support/diagnostic-report-store.js';

describe('DiagnosticReportStore', () => {
  it('loads only the exact reviewed bytes and rejects later changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-report-store-'));
    const store = new DiagnosticReportStore(root);
    try {
      const saved = await store.save('github', 'reviewed report\n');
      expect((await store.load(saved.id)).body).toBe('reviewed report\n');
      await writeFile(saved.bodyPath, 'changed report\n');
      await expect(store.load(saved.id)).rejects.toMatchObject({
        code: 'security_error',
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('binds the approved delivery destination to the reviewed report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-report-destination-'));
    const store = new DiagnosticReportStore(root);
    try {
      const saved = await store.save('email', 'reviewed report\n');
      const metadataPath = path.join(root, `${saved.id}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        destination: string;
      };
      metadata.destination = 'github';
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      await expect(store.load(saved.id)).rejects.toMatchObject({
        code: 'not_found',
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('previews a scrubbed report without submitting it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-report-preview-'));
    const store = new DiagnosticReportStore(root);
    const useCase = new DiagnosticReportUseCase(
      {
        execute: async () => ({
          kind: 'doctor.report',
          message: 'done',
          data: {
            state: 'warnings',
            leaked: 'Authorization: Bearer secret-token',
            home: '/Users/alice/project',
          },
        }),
      },
      store,
      '0.1.0-beta.0',
    );

    try {
      const result = await useCase.prepare('github');
      const preview = String(result.data['preview']);
      expect(preview).not.toContain('secret-token');
      expect(preview).not.toContain('/Users/alice');
      expect(result.data).toMatchObject({ destination: 'github', submitted: false });
      expect(await readFile(String(result.data['path']), 'utf8')).toBe(preview);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('submits the exact body already verified by the report store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-report-submit-'));
    const store = new DiagnosticReportStore(root);
    const saved = await store.save(
      'github',
      '# report\n\n{"state":"warnings","value":"reviewed"}\n',
    );
    let submittedBody = '';
    let reviewedPath = '';
    const useCase = new DiagnosticReportUseCase(
      {
        execute: async () => ({
          kind: 'doctor.report',
          message: 'unused',
          data: {},
        }),
      },
      store,
      '0.1.0-beta.0',
      async (body, state, reportPath) => {
        submittedBody = body;
        reviewedPath = reportPath || '';
        expect(state).toBe('warnings');
        return 'https://github.com/bestagentkits/agentkit-support/issues/1';
      },
    );

    try {
      const result = await useCase.submit(saved.id, true);
      expect(submittedBody).toBe(saved.body);
      expect(reviewedPath).toBe(saved.bodyPath);
      expect(result.data).toMatchObject({ submitted: true });
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
