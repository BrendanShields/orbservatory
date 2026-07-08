import { expect, test } from 'bun:test';
import { resumeAction } from '../server/resume';

test('fresh subscription (since 0) gets a full snapshot', () => {
  expect(resumeAction(0, 0)).toEqual({ kind: 'snapshot' });
  expect(resumeAction(0, 25)).toEqual({ kind: 'snapshot' });
});

test('client behind by a gap resumes with just the gap', () => {
  expect(resumeAction(10, 25)).toEqual({ kind: 'events', from: 10 });
  expect(resumeAction(1, 2)).toEqual({ kind: 'events', from: 1 });
});

test('client already current gets nothing', () => {
  expect(resumeAction(25, 25)).toEqual({ kind: 'noop' });
});

test('client ahead of server (truncated/restarted transcript) re-snapshots', () => {
  expect(resumeAction(30, 25)).toEqual({ kind: 'snapshot' });
});

test('cursor minted by a different server boot is never trusted — always re-snapshot', () => {
  // A restarted server re-reads transcripts in a different interleave than live
  // tailing produced, so old indexes point at different events even when the
  // totals happen to match.
  expect(resumeAction(10, 25, false)).toEqual({ kind: 'snapshot' });
  expect(resumeAction(25, 25, false)).toEqual({ kind: 'snapshot' });
  expect(resumeAction(0, 25, false)).toEqual({ kind: 'snapshot' });
});
