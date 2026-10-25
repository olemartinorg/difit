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
  it('counts pending messages by branch and source across delivery, edits and restart', async () => {
    const directory = join(root, 'store');
    const store = new ReviewStore(directory, 'owner');
    const review = await store.resolve(root, {
      repository: 'repo',
      sourceRepository: 'owner/repo',
      branch: 'trunk',
      head: git('rev-parse', 'HEAD'),
    });
    const other = await store.resolve(root, {
      repository: 'repo',
      sourceRepository: 'fork/repo',
      branch: 'trunk',
      head: review.anchor,
    });
    store.patch(review.id, [{ kind: 'thread', id: 'one', value: thread('one', 'original') }]);
    store.patch(other.id, [{ kind: 'thread', id: 'other', value: thread('other', 'fork note') }]);
    const snapshot: ReviewSubmission = {
      id: 'submission',
      submittedAt: '2026-10-22T00:00:00Z',
      repositoryId: 'repo',
      selection: { baseCommitish: review.anchor, targetCommitish: review.anchor },
      resolvedSelection: { baseCommitish: review.anchor, targetCommitish: review.anchor },
      commit: review.anchor,
      diffHash: 'hash',
      ignoreWhitespace: false,
      threads: store.get(review.id).threads,
      text: 'feedback',
    };
    store.submit(review.id, snapshot);
    for (const outcome of ['submitted', 'failed', 'unknown'] as const) {
      store.receipt(snapshot.id, { outcome });
      expect(store.pendingComments()[0]?.commentCount).toBe(1);
    }
    store.receipt(snapshot.id, { outcome: 'accepted' });
    expect(store.pendingComments()[0]?.commentCount).toBe(0);
    store.patch(review.id, [
      { kind: 'message', id: 'one', threadId: 'one', value: thread('one', 'edited').messages[0] },
      {
        kind: 'message',
        id: 'reply',
        threadId: 'one',
        value: thread('reply', 'reply').messages[0],
      },
    ]);
    expect(new ReviewStore(directory, 'owner').pendingComments()).toEqual([
      { sourceRepository: 'owner/repo', branch: 'trunk', commentCount: 2 },
      { sourceRepository: 'fork/repo', branch: 'trunk', commentCount: 1 },
    ]);
    store.patch(review.id, [{ kind: 'thread', id: 'one', value: null }]);
    expect(store.pendingComments()[0]?.commentCount).toBe(0);
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
  it('keeps the same branch review when a PR is linked or its history is replaced', async () => {
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
    expect(reused.id).toBe(original.id);
    expect(() => new ReviewStore(join(root, 'store'), 'replacement-owner')).toThrow('owner');
  });
  it('keeps a PR review and its original comment context through a non-ancestral rebase', async () => {
    const store = new ReviewStore(join(root, 'store'), 'owner');
    git('checkout', '-qb', 'work');
    writeFileSync(join(root, 'file'), 'original feature\n');
    git('commit', '-qam', 'original feature');
    const head = git('rev-parse', 'HEAD');
    const pullRequest = { number: 1, url: 'https://github.com/o/r/pull/1', head, base: 'trunk' };
    const review = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head,
      pullRequest,
    });
    store.patch(review.id, [
      { kind: 'thread', id: 'original', value: thread('original', 'Keep the original context') },
      {
        kind: 'form',
        id: 'unfinished',
        value: { body: 'Unfinished before rebase', context: { head } },
      },
    ]);
    const original = store.get(review.id);
    git('checkout', '-q', 'trunk');
    writeFileSync(join(root, 'new-base'), 'new base\n');
    git('add', 'new-base');
    git('commit', '-qm', 'advance base');
    git('checkout', '-B', 'work');
    writeFileSync(join(root, 'file'), 'rebased feature\n');
    git('commit', '-qam', 'rebased feature');
    const rebasedHead = git('rev-parse', 'HEAD');
    const reopened = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head: rebasedHead,
      pullRequest: { ...pullRequest, head: rebasedHead },
    });
    expect(reopened.id).toBe(review.id);
    expect(reopened.anchor).toBe(head);
    expect(reopened.subject.head).toBe(rebasedHead);
    expect(reopened.threads).toEqual(original.threads);
    expect(reopened.forms).toEqual(original.forms);
  });
  it('keeps branch notes when a reused branch receives a replacement PR', async () => {
    const store = new ReviewStore(join(root, 'store'), 'owner');
    git('checkout', '-qb', 'work');
    writeFileSync(join(root, 'file'), 'first feature\n');
    git('commit', '-qam', 'first feature');
    const head = git('rev-parse', 'HEAD');
    const review = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head,
      pullRequest: { number: 1, url: 'https://github.com/o/r/pull/1', head, base: 'trunk' },
    });
    store.patch(review.id, [
      { kind: 'thread', id: 'old', value: thread('old', 'Old PR feedback') },
    ]);
    git('checkout', '-q', 'trunk');
    git('merge', '--ff-only', 'work');
    git('checkout', '-q', 'work');
    writeFileSync(join(root, 'file'), 'second feature\n');
    git('commit', '-qam', 'second feature');
    const nextHead = git('rev-parse', 'HEAD');
    const local = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head: nextHead,
    });
    expect(local.id).toBe(review.id);
    expect(local.subject.pullRequest).toBeUndefined();
    const restarted = new ReviewStore(join(root, 'store'), 'owner');
    const next = await restarted.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head: nextHead,
      pullRequest: {
        number: 2,
        url: 'https://github.com/o/r/pull/2',
        head: nextHead,
        base: 'trunk',
      },
    });
    expect(next.id).toBe(review.id);
    expect(next.threads[0]?.messages[0]?.body).toBe('Old PR feedback');
    expect(restarted.get(review.id).threads[0]?.messages[0]?.body).toBe('Old PR feedback');
  });
  it('recovers the known PR after a local view and a non-ancestral rebase', async () => {
    const path = join(root, 'store');
    const store = new ReviewStore(path, 'owner');
    git('checkout', '-qb', 'work');
    writeFileSync(join(root, 'file'), 'original feature\n');
    git('commit', '-qam', 'original feature');
    const head = git('rev-parse', 'HEAD');
    const pullRequest = { number: 1, url: 'https://github.com/o/r/pull/1', head, base: 'trunk' };
    const original = await store.resolve(root, {
      repository: 'repo',
      branch: 'work',
      head,
      pullRequest,
    });
    const forms = { unfinished: { body: 'Keep this PR draft', context: { head } } };
    store.patch(original.id, [{ kind: 'form', id: 'unfinished', value: forms.unfinished }]);
    const local = await store.resolve(root, { repository: 'repo', branch: 'work', head });
    expect(local.id).toBe(original.id);
    expect(local.subject.pullRequest).toBeUndefined();
    git('checkout', '-q', 'trunk');
    writeFileSync(join(root, 'new-base'), 'new base\n');
    git('add', 'new-base');
    git('commit', '-qm', 'advance base');
    git('checkout', '-B', 'work');
    writeFileSync(join(root, 'file'), 'rebased feature\n');
    git('commit', '-qam', 'rebased feature');
    const rebasedHead = git('rev-parse', 'HEAD');
    const restored = await new ReviewStore(path, 'owner').resolve(root, {
      repository: 'repo',
      branch: 'work',
      head: rebasedHead,
      pullRequest: { ...pullRequest, head: rebasedHead },
    });
    expect(restored.id).toBe(original.id);
    expect(restored.anchor).toBe(head);
    expect(restored.forms).toEqual(forms);
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
  it('keeps one source branch review through unlink, replacement, unrelated rewritten history and recreation', async () => {
    const directory = join(root, 'branch-owned');
    const store = new ReviewStore(directory, 'owner');
    const subject = {
      repository: 'repo',
      sourceRepository: 'fork/repo',
      branch: 'trunk',
      head: git('rev-parse', 'HEAD'),
    };
    const original = await store.resolve(root, subject);
    store.patch(original.id, [{ kind: 'form', id: 'draft', value: { body: 'keep', context: {} } }]);
    const linked = {
      ...subject,
      pullRequest: {
        number: 1,
        url: 'https://github.com/base/repo/pull/1',
        head: subject.head,
        base: 'main',
      },
    };
    expect((await store.resolve(root, linked)).id).toBe(original.id);
    git('checkout', '--orphan', 'fresh');
    writeFileSync(join(root, 'file'), 'unrelated\n');
    git('add', 'file');
    git('commit', '-qm', 'rewritten');
    const rewritten = { ...subject, head: git('rev-parse', 'HEAD') };
    expect((await new ReviewStore(directory, 'owner').resolve(root, rewritten)).id).toBe(
      original.id,
    );
    const replaced = await store.resolve(root, {
      ...rewritten,
      pullRequest: { ...linked.pullRequest, number: 2, url: 'https://github.com/base/repo/pull/2' },
    });
    expect(replaced.id).toBe(original.id);
    expect(replaced.forms.draft?.body).toBe('keep');
    expect(
      (await store.resolve(root, { ...rewritten, sourceRepository: 'other-fork/repo' })).id,
    ).not.toBe(original.id);
    expect((await store.resolve(root, { ...rewritten, branch: 'different' })).id).not.toBe(
      original.id,
    );
  });
});
