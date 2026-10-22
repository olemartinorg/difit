import express from 'express';
import { fetch } from 'undici';
import type { Request } from 'express';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DiffCommentThread } from '../types/diff.js';
import type { ReviewSubmission } from '../types/reviewSubmission.js';
import { registerReviewStore } from './review-store-api.js';
import { ReviewStore } from './review-store.js';
import { registerReviewHandoff } from './review-handoff.js';
import { reviewIntroduction } from '../utils/reviewIntroduction.js';

describe('native review persistence API', () => {
  let root: string;
  let server: Server | undefined;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-review-api-'));
    git('init', '-q', '-b', 'trunk');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'initial');
  });
  afterEach(async () => {
    if (server) {
      const owned = server;
      owned.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        owned.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    rmSync(root, { recursive: true, force: true });
  });
  async function fixture(beforeCapture?: () => Promise<void>) {
    const store = new ReviewStore(join(root, 'store'), 'verified-owner');
    const head = git('rev-parse', 'HEAD');
    const review = await store.resolve(root, {
      repository: 'repo',
      branch: 'trunk',
      head,
      base: 'trunk',
      baseHead: head,
      unpublished: true,
    });
    const app = express();
    app.use(express.json());
    const api = registerReviewStore(app, {
      store,
      repoPath: root,
      repositoryId: 'captured-repository',
      parseThreads: (body) => (body as { threads: DiffCommentThread[] }).threads,
      changed: () => {},
    });
    const captures: ReviewSubmission[] = [];
    registerReviewHandoff(app, {
      enabled: true,
      repositoryId: 'captured-repository',
      parseThreads: (body) => (body as { threads: DiffCommentThread[] }).threads,
      capture: async (request, snapshot) => {
        captures.push(structuredClone(snapshot));
        await beforeCapture?.();
        return api.capture(request, snapshot);
      },
    });
    const listener = app.listen(0, '127.0.0.1');
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('listening', resolve);
      listener.once('error', reject);
    });
    const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const post = (body: unknown) =>
      fetch(`${origin}/api/comments?reviewId=${review.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { store, head, review, api, origin, post, captures };
  }

  it('resolves an honest empty-tree base when no branch target can be selected', async () => {
    const { api, head } = await fixture();
    const { createHash } = await import('node:crypto');
    const format = git('rev-parse', '--show-object-format');
    const emptyTree = createHash(format).update('tree 0\0').digest('hex');
    const request = { query: { reviewBranch: 'trunk' }, body: undefined } as unknown as Request;
    const review = await api.resolve(request, { baseCommitish: emptyTree, targetCommitish: head });
    expect(review.subject).toMatchObject({ head, base: emptyTree, baseHead: emptyTree });
    await expect(
      api.resolve(request, { baseCommitish: 'missing-ref', targetCommitish: head }),
    ).rejects.toThrow();
  });

  it('captures the actual selected comparison IDs after changing a review target', async () => {
    const f = await fixture();
    git('commit', '--allow-empty', '-qm', 'alternative comparison target');
    const alternative = git('rev-parse', 'HEAD');
    const record = await f.api.resolve(
      {
        query: { reviewBranch: 'trunk', reviewSubject: JSON.stringify(f.review.subject) },
      } as unknown as Request,
      { baseCommitish: alternative, targetCommitish: f.head },
    );
    expect(record.id).toBe(f.review.id);
    expect(record.subject).toMatchObject({
      head: f.head,
      baseHead: alternative,
      comparisonHead: f.head,
    });
    const introduction = reviewIntroduction(
      record.subject,
      alternative.slice(0, 7),
      f.head.slice(0, 7),
    );
    expect(introduction).toContain(`Comparison target: ${f.head}`);
    expect(introduction).toContain(` ${alternative}\n`);
  });

  it('rejects whole-collection saves and accepts independent affected-field saves with latest save winning', async () => {
    const f = await fixture();
    const legacy = await f.post({ threads: [] });
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ error: expect.stringContaining('affected-field') });
    const first = {
      operations: [{ kind: 'form', id: 'new:a', value: { body: 'first', context: { line: 1 } } }],
      writeId: 'first',
    };
    expect((await f.post(first)).status).toBe(200);
    expect(
      (
        await f.post({
          operations: [
            {
              kind: 'form',
              id: 'reply:b',
              value: { body: 'independent', context: { threadId: 'b' } },
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.post({
          operations: [
            { kind: 'form', id: 'new:a', value: { body: 'latest', context: { line: 1 } } },
          ],
        })
      ).status,
    ).toBe(200);
    // Replaying the original acknowledged write cannot resurrect its old text.
    expect((await f.post(first)).status).toBe(200);
    const state = await (
      await fetch(`${f.origin}/api/review-state?reviewId=${f.review.id}`)
    ).json();
    expect((state as { forms: unknown }).forms).toMatchObject({
      'new:a': { body: 'latest' },
      'reply:b': { body: 'independent' },
    });
  });

  it('captures immutable introduced snapshots and keeps drafts out of submitted reads', async () => {
    const f = await fixture();
    await f.post({
      operations: [
        { kind: 'form', id: 'unsent', value: { body: 'private unfinished form', context: {} } },
      ],
    });
    const body: ReviewSubmission = {
      id: crypto.randomUUID(),
      submittedAt: '2026-10-22T00:00:00Z',
      repositoryId: 'untrusted-client-repository',
      selection: { baseCommitish: f.head, targetCommitish: f.head },
      resolvedSelection: { baseCommitish: f.head, targetCommitish: f.head },
      commit: f.head,
      diffHash: 'captured-diff',
      ignoreWhitespace: false,
      threads: [],
      text: 'Captured feedback',
    };
    const snapshot = await f.api.capture(
      { query: { reviewId: f.review.id } } as unknown as Request,
      body,
    );
    expect(snapshot).toMatchObject({
      reviewId: f.review.id,
      repositoryId: 'captured-repository',
      subject: { branch: 'trunk', head: f.head },
    });
    expect(snapshot.text).toContain('trunk');
    expect(snapshot.text).toContain('No pull request yet');
    expect(snapshot.text).toContain(f.head);
    f.store.receipt(snapshot.id, {
      outcome: 'unknown',
      conversationId: 'captured-conversation',
      error: 'acknowledgement lost',
    });
    await f.post({
      operations: [
        { kind: 'form', id: 'unsent', value: { body: 'new private form', context: {} } },
      ],
    });
    const retrieved = await (
      await fetch(`${f.origin}/api/reviews/submitted/${snapshot.id}`)
    ).json();
    expect(retrieved).toMatchObject({
      ...snapshot,
      receipt: { outcome: 'unknown', conversationId: 'captured-conversation' },
    });
    expect(JSON.stringify(retrieved)).not.toContain('private');
    expect((await fetch(`${f.origin}/api/reviews/submitted/missing`)).status).toBe(404);
  });
  it('hands the captured body review ID and subject through to an immutable introduced snapshot', async () => {
    const f = await fixture();
    git('commit', '--allow-empty', '-qm', 'new branch revision');
    await f.store.resolve(root, { ...f.review.subject, head: git('rev-parse', 'HEAD') });
    const subject = { ...f.review.subject, head: f.head, unpublished: true };
    const body: ReviewSubmission = {
      id: crypto.randomUUID(),
      reviewId: f.review.id,
      subject,
      submittedAt: '2026-10-22T00:00:00Z',
      repositoryId: 'untrusted',
      selection: { baseCommitish: f.head, targetCommitish: f.head },
      resolvedSelection: { baseCommitish: f.head, targetCommitish: f.head },
      commit: f.head,
      diffHash: 'captured-diff',
      ignoreWhitespace: false,
      threads: [],
      text: 'Review of captured old revision',
    };
    const sending = fetch(`${f.origin}/api/review-handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const delivered = (await (
      await fetch(`${f.origin}/api/review-handoff`)
    ).json()) as ReviewSubmission;
    expect(delivered).toMatchObject({
      reviewId: f.review.id,
      subject,
      commit: f.head,
      id: body.id,
    });
    expect(f.captures[0]).toMatchObject({ reviewId: f.review.id, subject });
    expect(delivered.text).toContain(f.head);
    expect(delivered.text).toContain('No pull request yet');
    expect(delivered.text).toContain('Review of captured old revision');
    expect(
      (await fetch(`${f.origin}/api/review-handoff/${body.id}/ack`, { method: 'POST' })).status,
    ).toBe(200);
    expect(await (await sending).json()).toEqual({ receivedByReceiver: true, id: body.id });
    // Stdout acknowledgement is distinct from native-conversation acceptance.
    expect(f.store.submitted(body.id)[0]).toMatchObject({
      ...delivered,
      receipt: { outcome: 'submitted' },
    });
  });

  it('excludes a second handoff while the first immutable capture is still pending', async () => {
    let entered!: () => void, release!: () => void;
    const capturing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async () => {
      entered();
      await gate;
    });
    const body: ReviewSubmission = {
      id: crypto.randomUUID(),
      reviewId: f.review.id,
      subject: f.review.subject,
      submittedAt: '2026-10-22T00:00:00Z',
      repositoryId: 'repo',
      selection: { baseCommitish: f.head, targetCommitish: f.head },
      resolvedSelection: { baseCommitish: f.head, targetCommitish: f.head },
      commit: f.head,
      diffHash: 'hash',
      ignoreWhitespace: false,
      threads: [],
      text: 'first',
    };
    const post = (value: ReviewSubmission) =>
      fetch(`${f.origin}/api/review-handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    const first = post(body);
    await capturing;
    expect((await post({ ...body, id: crypto.randomUUID(), text: 'second' })).status).toBe(409);
    release();
    const delivered = (await (
      await fetch(`${f.origin}/api/review-handoff`)
    ).json()) as ReviewSubmission;
    expect(delivered.id).toBe(body.id);
    await fetch(`${f.origin}/api/review-handoff/${body.id}/ack`, { method: 'POST' });
    await first;
    expect(f.store.submitted()).toHaveLength(1);
  });
});
