/** Escapes `& < > "` — safe for text nodes and double-quoted attributes. */
export function esc(v: string) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

/** A string already safe to assign to innerHTML. Only `html`/`raw` produce it. */
export class Html {
  constructor(readonly s: string) {}
  toString() { return this.s; }
}

export function raw(s: string): Html { return new Html(s); }

/**
 * Tagged template that auto-escapes interpolations. `Html` values (and arrays
 * of them) pass through unescaped; null/undefined/false render as ''.
 */
export function html(strings: TemplateStringsArray, ...vals: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Html(out);
}

function part(v: unknown): string {
  if (v == null || v === false) return '';
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(String(v));
}
