import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewStore } from '../server/review-store.js';
import type { ReviewSubmission } from '../types/reviewSubmission.js';
import { createReviewCommand } from './review.js';

let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('reads only immutable submissions through the native owner without rewriting storage or starting a server', async () => {
  root = mkdtempSync(join(tmpdir(), 'difit-offline-review-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root!, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-qb', 'trunk');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'file'), 'source\n');
  git('add', 'file');
  git('commit', '-qm', 'source');
  const head = git('rev-parse', 'HEAD'),
    directory = join(root, 'reviews');
  const store = new ReviewStore(directory, 'captured-owner');
  const review = await store.resolve(root, { repository: 'repo', branch: 'trunk', head });
  store.patch(review.id, [
    { kind: 'form', id: 'private', value: { body: 'Unsubmitted private draft', context: {} } },
  ]);
  const submission: ReviewSubmission = {
    id: 'submitted',
    reviewId: review.id,
    subject: review.subject,
    repositoryId: 'repo',
    submittedAt: '2026-10-22T00:00:00Z',
    selection: { baseCommitish: head, targetCommitish: head },
    resolvedSelection: { baseCommitish: head, targetCommitish: head },
    commit: head,
    diffHash: 'hash',
    ignoreWhitespace: false,
    threads: [],
    text: 'Captured submitted text',
  };
  store.submit(review.id, submission);
  store.receipt(submission.id, { outcome: 'unknown', error: 'Delivery acknowledgement lost' });
  const before = readFileSync(store.path),
    stat = statSync(store.path),
    names = readdirSync(directory);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await createReviewCommand().parseAsync(
    ['list', '--store', directory, '--owner', 'captured-owner'],
    { from: 'user' },
  );
  const list = JSON.parse(String(output.mock.lastCall?.[0]));
  expect(list).toEqual([
    {
      id: submission.id,
      reviewId: review.id,
      repositoryId: 'repo',
      submittedAt: submission.submittedAt,
      subject: review.subject,
      receipt: { outcome: 'unknown', error: 'Delivery acknowledgement lost' },
    },
  ]);
  await createReviewCommand().parseAsync(
    ['get', submission.id, '--store', directory, '--owner', 'captured-owner'],
    { from: 'user' },
  );
  expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({
    ...submission,
    receipt: { outcome: 'unknown', error: 'Delivery acknowledgement lost' },
  });
  expect(JSON.stringify(output.mock.calls)).not.toContain('Unsubmitted private draft');
  expect(errors).not.toHaveBeenCalled();
  expect(readFileSync(store.path)).toEqual(before);
  expect(statSync(store.path).mtimeMs).toBe(stat.mtimeMs);
  expect(readdirSync(directory)).toEqual(names);
  await createReviewCommand().parseAsync(
    ['list', '--store', directory, '--owner', 'different-owner'],
    { from: 'user' },
  );
  expect(errors).toHaveBeenLastCalledWith(expect.stringContaining('owner or format'));
  expect(process.exitCode).toBe(1);
  expect(readFileSync(store.path)).toEqual(before);
});
