import { stat } from 'node:fs/promises';
import { readFileSliceBytes } from '../fileSlice';

export interface FileCursor {
  offset: number;
  /** Raw bytes of the trailing partial line — kept undecoded so a poll landing mid-codepoint can't mangle UTF-8. */
  buffer: Buffer;
  sourceKey: string;
}

const NL = 0x0a;
const CR = 0x0d;

/**
 * Byte-offset tail of an append-only file: reads bytes past the cursor,
 * buffers a partial trailing line, and resets on truncation. Yields complete
 * lines to the callback in file order.
 *
 * Returns `reset: true` when the file shrank below the cursor (a transcript
 * rewritten in place). In that case nothing is
 * read this call: the caller must discard all state derived from the old
 * contents, then call again to ingest from offset 0.
 */
export async function tailLines(
  cursors: Map<string, FileCursor>,
  path: string,
  onLine: (line: string) => void,
): Promise<{ reset: boolean }> {
  const st = await stat(path).catch(() => null);
  if (!st) return { reset: false };
  let cursor = cursors.get(path);
  if (cursor && st.size < cursor.offset) {
    cursors.delete(path);
    return { reset: true };
  }
  if (!cursor) {
    cursor = { offset: 0, buffer: Buffer.alloc(0), sourceKey: path };
    cursors.set(path, cursor);
  }
  if (st.size === cursor.offset) return { reset: false };
  const bytes = await readFileSliceBytes(path, cursor.offset, st.size);
  cursor.offset += bytes.length;
  const data = cursor.buffer.length ? Buffer.concat([cursor.buffer, bytes]) : bytes;
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== NL) continue;
    let end = i;
    if (end > start && data[end - 1] === CR) end--;
    if (end > start) {
      const line = data.subarray(start, end).toString('utf8');
      if (line.trim()) onLine(line);
    }
    start = i + 1;
  }
  cursor.buffer = Buffer.from(data.subarray(start));
  return { reset: false };
}
