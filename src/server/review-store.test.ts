import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffCommentThread } from '../types/diff.js';
import type { ReviewSubmission } from '../types/reviewSubmission.js';
import { ReviewStore } from './review-store.js';

describe('host review ownership', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-owner-'));
    git('init', '-b', 'trunk');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'file'), 'base\n');
    git('add', 'file');
    git('commit', '-qm', 'base');
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
  it('restores A/B/A forms, edits and replies after process restart without leaking reviews', async () => {
    const path = join(root, 'store');
    const store = new ReviewStore(path, 'owner');
    git('checkout', '-qb', 'a');
    writeFileSync(join(root, 'file'), 'a\n');
    git('commit', '-qam', 'a');
    const a = await store.resolve(root, {
      repository: 'repo',
      branch: 'a',
      head: git('rev-parse', 'HEAD'),
    });
    store.patch(a.id, [
      { kind: 'thread', id: 'a', value: thread('a', 'Comment A') },
      {
        kind: 'form',
        id: 'new:file:1',
        value: { body: 'unfinished A', context: { line: 1, code: 'a' } },
      },
    ]);
    git('checkout', '-qb', 'b', 'trunk');
    writeFileSync(join(root, 'file'), 'b\n');
    git('commit', '-qam', 'b');
    const b = await store.resolve(root, {
      repository: 'repo',
      branch: 'b',
      head: git('rev-parse', 'HEAD'),
    });
    store.patch(b.id, [{ kind: 'thread', id: 'b', value: thread('b', 'Comment B') }]);
    store.patch(a.id, [
      {
        kind: 'message',
        threadId: 'a',
        id: 'a',
        value: { ...thread('a', 'Edited A').messages[0] },
      },
      {
        kind: 'message',
        threadId: 'a',
        id: 'reply-a',
        value: { ...thread('reply-a', 'Reply A').messages[0] },
      },
      {
        kind: 'form',
        id: 'reply-form:a',
        value: { body: 'unfinished reply A', context: { threadId: 'a' } },
      },
    ]);
    const reopened = new ReviewStore(path, 'owner');
    expect(reopened.get(a.id).threads.map((value) => value.id)).toEqual(['a']);
    expect(reopened.get(a.id).forms['new:file:1']?.body).toBe('unfinished A');
    expect(reopened.get(a.id).threads[0]?.messages.map((value) => value.body)).toEqual([
      'Edited A',
      'Reply A',
    ]);
    expect(reopened.get(a.id).forms['reply-form:a']?.body).toBe('unfinished reply A');
    expect(reopened.get(b.id).threads.map((value) => value.id)).toEqual(['b']);
    expect(reopened.get(b.id).forms).toEqual({});
  });
  it('accepts latest affected-message saves and keeps independent comments and immutable submissions', async () => {
    const store = new ReviewStore(join(root, 'store'), 'owner');
    const a = await store.resolve(root, {
      repository: 'repo',
      branch: 'trunk',
      head: git('rev-parse', 'HEAD'),
    });
    store.patch(a.id, [
      { kind: 'thread', id: 'one', value: thread('one', 'original') },
      { kind: 'thread', id: 'two', value: thread('two', 'independent') },
    ]);
    const snapshot = {
      id: 'submission',
      submittedAt: '2026-10-22T00:00:00Z',
      repositoryId: 'repo',
      selection: { baseCommitish: 'base', targetCommitish: a.anchor },
      resolvedSelection: { baseCommitish: 'base', targetCommitish: a.anchor },
      commit: a.anchor,
      diffHash: 'hash',
      ignoreWhitespace: false,
      threads: store.get(a.id).threads,
      text: 'exact text',
    } satisfies ReviewSubmission;
    store.submit(a.id, snapshot);
    store.patch(
      a.id,
      [
        {
          kind: 'message',
          threadId: 'one',
          id: 'one',
          value: { ...thread('one', 'first').messages[0] },
        },
      ],
      'first',
    );
    store.patch(
      a.id,
      [
        {
          kind: 'message',
          threadId: 'one',
          id: 'one',
          value: { ...thread('one', 'last').messages[0] },
        },
      ],
      'last',
    );
    expect(store.get(a.id).threads.map((value) => value.messages[0]?.body)).toEqual([
      'last',
      'independent',
    ]);
    expect(store.submitted()[0]?.threads[0]?.messages[0]?.body).toBe('original');
    store.patch(a.id, [{ kind: 'thread', id: 'one', value: null }], 'clear');
    store.patch(
      a.id,
      [{ kind: 'message', threadId: 'one', id: 'one', value: thread('one', 'first').messages[0] }],
      'first',
    );
    expect(store.get(a.id).threads.map((value) => value.id)).toEqual(['two']);
    store.receipt('submission', {
      outcome: 'unknown',
      conversationId: 'captured-thread',
      error: 'ack lost',
    });
    expect(store.submitted()[0]?.receipt.outcome).toBe('unknown');
    expect(() => store.submit(a.id, snapshot)).toThrow('Submission ID already exists');
  });
  it('keeps the review when a local branch acquires a PR and separates unrelated reused branches', async () => {
    const store = new ReviewStore(join(root, 'store'), 'owner');
    git('checkout', '-qb', 'work');
    writeFileSync(join(root, 'file'), 'one\n');
    git('commit', '-qam', 'one');
    const head = git('rev-parse', 'HEAD');
    const original = await store.resolve(root, { repository: 'repo', branch: 'work', head });
    const linked = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head,
      pullRequest: { number: 1, url: 'https://github.com/o/r/pull/1', head, base: 'trunk' },
    });
    expect(linked.id).toBe(original.id);
    git('checkout', '-B', 'work', 'trunk');
    writeFileSync(join(root, 'file'), 'different\n');
    git('commit', '-qam', 'different');
    const reused = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head: git('rev-parse', 'HEAD'),
    });
    expect(reused.id).not.toBe(original.id);
    expect(() => new ReviewStore(join(root, 'store'), 'replacement-owner')).toThrow('owner');
  });
  it('preserves unassigned imports with stable counts and requires explicit assignment', async () => {
    const store = new ReviewStore(join(root, 'store'), 'owner');
    const legacy = [thread('legacy', 'preserve')];
    expect(store.importUnassigned(legacy, 'import')).toEqual({
      importId: 'import',
      count: 1,
      messageCount: 1,
    });
    const a = await store.resolve(root, {
      repository: 'repo',
      branch: 'trunk',
      head: git('rev-parse', 'HEAD'),
    });
    expect(a.threads).toEqual([]);
    store.assign('import', a.id);
    store.assign('import', a.id);
    expect(store.get(a.id).threads).toEqual(legacy);
    expect(store.unassigned()).toEqual({});
    expect(new ReviewStore(join(root, 'store'), 'owner').get(a.id).threads).toEqual(legacy);
  });
});
