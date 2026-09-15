import zlib from 'node:zlib';
import tar, { type Headers } from 'tar-stream';

interface TarFixtureEntry {
  name: string;
  body?: string | Buffer;
  type?: Headers['type'];
  mode?: number;
  linkname?: string;
}

export async function createTarGzip(entries: TarFixtureEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '');
    pack.entry(
      {
        name: entry.name,
        type: entry.type ?? 'file',
        mode: entry.mode ?? 0o644,
        size: entry.type && entry.type !== 'file' ? 0 : body.length,
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
      },
      body,
    );
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return zlib.gzipSync(Buffer.concat(chunks));
}
