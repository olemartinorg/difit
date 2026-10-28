import { randomUUID } from 'crypto';

import type { Express, Response, Request } from 'express';

import type { DiffCommentThread, DiffSelection } from '../types/diff.js';
import type { ReviewSubmission } from '../types/reviewSubmission.js';

function parseSelection(value: unknown): DiffSelection {
  const selection = value as Partial<DiffSelection> | null;
  if (
    !selection ||
    typeof selection.baseCommitish !== 'string' ||
    typeof selection.targetCommitish !== 'string'
  )
    throw new Error('Invalid comparison');
  return {
    baseCommitish: selection.baseCommitish,
    targetCommitish: selection.targetCommitish,
    baseMode: selection.baseMode === 'merge-base' ? 'merge-base' : 'direct',
    includeUntracked: selection.includeUntracked === true,
  };
}

export function registerReviewHandoff(
  app: Express,
  options: {
    enabled: boolean;
    repositoryId: string;
    parseThreads: (body: unknown) => DiffCommentThread[];
    capture?: (request: Request, body: ReviewSubmission) => Promise<ReviewSubmission>;
  },
) {
  let pending: { snapshot: ReviewSubmission; response: Response; claimed: boolean } | null = null;
  let receiver: Response | null = null;
  let capturing = false;
  let acknowledged: string | null = null;

  const deliver = () => {
    if (!pending || pending.claimed || !receiver) return;
    pending.claimed = true;
    const waiting = receiver;
    receiver = null;
    waiting.json(pending.snapshot);
  };

  app.get('/api/review-handoff', (_req, res) => {
    if (!options.enabled) {
      res.status(409).json({ error: 'Agent handoff is not enabled.' });
      return;
    }
    if (receiver || pending?.claimed) {
      res.status(409).json({ error: 'Another receiver is handling this review.' });
      return;
    }
    receiver = res;
    const timeout = setTimeout(() => {
      if (receiver === res) receiver = null;
      res.status(204).end();
    }, 25_000);
    res.on('close', () => {
      clearTimeout(timeout);
      if (receiver === res) receiver = null;
    });
    deliver();
  });

  app.post('/api/review-handoff', async (req, res) => {
    if (!options.enabled) {
      res.status(409).json({ error: 'Agent handoff is not enabled.' });
      return;
    }
    if (pending || capturing) {
      res.status(409).json({ error: 'A review is already waiting for an agent.' });
      return;
    }
    capturing = true;
    try {
      const body = req.body as Partial<ReviewSubmission>;
      if (
        typeof body.text !== 'string' ||
        typeof body.commit !== 'string' ||
        typeof body.diffHash !== 'string' ||
        !Array.isArray(body.threads)
      )
        throw new Error('Invalid review');
      let snapshot: ReviewSubmission = {
        id: typeof body.id === 'string' ? body.id : randomUUID(),
        submittedAt: new Date().toISOString(),
        repositoryId: options.repositoryId,
        ...(typeof body.reviewId === 'string' ? { reviewId: body.reviewId } : {}),
        ...(body.subject ? { subject: body.subject } : {}),
        selection: parseSelection(body.selection),
        resolvedSelection: parseSelection(body.resolvedSelection),
        commit: body.commit,
        diffHash: body.diffHash,
        ignoreWhitespace: body.ignoreWhitespace === true,
        threads: options.parseThreads(body),
        text: body.text,
        ...(body.hostContext === undefined ? {} : { hostContext: body.hostContext }),
      };
      if (options.capture) snapshot = await options.capture(req, snapshot);
      pending = { snapshot, response: res, claimed: false };
      // Keep the browser request open until the receiver has written the review to stdout.
      // The immutable capture owns delivery until receiver acknowledgement.
      // Losing the submitting connection does not revoke accepted work.
      deliver();
    } catch {
      res.status(400).json({ error: 'Invalid review submission' });
    } finally {
      capturing = false;
    }
  });

  app.post('/api/review-handoff/:id/ack', (req, res) => {
    if (!pending || !pending.claimed || pending.snapshot.id !== req.params.id) {
      if (acknowledged === req.params.id) {
        res.json({ success: true });
        return;
      }
      res.status(404).json({ error: 'Review submission is no longer pending.' });
      return;
    }
    const submission = pending;
    pending = null;
    acknowledged = submission.snapshot.id;
    submission.response.json({ receivedByReceiver: true, id: submission.snapshot.id });
    res.json({ success: true });
  });
}
