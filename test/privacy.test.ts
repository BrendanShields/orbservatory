import { beforeEach, expect, test } from 'bun:test';
import { cleanLabel, maskProject, setMask } from '../web/privacy';
import { relPath } from '../server/normalizer';

beforeEach(() => setMask(false));

test('cleanLabel collapses absolute paths to basenames', () => {
  expect(cleanLabel('file_path: /Users/b/dev/app/src/main.ts')).toBe('file_path: main.ts');
  expect(cleanLabel('Read /Users/b/secret/notes.md and /home/x/other.txt')).toBe('Read notes.md and other.txt');
  expect(cleanLabel('~/dev/app/src/util.ts changed')).toBe('util.ts changed');
});

test('cleanLabel leaves relative paths, bare names, and urls unchanged', () => {
  expect(cleanLabel('src/main.ts')).toBe('src/main.ts');
  expect(cleanLabel('no paths here')).toBe('no paths here');
  expect(cleanLabel('')).toBe('');
  expect(cleanLabel('https://example.com/a/b/c')).toBe('https://example.com/a/b/c');
});

test('maskProject is identity when off, stable first-seen aliases when on', () => {
  expect(maskProject('claude-viz')).toBe('claude-viz');
  setMask(true);
  const a1 = maskProject('claude-viz');
  const a2 = maskProject('agent-harness');
  expect(a1).toMatch(/^project-/);
  expect(a2).toMatch(/^project-/);
  expect(a1).not.toBe(a2);
  expect(maskProject('claude-viz')).toBe(a1);
  expect(maskProject('agent-harness')).toBe(a2);
  expect(maskProject('')).toBe('');
});

test('relPath makes cwd-relative, foreign paths collapse to basename', () => {
  const cwd = '/Users/b/dev/app';
  expect(relPath('/Users/b/dev/app/src/main.ts', cwd)).toBe('src/main.ts');
  expect(relPath('/Users/b/other/place/x.ts', cwd)).toBe('x.ts');
  expect(relPath('/Users/b/dev/app', cwd)).toBe('app');
  expect(relPath('src/main.ts', cwd)).toBe('src/main.ts');
  expect(relPath('/etc/hosts', undefined)).toBe('hosts');
});
