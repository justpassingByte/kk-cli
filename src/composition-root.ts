import { AgentKitApiClient } from './infrastructure/auth/agentkit-api-client.js';
import { SessionManager } from './infrastructure/auth/session-manager.js';
import { FileCredentialStore } from './infrastructure/credentials/file-credential-store.js';
import { resolveKkPaths } from './infrastructure/paths/kk-paths.js';
import { ClackPromptService } from './presentation/prompt-service.js';
import { LoginUseCase } from './application/login-use-case.js';
import { LogoutUseCase } from './application/logout-use-case.js';
import { DoctorUseCase } from './application/doctor-use-case.js';
import { DiagnosticReportUseCase } from './application/diagnostic-report-use-case.js';
import { DiagnosticReportStore } from './infrastructure/support/diagnostic-report-store.js';
import { readPackageMetadata } from './package-metadata.js';
import { InstalledKitStore } from './infrastructure/installed-kits/installed-kit-store.js';
import { LocalFilesystemTransaction } from './infrastructure/filesystem/local-filesystem-transaction.js';
import { RemoteRegistryClient } from './infrastructure/registry/remote-registry-client.js';
import { downloadAndExtractVerifiedKit } from './infrastructure/registry/verified-artifact-pipeline.js';
import { ClaudeCodeProjectPluginProjector } from './infrastructure/runtime/claude-code-project-plugin-projector.js';
import { InitUseCase } from './application/init-use-case.js';
import { UninstallUseCase } from './application/uninstall-use-case.js';
import { NpmRuntimeManager } from './infrastructure/packages/npm-runtime-manager.js';
import { FreshRuntimeHandoff } from './infrastructure/packages/fresh-runtime-handoff.js';
import { UpdateUseCase } from './application/update-use-case.js';
import { MigrateUseCase } from './application/migrate-use-case.js';
import { discoverLegacyCk } from './infrastructure/migration/legacy-ck-discovery.js';
import { discoverKkExecutables } from './infrastructure/packages/executable-discovery.js';
import { ClaudeCodeCliClient } from './infrastructure/runtime/claude-code-cli-client.js';
import { checkClaudeProjectRuntimes } from './infrastructure/runtime/project-runtime-doctor-check.js';
import { createClaudeExternalRecoveryHandler } from './infrastructure/runtime/claude-code-provider-recovery.js';

import { ExportUseCase } from './application/export-use-case.js';
import { downloadVerifiedArtifact } from './infrastructure/registry/verified-artifact-downloader.js';

export function createApplication() {
  const paths = resolveKkPaths();
  const api = new AgentKitApiClient(process.env['AGENTKIT_API_URL'] || 'https://agentkit.best');
  const credentialStore = new FileCredentialStore(paths.credentials);
  const prompts = new ClackPromptService();
  const sessionManager = new SessionManager(credentialStore, api);
  const metadata = readPackageMetadata();
  const installedKits = new InstalledKitStore(paths.installedKits);
  const claudeCode = new ClaudeCodeCliClient();
  const transaction = new LocalFilesystemTransaction(
    createClaudeExternalRecoveryHandler(claudeCode),
  );
  const projector = new ClaudeCodeProjectPluginProjector(claudeCode);
  const registry = new RemoteRegistryClient({
    baseUrl:
      process.env['AGENTKIT_REGISTRY_URL'] ||
      process.env['AGENTKIT_API_URL'] ||
      'https://agentkit.best',
    accessTokens: sessionManager,
    currentCliVersion: metadata.version,
  });
  const init = new InitUseCase(
    registry,
    downloadAndExtractVerifiedKit,
    paths,
    installedKits,
    transaction,
    prompts,
    projector,
  );
  const doctor = new DoctorUseCase({
    paths,
    credentialStore,
    checkProjectRuntimes: () =>
      checkClaudeProjectRuntimes(installedKits, claudeCode),
  });
  const exportKit = new ExportUseCase(registry, downloadVerifiedArtifact);
  const app = {
    paths,
    api,
    credentialStore,
    sessionManager,
    login: new LoginUseCase(api, credentialStore, prompts),
    logout: new LogoutUseCase(api, credentialStore, sessionManager),
    init,
    exportKit,
    uninstall: new UninstallUseCase(
      paths,
      installedKits,
      transaction,
      prompts,
      undefined,
      projector,
    ),
    update: new UpdateUseCase(
      metadata.version,
      new NpmRuntimeManager(),
      new FreshRuntimeHandoff(),
      installedKits,
      init,
      prompts,
      undefined,
      () => transaction.recover(paths.snapshots, paths.recovery),
    ),
    migrate: new MigrateUseCase(
      (options) => discoverLegacyCk(options),
      () => discoverKkExecutables(),
      init,
      prompts,
      () => transaction.recover(paths.snapshots, paths.recovery),
    ),
  };
  return {
    ...app,
    doctor,
    diagnosticReport: new DiagnosticReportUseCase(
      doctor,
      new DiagnosticReportStore(paths.supportReports),
      metadata.version,
    ),
  };
}

export type Application = ReturnType<typeof createApplication>;
