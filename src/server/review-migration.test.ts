import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { migrateBranchReviews } from './review-migration.js';
import { ReviewStore } from './review-store.js';

test('finite conversion preserves UUIDs, unresolved history, submissions and import identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-conversion-'));
  try {
    const state = {
      version: 1,
      owner: 'owner',
      reviews: [
        {
          id: 'resolved',
          subject: { repository: 'repo', branch: 'main' },
          submissions: [
            { id: 'immutable', subject: { branch: 'main', pullRequest: { number: 1 } } },
          ],
          threads: [{ id: 'thread' }],
          forms: { form: { body: 'draft' } },
        },
        { id: 'unknown', subject: { repository: 'repo', branch: '' }, submissions: [] },
      ],
      assignedImports: { old: 'resolved' },
      unassigned: {},
      receipts: {},
    };
    const file = join(directory, 'reviews.json');
    writeFileSync(file, JSON.stringify(state));
    expect(() => new ReviewStore(directory, 'owner')).toThrow('format');
    expect(
      migrateBranchReviews(directory, 'owner', {
        resolved: { sourceRepository: 'fork/repo' },
        unknown: null,
      }),
    ).toEqual({ converted: 1, unresolved: 1 });
    const converted = JSON.parse(readFileSync(file, 'utf8'));
    expect(converted.reviews[0]).toEqual({
      ...state.reviews[0],
      subject: { ...state.reviews[0]!.subject, sourceRepository: 'fork/repo' },
    });
    expect(converted.reviews[1]).toEqual(state.reviews[1]);
    expect(new ReviewStore(directory, 'owner').get('unknown')).toEqual(state.reviews[1]);
    expect(converted.assignedImports).toEqual(state.assignedImports);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ambiguous old branches fail before any write', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-conflict-'));
  try {
    const before = JSON.stringify({
      version: 1,
      owner: 'owner',
      reviews: [
        { id: 'a', subject: { branch: 'same' } },
        { id: 'b', subject: { branch: 'same' } },
      ],
    });
    const file = join(directory, 'reviews.json');
    writeFileSync(file, before);
    expect(() =>
      migrateBranchReviews(directory, 'owner', {
        a: { sourceRepository: 'fork/repo' },
        b: { sourceRepository: 'fork/repo' },
      }),
    ).toThrow('Conflicting');
    expect(readFileSync(file, 'utf8')).toBe(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
