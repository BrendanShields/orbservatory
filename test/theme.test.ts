import { expect, test } from 'bun:test';
import { resolveTheme } from '../web/theme';

test('theme resolution matrix', () => {
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('light', false)).toBe('light');
  expect(resolveTheme('dark', true)).toBe('dark');
  expect(resolveTheme('dark', false)).toBe('dark');
});
