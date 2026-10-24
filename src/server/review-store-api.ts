import { assertReviewCheckout } from './review-identity.js';
import { reviewIntroduction } from '../utils/reviewIntroduction.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { simpleGit } from 'simple-git';
import type { DiffCommentThread, DiffSelection } from '../types/diff.js';
import type { ReviewSubmission, ReviewSubject } from '../types/reviewSubmission.js';
import type { ReviewStore } from './review-store.js';

export function registerReviewStore(
  app: Express,
  options: {
    store: ReviewStore;
    repoPath: string;
    repositoryId: string;
    parseThreads(body: unknown): DiffCommentThread[];
    changed(reviewId: string, version: number): void;
  },
) {
  const pending = new Map<string, Promise<string>>();
  const requestBody = (request: Request): unknown =>
    typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
  const resolve = async (request: Request, selection?: DiffSelection) => {
    const explicit =
      request.query.reviewId ??
      (requestBody(request) as { reviewId?: string } | undefined)?.reviewId;
    if (typeof explicit === 'string') return options.store.get(explicit);
    const branch =
      typeof request.query.reviewBranch === 'string'
        ? request.query.reviewBranch
        : (
            await simpleGit(options.repoPath)
              .raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])
              .catch(() => 'Detached HEAD')
          ).trim();
    const git = simpleGit(options.repoPath);
    const target =
      selection?.targetCommitish ||
      (typeof request.query.target === 'string' && request.query.target
        ? request.query.target
        : 'HEAD');
    const working = ['.', 'working', 'staged'].includes(target);
    const head = (await git.revparse([working ? 'HEAD' : `${target}^{commit}`])).trim();
    const base =
      selection?.baseCommitish ??
      (typeof request.query.base === 'string' ? request.query.base : undefined);
    const format = (await git.raw(['rev-parse', '--show-object-format'])).trim();
    const emptyTree = createHash(format).update('tree 0\0').digest('hex');
    let baseHead =
      base && !['.', 'working', 'staged'].includes(base)
        ? base === emptyTree
          ? emptyTree
          : (await git.revparse([`${base}^{commit}`])).trim()
        : undefined;
    if (baseHead && baseHead !== emptyTree && selection?.baseMode === 'merge-base')
      baseHead = (await git.raw(['merge-base', head, baseHead])).trim();
    const unpublished = await git
      .raw(['rev-list', '--count', `${branch}@{upstream}..${head}`])
      .then(
        (value) => Number(value.trim()) > 0,
        () => true,
      );
    const captured: ReviewSubject =
      typeof request.query.reviewSubject === 'string'
        ? (JSON.parse(request.query.reviewSubject) as ReviewSubject)
        : { repository: options.repoPath, branch, head, base, baseHead, working, unpublished };
    const subject: ReviewSubject = {
      ...captured,
      ...(selection ? { base, baseHead, comparisonHead: head, working } : {}),
    };
    if (
      typeof subject.repository !== 'string' ||
      typeof subject.branch !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(subject.head)
    )
      throw new Error('Invalid review subject');
    const key = JSON.stringify(subject);
    let resolved = pending.get(key);
    if (!resolved) {
      resolved = options.store.resolve(options.repoPath, subject).then((value) => value.id);
      pending.set(key, resolved);
      resolved.catch(() => pending.delete(key));
    }
    return options.store.get(await resolved);
  };
  app.get('/api/review-state', async (req, res) => {
    try {
      res.json(await resolve(req));
    } catch (error) {
      res.status(409).json({ error: String(error) });
    }
  });
  app.get('/api/comments-json', async (req, res) => {
    try {
      const review = await resolve(req);
      res.json({ reviewId: review.id, version: review.version, threads: review.threads });
    } catch (error) {
      res.status(409).json({ error: String(error) });
    }
  });
  app.post('/api/comments', async (req, res) => {
    try {
      const review = await resolve(req);
      const body = requestBody(req) as {
        operations?: Parameters<ReviewStore['patch']>[1];
        writeId?: string;
      };
      if (!Array.isArray(body.operations))
        throw new Error('Comment saves require affected-field operations');
      for (const operation of body.operations) {
        if (
          !operation ||
          !['thread', 'message', 'form'].includes(operation.kind) ||
          typeof operation.id !== 'string'
        )
          throw new Error('Invalid comment operation');
        if (operation.kind === 'thread' && operation.value !== null) {
          const thread = options.parseThreads({ threads: [operation.value] })[0];
          if (!thread || thread.id !== operation.id)
            throw new Error('Comment thread identity changed');
          operation.value = thread;
        }
        if (
          operation.kind === 'message' &&
          operation.value !== null &&
          (typeof (operation.value as { body?: unknown }).body !== 'string' ||
            (operation.value as { id?: unknown }).id !== operation.id)
        )
          throw new Error('Invalid message');
        if (
          operation.kind === 'form' &&
          operation.value !== null &&
          typeof (operation.value as { body?: unknown }).body !== 'string'
        )
          throw new Error('Invalid form');
      }
      const saved = options.store.patch(review.id, body.operations, body.writeId);
      options.changed(saved.id, saved.version);
      res.json({ success: true, merged: true, ...saved });
    } catch (error) {
      res.status(409).json({ error: String(error) });
    }
  });
  app.delete('/api/comments', async (req, res) => {
    try {
      const review = await resolve(req);
      const body = requestBody(req) as { threads?: DiffCommentThread[] };
      if (body.threads && JSON.stringify(body.threads) !== JSON.stringify(review.threads))
        throw new Error('Comments changed since export. They have been kept.');
      const saved = options.store.patch(
        review.id,
        review.threads.map((thread) => ({ kind: 'thread', id: thread.id, value: null })),
      );
      options.changed(saved.id, saved.version);
      res.json({ success: true, version: saved.version });
    } catch (error) {
      res.status(409).json({ error: String(error) });
    }
  });
  app.get('/api/reviews/submitted', (_req, res) => res.json(options.store.submitted()));
  app.get('/api/reviews/submitted/:id', (req, res) => {
    const review = options.store.submitted(req.params.id)[0];
    if (review) res.json(review);
    else res.status(404).json({ error: 'Unknown submitted review' });
  });
  app.put('/api/reviews/submitted/:id/receipt', (req, res) => {
    try {
      const receipt = requestBody(req) as Parameters<ReviewStore['receipt']>[1];
      if (!['submitted', 'accepted', 'failed', 'unknown'].includes(receipt.outcome))
        throw new Error('Invalid delivery receipt');
      options.store.receipt(req.params.id, receipt);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });
  app.get('/api/reviews/unassigned', (_req, res) => res.json(options.store.unassigned()));
  app.post('/api/reviews/unassigned', (req, res) => {
    try {
      const threads = options.parseThreads(req.body);
      const importId = createHash('sha256').update(JSON.stringify(threads)).digest('hex');
      res.json(options.store.importUnassigned(threads, importId));
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });
  app.post('/api/reviews/unassigned/:id/assign', async (req, res) => {
    try {
      const review = await resolve(req);
      options.store.assign(req.params.id, review.id);
      options.changed(review.id, options.store.get(review.id).version);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });
  app.delete('/api/comments/:threadId', async (req, res) => {
    try {
      const review = await resolve(req);
      const saved = options.store.patch(review.id, [
        { kind: 'thread', id: req.params.threadId, value: null },
      ]);
      options.changed(saved.id, saved.version);
      res.json({ success: true, version: saved.version });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });
  return {
    resolve,
    capture: async (request: Request, body: ReviewSubmission) => {
      const review = await resolve(request);
      const captured =
        typeof request.query.reviewSubject === 'string'
          ? (JSON.parse(request.query.reviewSubject) as ReviewSubject)
          : review.subject;
      const subject = { ...(body.subject ?? review.subject) };
      delete subject.checkout;
      if (captured.checkout) subject.checkout = captured.checkout;
      if (captured.checkout && subject.head !== captured.head)
        throw new Error('Submitted review checkout changed');
      if (
        subject.repository !== review.subject.repository ||
        subject.branch !== review.subject.branch ||
        subject.sourceRepository !== review.subject.sourceRepository ||
        !/^[a-f0-9]{40,64}$/.test(subject.head)
      )
        throw new Error('Submitted review identity changed');
      await simpleGit(options.repoPath).revparse([`${subject.head}^{commit}`]);
      await assertReviewCheckout(options.repoPath, subject);
      const introduction = reviewIntroduction(
        subject,
        body.resolvedSelection.baseCommitish,
        body.resolvedSelection.targetCommitish,
      );
      const text = body.text.startsWith(introduction) ? body.text : introduction + body.text;
      const snapshot: ReviewSubmission = {
        ...body,
        id: body.id ?? randomUUID(),
        submittedAt: new Date().toISOString(),
        repositoryId: options.repositoryId,
        reviewId: review.id,
        subject: structuredClone(subject),
        text,
      };
      options.store.submit(review.id, snapshot);
      return snapshot;
    },
  };
}
