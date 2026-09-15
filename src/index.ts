import { cac } from 'cac';
import { createApplication } from './composition-root.js';
import { registerAuthCommands } from './cli/register-auth-commands.js';
import { registerMaintenanceCommands } from './cli/register-maintenance-commands.js';
import { readPackageMetadata } from './package-metadata.js';
import { normalizeArgv } from './cli/argv-normalization.js';
import { registerKitLifecycleCommands } from './cli/register-kit-lifecycle-commands.js';
import { registerUpdateMigrateCommands } from './cli/register-update-migrate-commands.js';
import { consumeRuntimeHandoff } from './infrastructure/packages/fresh-runtime-handoff.js';

const metadata = readPackageMetadata();
const trustedRuntimeReadyVersion = await consumeRuntimeHandoff(metadata.version);
const cli = cac('kk');
const app = createApplication();

cli
  .option('-y, --yes', 'Confirm the proposed operation')
  .option('--no-interactive', 'Never prompt for input')
  .option('--json', 'Emit stable machine-readable JSON')
  .option('-q, --quiet', 'Only print errors')
  .option('-V, --verbose', 'Show diagnostic details');

registerAuthCommands(cli, app);
registerKitLifecycleCommands(cli, app);
registerUpdateMigrateCommands(cli, app, trustedRuntimeReadyVersion);
registerMaintenanceCommands(cli, app);

cli.help();
cli.version(metadata.version);

const argv = normalizeArgv(process.argv);
cli.parse(argv, { run: false });
await cli.runMatchedCommand();
