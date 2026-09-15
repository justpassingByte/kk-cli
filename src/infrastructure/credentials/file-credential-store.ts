import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import {
  storedCredentialSchema,
  type CredentialStore,
  type StoredCredential,
} from './credential-types.js';
import { atomicWriteFile } from '../filesystem/atomic-write.js';
import { removeFileDurably } from '../filesystem/durable-file-removal.js';

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly credentialPath: string) {}

  async load(): Promise<StoredCredential | null> {
    try {
      await this.recoverInterruptedSave();
      await fs.lstat(this.credentialPath);
      await this.assertPrivatePermissions();
      const raw = await fs.readFile(this.credentialPath, 'utf8');
      return storedCredentialSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof AkError) throw error;
      throw new AkError('Saved login is unreadable or corrupt.', {
        code: 'security_error',
        exitCode: EXIT_CODES.security,
        remediation: 'Run ak logout, then log in again.',
        cause: error,
      });
    }
  }

  async save(credential: StoredCredential): Promise<void> {
    const directory = path.dirname(this.credentialPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await protectCredentialPath(directory, true);
    await this.recoverInterruptedSave();
    const canonicalDirectory = await fs.realpath(directory);
    const artifacts = this.artifactPaths();
    await atomicWriteFile(
      canonicalDirectory,
      path.basename(this.credentialPath),
      `${JSON.stringify(credential, null, 2)}\n`,
      0o600,
      {
        temporaryRelativePath: path.basename(artifacts.next),
        displacedRelativePath: path.basename(artifacts.previous),
      },
      {
        afterTemporarySync: (temporaryPath) =>
          protectCredentialPath(temporaryPath, false),
      },
    );
    await protectCredentialPath(this.credentialPath, false);
    await removeFileDurably(artifacts.previous, { force: true });
  }

  async clear(): Promise<void> {
    const artifacts = this.artifactPaths();
    await removeFileDurably(this.credentialPath, { force: true });
    await removeFileDurably(artifacts.next, { force: true });
    await removeFileDurably(artifacts.previous, { force: true });
  }

  async withExclusive<T>(action: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.credentialPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await protectCredentialPath(directory, true);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(directory, {
        realpath: true,
        stale: 15_000,
        retries: { retries: 6, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      return await action();
    } catch (error) {
      if (release) throw error;
      throw new AkError('Another ak process is updating your login session.', {
        code: 'conflict',
        exitCode: EXIT_CODES.conflict,
        remediation: 'Wait for the other command to finish, then retry.',
        cause: error,
      });
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  private async assertPrivatePermissions(): Promise<void> {
    if (process.platform === 'win32') {
      await verifyWindowsAcl(path.dirname(this.credentialPath));
      await verifyWindowsAcl(this.credentialPath);
      return;
    }
    const directory = await fs.stat(path.dirname(this.credentialPath));
    if ((directory.mode & 0o077) !== 0) {
      throw insecurePermissions('Saved login directory permissions are too broad.');
    }
    const stat = await fs.stat(this.credentialPath);
    if ((stat.mode & 0o077) !== 0) {
      throw insecurePermissions('Saved login permissions are too broad.');
    }
  }

  private artifactPaths(): { next: string; previous: string } {
    const directory = path.dirname(this.credentialPath);
    const basename = path.basename(this.credentialPath);
    return {
      next: path.join(directory, `.${basename}.ak-next`),
      previous: path.join(directory, `.${basename}.ak-previous`),
    };
  }

  private async recoverInterruptedSave(): Promise<void> {
    const directory = path.dirname(this.credentialPath);
    const directoryExists = await pathExists(directory);
    if (!directoryExists) return;
    const artifacts = this.artifactPaths();
    const [targetExists, nextExists, previousExists] = await Promise.all([
      pathExists(this.credentialPath),
      pathExists(artifacts.next),
      pathExists(artifacts.previous),
    ]);

    if (nextExists) {
      const canonicalDirectory = await fs.realpath(directory);
      const contents = await readValidCredentialFile(artifacts.next);
      await protectCredentialPath(artifacts.next, false);
      if (previousExists) {
        await removeFileDurably(artifacts.previous, { force: true });
      }
      await atomicWriteFile(
        canonicalDirectory,
        path.basename(this.credentialPath),
        contents,
        0o600,
        {
          temporaryRelativePath: path.basename(artifacts.next),
          displacedRelativePath: path.basename(artifacts.previous),
        },
        {
          afterTemporarySync: (temporaryPath) =>
            protectCredentialPath(temporaryPath, false),
        },
      );
      await protectCredentialPath(this.credentialPath, false);
      await removeFileDurably(artifacts.previous, { force: true });
      return;
    }

    if (!targetExists && previousExists) {
      const canonicalDirectory = await fs.realpath(directory);
      const contents = await readValidCredentialFile(artifacts.previous);
      await protectCredentialPath(artifacts.previous, false);
      await atomicWriteFile(
        canonicalDirectory,
        path.basename(this.credentialPath),
        contents,
        0o600,
        {
          temporaryRelativePath: path.basename(artifacts.previous),
          displacedRelativePath: path.basename(artifacts.next),
        },
        {
          afterTemporarySync: (temporaryPath) =>
            protectCredentialPath(temporaryPath, false),
        },
      );
      await protectCredentialPath(this.credentialPath, false);
      return;
    }

    if (targetExists && previousExists) {
      await readValidCredentialFile(this.credentialPath);
      await removeFileDurably(artifacts.previous, { force: true });
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readValidCredentialFile(target: string): Promise<string> {
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Credential recovery artifact is not a regular file.');
  }
  const raw = await fs.readFile(target, 'utf8');
  storedCredentialSchema.parse(JSON.parse(raw));
  return raw;
}

const execFileAsync = promisify(execFile);

async function protectCredentialPath(target: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.chmod(target, directory ? 0o700 : 0o600);
    return;
  }
  const sid = await currentWindowsSid();
  const permission = directory ? `${sid}:(OI)(CI)(F)` : `${sid}:(F)`;
  try {
    await execFileAsync('icacls.exe', [
      target,
      '/inheritance:r',
      '/grant:r',
      permission,
    ], { windowsHide: true, timeout: 10_000 });
    await verifyWindowsAcl(target);
  } catch (error) {
    throw new AkError('Windows could not protect the saved login with a private ACL.', {
      code: 'security_error',
      exitCode: EXIT_CODES.security,
      remediation: 'Check your Windows account permissions, then run ak login again.',
      cause: error,
    });
  }
}

async function currentWindowsSid(): Promise<string> {
  const { stdout } = await execFileAsync(
    'whoami.exe',
    ['/user', '/fo', 'csv', '/nh'],
    { windowsHide: true, timeout: 10_000 },
  );
  const sid = stdout.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('Current Windows user SID was not found.');
  return `*${sid}`;
}

async function verifyWindowsAcl(target: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const encodedTarget = Buffer.from(target, 'utf16le').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$Target = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String("${encodedTarget}"))`,
    '$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$allowed = @($current, "S-1-5-18", "S-1-5-32-544")',
    '$attributes = [System.IO.File]::GetAttributes($Target)',
    'if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {',
    '  $item = [System.IO.DirectoryInfo]::new($Target)',
    '} else {',
    '  $item = [System.IO.FileInfo]::new($Target)',
    '}',
    '$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner',
    '$acl = $item.GetAccessControl($sections)',
    'if (-not $acl.AreAccessRulesProtected) { exit 5 }',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    'if ($allowed -notcontains $owner) { exit 6 }',
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    '$hasCurrent = $false',
    'foreach ($rule in $rules) {',
    '  if ($rule.AccessControlType -ne "Allow") { continue }',
    '  $sid = $rule.IdentityReference.Value',
    '  if ($sid -eq $current) { $hasCurrent = $true }',
    '  if ($allowed -notcontains $sid) { exit 3 }',
    '}',
    'if (-not $hasCurrent) { exit 4 }',
  ].join('; ');
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10_000 },
  );
}

function insecurePermissions(message: string): AkError {
  return new AkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Restrict the AgentKit home to your user account, then run ak login again.',
  });
}
