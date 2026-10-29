import { expect, it } from 'vitest';
import type { DiffResponse } from '../../types/diff';
import { reconcileDiffResponse } from './stableDiff';

it('retains an untouched file object when another file advances the live selection OID', () => {
  const file = {
    path: 'untouched',
    status: 'modified' as const,
    chunks: [],
    additions: 1,
    deletions: 0,
  };
  const before: DiffResponse = {
    repositoryId: 'repo',
    reviewId: 'review',
    commit: 'h1',
    baseCommitish: 'base',
    targetCommitish: 'h1',
    ignoreWhitespace: false,
    isEmpty: false,
    files: [file],
  };
  const incoming = {
    ...before,
    commit: 'h2',
    targetCommitish: 'h2',
    files: [{ ...file, chunks: [] }],
  };
  expect(reconcileDiffResponse(before, incoming).files[0]).toBe(file);
  expect(
    reconcileDiffResponse(before, { ...incoming, baseCommitish: 'other-base' }).files[0],
  ).not.toBe(file);
});
