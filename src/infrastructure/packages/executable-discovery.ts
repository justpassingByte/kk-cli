import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_WINDOWS_SHIM_BYTES = 32 * 1024;

export type KkExecutableKind = 'npm' | 'legacy_native_candidate' | 'unknown';

export interface KkExecutableCandidate {
  path: string;
  realPath: string;
  kind: KkExecutableKind;
  packageVersion?: string;
}

export async function discoverKkExecutables(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<KkExecutableCandidate[]> {
  const pathEntries = (environment.PATH || '')
    .split(platform === 'win32' ? ';' : path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const names =
    platform === 'win32'
      ? windowsExecutableNames(environment.PATHEXT)
      : ['kk'];
  const candidates = new Map<string, KkExecutableCandidate>();

  for (const directory of pathEntries) {
    for (const name of names) {
      const executablePath = path.resolve(directory, name);
      if (!(await isExecutable(executablePath, platform))) continue;
      const resolved = await realpath(executablePath).catch(() => executablePath);
      if (candidates.has(normalizeKey(resolved, platform))) continue;
      const classification = await classifyExecutable(resolved);
      candidates.set(normalizeKey(resolved, platform), {
        path: executablePath,
        realPath: resolved,
        ...classification,
      });
    }
  }

  return [...candidates.values()];
}

async function classifyExecutable(
  executablePath: string,
): Promise<Pick<KkExecutableCandidate, 'kind' | 'packageVersion'>> {
  const packageMetadata = await findOwningPackage(executablePath);
  if (packageMetadata?.name === 'kk-cli') {
    return {
      kind: 'npm',
      ...(packageMetadata.version ? { packageVersion: packageMetadata.version } : {}),
    };
  }
  const shimPackage = await findWindowsShimPackage(executablePath);
  if (shimPackage) {
    return {
      kind: 'npm',
      ...(shimPackage.version ? { packageVersion: shimPackage.version } : {}),
    };
  }

  const bytes = await readFile(executablePath).catch(() => undefined);
  if (bytes && isNativeExecutable(bytes)) return { kind: 'legacy_native_candidate' };
  return { kind: 'unknown' };
}

async function findWindowsShimPackage(
  executablePath: string,
): Promise<{ version?: string } | undefined> {
  if (path.extname(executablePath).toLowerCase() !== '.cmd') return undefined;
  const state = await lstat(executablePath).catch(() => undefined);
  if (!state?.isFile() || state.size > MAX_WINDOWS_SHIM_BYTES) return undefined;
  const shim = await readFile(executablePath, 'utf8').catch(() => undefined);
  if (!shim || !isBoundedNpmKkShim(shim)) return undefined;

  const candidateRoots = [
    path.join(path.dirname(executablePath), 'node_modules', 'kk-cli'),
  ];
  for (const packageRoot of candidateRoots) {
    const metadata = await readPackageMetadata(path.join(packageRoot, 'package.json'));
    if (metadata?.name === 'kk-cli') {
      return metadata.version ? { version: metadata.version } : {};
    }
  }
  return undefined;
}

function isBoundedNpmKkShim(shim: string): boolean {
  if (Buffer.byteLength(shim) > MAX_WINDOWS_SHIM_BYTES || shim.includes('\0')) return false;
  const invokesNode = /(?:^|[ "'])node(?:\.exe)?(?:["' ]|$)|%~?dp0%[\\/]node\.exe/i.test(
    shim,
  );
  const targetsPackage =
    /%~?dp0%[\\/]node_modules[\\/]kk-cli[\\/]bin[\\/]kk\.js/i.test(
      shim,
    );
  return invokesNode && targetsPackage && /%\*/.test(shim);
}

async function findOwningPackage(
  executablePath: string,
): Promise<{ name?: string; version?: string } | undefined> {
  let directory = path.dirname(executablePath);
  for (let depth = 0; depth < 6; depth += 1) {
    const packagePath = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      return {
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      };
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  return undefined;
}

async function readPackageMetadata(
  packagePath: string,
): Promise<
  { name?: string; version?: string; bin?: string } | undefined
> {
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    const bin =
      typeof parsed.bin === 'string'
        ? parsed.bin
        : isRecord(parsed.bin)
          ? (typeof parsed.bin['kk'] === 'string'
              ? parsed.bin['kk']
              : undefined)
          : undefined;
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(bin ? { bin: normalizePackagePath(bin) } : {}),
    };
  } catch {
    return undefined;
  }
}

async function isExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExecutableNames(pathExt: string | undefined): string[] {
  const extensions = (pathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((extension) => `kk${extension}`);
}

function normalizeKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function normalizePackagePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNativeExecutable(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes.subarray(0, 4).toString('hex');
  return (
    magic === '7f454c46' ||
    magic === 'feedface' ||
    magic === 'feedfacf' ||
    magic === 'cefaedfe' ||
    magic === 'cffaedfe' ||
    bytes.subarray(0, 2).toString('ascii') === 'MZ'
  );
}
