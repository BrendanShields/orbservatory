/**
 * Display-only privacy transforms. Applied at render boundaries; exports and
 * the wire protocol always carry real data.
 */

const ABS_PATH = /(?<![:\w/-])(?:~?\/[\w.@-]+){2,}\/?/g;

/** Collapse any absolute (or ~/) path in a label to its basename — fallback for old imports; new server labels are already relative. */
export function cleanLabel(s: string): string {
  if (!s || (!s.includes('/') && !s.includes('~'))) return s;
  return s.replace(ABS_PATH, (m) => m.split('/').filter(Boolean).pop() || m);
}

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

let maskOn = false;
const aliases = new Map<string, string>();

export function setMask(on: boolean) { maskOn = on; }
export function maskEnabled(): boolean { return maskOn; }

/** Stable per-page-load alias (project-one, project-two, …) when the mask is on. */
export function maskProject(name: string): string {
  if (!maskOn || !name) return name;
  let alias = aliases.get(name);
  if (!alias) {
    const n = aliases.size + 1;
    alias = `project-${NUMBER_WORDS[n - 1] ?? n}`;
    aliases.set(name, alias);
  }
  return alias;
}
