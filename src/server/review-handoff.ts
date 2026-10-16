import { randomUUID } from 'crypto';

import type { Express, Response } from 'express';

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
  },
) {
  let pending: { snapshot: ReviewSubmission; response: Response; claimed: boolean } | null = null;
  let receiver: Response | null = null;

  const deliver = () => {
    if (!pending || pending.claimed || !receiver) return;
    pending.claimed = true;
    const waiting = receiver;
    receiver = null;
    waiting.json(pending.snapshot);
  };

  app.get('/api/review-handoff', (_req, res) => {
    if (!options.enabled) {
      res.status(409).json({ error: 'Start difit with --agent-handoff first.' });
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

  app.post('/api/review-handoff', (req, res) => {
    if (!options.enabled) {
      res.status(409).json({ error: 'Agent handoff is not enabled.' });
      return;
    }
    if (pending) {
      res.status(409).json({ error: 'A review is already waiting for an agent.' });
      return;
    }
    try {
      const body = req.body as Partial<ReviewSubmission>;
      if (
        typeof body.text !== 'string' ||
        typeof body.commit !== 'string' ||
        typeof body.diffHash !== 'string' ||
        !Array.isArray(body.threads)
      )
        throw new Error('Invalid review');
      const snapshot: ReviewSubmission = {
        id: randomUUID(),
        submittedAt: new Date().toISOString(),
        repositoryId: options.repositoryId,
        selection: parseSelection(body.selection),
        resolvedSelection: parseSelection(body.resolvedSelection),
        commit: body.commit,
        diffHash: body.diffHash,
        ignoreWhitespace: body.ignoreWhitespace === true,
        threads: options.parseThreads(body),
        text: body.text,
        ...(body.hostContext === undefined ? {} : { hostContext: body.hostContext }),
      };
      pending = { snapshot, response: res, claimed: false };
      // Keep the browser request open until the receiver has written the review to stdout.
      const timeout = setTimeout(() => {
        if (pending?.response === res) pending = null;
        res.status(408).json({
          error: 'No agent acknowledged the review. Start difit review wait and try again.',
        });
      }, 120_000);
      res.on('close', () => {
        clearTimeout(timeout);
        if (pending?.response === res) pending = null;
      });
      deliver();
    } catch {
      res.status(400).json({ error: 'Invalid review submission' });
    }
  });

  app.post('/api/review-handoff/:id/ack', (req, res) => {
    if (!pending || !pending.claimed || pending.snapshot.id !== req.params.id) {
      res.status(404).json({ error: 'Review submission is no longer pending.' });
      return;
    }
    const submission = pending;
    pending = null;
    submission.response.json({ delivered: true, id: submission.snapshot.id });
    res.json({ success: true });
  });
}
