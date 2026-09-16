import os from 'node:os';
import path from 'node:path';

export interface KkPaths {
  home: string;
  credentials: string;
  installedKits: string;
  locks: string;
  snapshots: string;
  recovery: string;
  supportReports: string;
}

export function resolveKkPaths(environment: NodeJS.ProcessEnv = process.env): KkPaths {
  const home = path.resolve(environment.KK_HOME || path.join(os.homedir(), '.kk'));
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
