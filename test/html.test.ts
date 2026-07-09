import { expect, test } from 'bun:test';
import { esc, html, raw } from '../web/html';

test('esc covers the four HTML-significant characters', () => {
  expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('html tag escapes interpolations but passes Html, raw, and arrays through', () => {
  expect(html`<b>${'<x> & "y"'}</b>`.s).toBe('<b>&lt;x&gt; &amp; &quot;y&quot;</b>');
  expect(html`${raw('<i>ok</i>')}${null}${undefined}${false}`.s).toBe('<i>ok</i>');
  expect(html`${[html`<u>${1}</u>`, '<']}`.s).toBe('<u>1</u>&lt;');
});
