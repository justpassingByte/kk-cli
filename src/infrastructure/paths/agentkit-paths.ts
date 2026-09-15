import os from 'node:os';
import path from 'node:path';

export interface AgentKitPaths {
  home: string;
  credentials: string;
  installedKits: string;
  locks: string;
  snapshots: string;
  recovery: string;
  supportReports: string;
}

export function resolveAgentKitPaths(environment: NodeJS.ProcessEnv = process.env): AgentKitPaths {
  const home = path.resolve(environment.AGENTKIT_HOME || path.join(os.homedir(), '.agentkit'));
  return {
    home,
    credentials: path.join(home, 'credentials.json'),
    installedKits: path.join(home, 'installed-kits.json'),
    locks: path.join(home, 'locks'),
    snapshots: path.join(home, 'snapshots'),
    recovery: path.join(home, 'recovery'),
    supportReports: path.join(home, 'support-reports'),
  };
}
