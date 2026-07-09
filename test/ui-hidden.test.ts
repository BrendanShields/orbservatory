import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function hasHiddenDisplayNone(selector: string) {
  for (const block of cssWithoutComments.split('}')) {
    const [selectorList, declarations] = block.split('{');
    if (!selectorList || !declarations) continue;
    const selectors = selectorList.split(',').map((s) => s.trim());
    if (selectors.includes(selector) && /\bdisplay\s*:\s*none\b/.test(declarations)) return true;
  }
  return false;
}

test('route containers explicitly honor hidden even when component CSS sets display', () => {
  // Bare `.shell` sets `display:grid`, which overrides the browser's UA
  // `[hidden]{display:none}` rule. Without these stronger author rules, the
  // graph chrome leaks over the sessions home route. Keep both route roots
  // covered so navigating home <-> graph is mutually exclusive in either
  // direction, even if `.home-root` later gains its own display declaration.
  expect(css).toContain('.shell{');
  expect(css).toContain('display:grid');
  expect(hasHiddenDisplayNone('.shell[hidden]')).toBe(true);
  expect(hasHiddenDisplayNone('.home-root[hidden]')).toBe(true);
});

test('small pointer targets get invisible hit-area expansion', () => {
  // DD ergonomics: small/round controls should be visually compact without
  // requiring pixel-perfect aim. Keep the pseudo-element pattern on controls
  // that are easy to miss in the graph chrome.
  expect(cssWithoutComments).toContain('.close::after');
  expect(cssWithoutComments).toContain('.rail-filter::after');
  expect(cssWithoutComments).toContain('.rail-toggle::after');
  expect(cssWithoutComments).toContain('.child-row::after');
  expect(cssWithoutComments).toContain('inset:-8px');
});
