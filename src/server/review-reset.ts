import type { Express } from 'express';

import type { DiffCommentThread, DiffSelection } from '../types/diff.js';

interface CommentSession {
  threads: DiffCommentThread[];
  version: number;
}

export function registerReviewReset(
  app: Express,
  sessions: {
    getSelection: (query: Record<string, unknown>) => DiffSelection;
    getSession: (selection: DiffSelection) => CommentSession;
    reset: (selection: DiffSelection) => void;
  },
) {
  const resetVersions = new WeakMap<CommentSession, number>();

  app.delete('/api/comments', (req, res) => {
    const selection = sessions.getSelection(req.query as Record<string, unknown>);
    const { threads } = (req.body ?? {}) as { threads?: unknown };
    if (
      threads !== undefined &&
      JSON.stringify(threads) !== JSON.stringify(sessions.getSession(selection).threads)
    ) {
      res.status(409).json({ error: 'Comments changed since export. They have been kept.' });
      return;
    }
    sessions.reset(selection);
    const session = sessions.getSession(selection);
    resetVersions.set(session, session.version);
    res.json({ success: true, version: session.version });
  });

  // An earlier autosave must not restore comments after an explicit reset.
  app.post('/api/comments', (req, res, next) => {
    const session = sessions.getSession(
      sessions.getSelection(req.query as Record<string, unknown>),
    );
    const resetVersion = resetVersions.get(session);
    const { baseVersion } = (req.body ?? {}) as { baseVersion?: unknown };
    if (
      typeof baseVersion === 'number' &&
      resetVersion !== undefined &&
      baseVersion < resetVersion
    ) {
      res.json({ success: true, merged: true, version: session.version, threads: session.threads });
      return;
    }
    next();
  });
}
