import { open } from 'node:fs/promises';

/** Read a UTF-8 byte slice from a file without loading the full file. */
export async function readFileSlice(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return '';
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
