import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffCommentThread } from '../../types/diff.js';
import { ReviewStore } from '../../server/review-store.js';
import { commentOperations } from './commentOperations.js';

describe('affected-field comment operations', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-comment-operations-'));
    git('init', '-q', '-b', 'trunk');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'initial');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const thread = (id: string, body: string): DiffCommentThread => ({
    id,
    filePath: 'file',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    position: { side: 'new', line: 1 },
    messages: [{ id, body, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }],
  });
  it('accepts stale-client root edits without erasing a concurrently accepted reply or independent form', async () => {
    const path = join(root, 'store'),
      store = new ReviewStore(path, 'owner');
    const review = await store.resolve(root, {
      repository: 'repo',
      branch: 'trunk',
      head: git('rev-parse', 'HEAD'),
    });
    store.patch(review.id, [{ kind: 'thread', id: 'thread', value: thread('thread', 'original') }]);
    const stale = store.get(review.id).threads;
    store.patch(review.id, [
      {
        kind: 'message',
        threadId: 'thread',
        id: 'reply',
        value: { ...thread('reply', 'accepted reply').messages[0] },
      },
      { kind: 'form', id: 'reply-form', value: { body: 'independent form', context: {} } },
    ]);
    const edited = structuredClone(stale);
    const editedRoot = edited[0]?.messages[0];
    if (!editedRoot) throw new Error('Fixture root message is missing');
    editedRoot.body = 'latest root edit';
    const operations = commentOperations(stale, edited);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: 'message', threadId: 'thread', id: 'thread' });
    store.patch(review.id, operations, 'stale-client-edit');
    const reopened = new ReviewStore(path, 'owner');
    expect(reopened.get(review.id).threads[0]?.messages.map((value) => value.body)).toEqual([
      'latest root edit',
      'accepted reply',
    ]);
    expect(reopened.get(review.id).forms['reply-form']?.body).toBe('independent form');
  });
});
