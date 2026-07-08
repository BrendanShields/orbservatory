import { stat } from 'node:fs/promises';

export interface FileCursor {
  offset: number;
  buffer: string;
  sourceKey: string;
}

/**
 * Byte-offset tail of an append-only file: reads bytes past the cursor,
 * buffers a partial trailing line, and resets on truncation. Yields complete
 * lines to the callback in file order.
 */
export async function tailLines(
  cursors: Map<string, FileCursor>,
  path: string,
  onLine: (line: string) => void,
): Promise<void> {
  const st = await stat(path).catch(() => null);
  if (!st) return;
  let cursor = cursors.get(path);
  if (!cursor || st.size < cursor.offset) {
    cursor = { offset: 0, buffer: '', sourceKey: path };
    cursors.set(path, cursor);
  }
  if (st.size === cursor.offset) return;
  const text = await Bun.file(path).slice(cursor.offset, st.size).text();
  cursor.offset = st.size;
  const parts = (cursor.buffer + text).split(/\r?\n/);
  cursor.buffer = parts.pop() || '';
  for (const line of parts) {
    if (line.trim()) onLine(line);
  }
}
