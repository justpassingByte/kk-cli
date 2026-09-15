export function normalizeArgv(input: string[]): string[] {
  const leadingGlobalFlags = new Set([
    '-q',
    '--quiet',
    '-V',
    '--verbose',
    '-v',
    '--version',
    '-h',
    '--help',
    '-y',
    '--yes',
    '--json',
    '--no-interactive',
  ]);
  let commandIndex = 2;
  while (leadingGlobalFlags.has(input[commandIndex] ?? '')) {
    commandIndex += 1;
  }
  if (
    input[commandIndex] !== 'kit' ||
    input[commandIndex + 1] !== 'init'
  ) {
    return input;
  }
  return [
    ...input.slice(0, commandIndex),
    'init',
    ...input.slice(commandIndex + 2),
  ];
}
