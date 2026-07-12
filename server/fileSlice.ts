import { open } from 'node:fs/promises';

/** Read a UTF-8 byte slice from a file without loading the full file. */
export async function readFileSlice(path: string, start: number, end: number): Promise<string> {
  return (await readFileSliceBytes(path, start, end)).toString('utf8');
}

/**
 * Raw byte slice. Loops until the requested range is filled or EOF — a single
 * read() may return short on network/FUSE filesystems, and silently dropping
 * the remainder would permanently skip transcript bytes.
 */
export async function readFileSliceBytes(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
