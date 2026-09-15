import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface PackageMetadata {
  name: string;
  version: string;
}

export function readPackageMetadata(): PackageMetadata {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = path.resolve(currentDirectory, '..', 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageMetadata;
}
