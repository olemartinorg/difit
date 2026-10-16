import { useCallback, useRef, useState } from 'react';

import type { DiffCommentThread, DiffResponse, DiffSelection } from '../../types/diff';
import type { CommentPromptDiffContext } from '../../utils/commentFormatting';
import { getDiffSelectionKey, normalizeBaseMode } from '../../utils/diffSelection';
import {
  DEFAULT_REVIEW_SETTINGS,
  formatReviewExport,
  type ReviewSettings,
} from '../../utils/reviewExport';
import { clearExportedComments } from '../services/reviewExport';
import { copyTextToClipboard } from '../utils/clipboard';

interface ReviewExportOptions {
  diff: DiffResponse | null;
  resolvedSelection: DiffSelection | null;
  threads: DiffCommentThread[];
  settings: ReviewSettings;
  ready: boolean;
  commentsUrl: string;
  commentVersion: number | null;
  generatePrompt: (context?: CommentPromptDiffContext, separator?: string) => string;
  resetViewed: () => Promise<void>;
  clearComments: (version: number) => void;
}

export function useReviewExport(options: ReviewExportOptions) {
  const { diff, resolvedSelection, threads, settings } = options;
  const context = resolvedSelection
    ? `${diff?.repositoryId}:${getDiffSelectionKey(resolvedSelection)}:${diff?.commit}`
    : '';
  const currentRef = useRef({ context, threads });
  currentRef.current = { context, threads };
  const busyRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptContext: CommentPromptDiffContext = {
    requestedBaseCommitish: diff?.requestedBaseCommitish,
    requestedTargetCommitish: diff?.requestedTargetCommitish,
    baseMode: normalizeBaseMode(diff?.requestedBaseMode),
    resolvedBaseCommitish: diff?.baseCommitish,
    resolvedTargetCommitish: diff?.targetCommitish,
  };
  const prompt =
    settings.separator === DEFAULT_REVIEW_SETTINGS.separator
      ? options.generatePrompt(promptContext)
      : options.generatePrompt(promptContext, settings.separator);

  const exportReview = useCallback(async () => {
    if (busyRef.current || !diff || !resolvedSelection || !options.ready) return;
    busyRef.current = true;
    setPending(true);
    setSucceeded(false);
    setError(null);
    let exported = false;
    const originalThreads = JSON.stringify(threads);
    const isOrigin = () => currentRef.current.context === context;
    try {
      const text = formatReviewExport(prompt, settings.template);
      await copyTextToClipboard(text);
      exported = true;
      setSucceeded(true);
      setTimeout(() => setSucceeded(false), 2000);
      if (settings.resetViewedAfterExport) await options.resetViewed();
      if (settings.clearCommentsAfterExport) {
        if (isOrigin() && JSON.stringify(currentRef.current.threads) !== originalThreads)
          throw new Error('Comments changed since export. They have been kept.');
        await clearExportedComments(
          {
            url: options.commentsUrl,
            selection: resolvedSelection,
            commit: diff.commit,
            repositoryId: diff.repositoryId,
            threads,
            baseVersion: options.commentVersion,
          },
          (version) => {
            if (isOrigin() && JSON.stringify(currentRef.current.threads) === originalThreads)
              options.clearComments(version);
          },
        );
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not export the review.';
      setError(exported ? `Review exported, but cleanup failed: ${message}` : message);
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }, [context, diff, options, prompt, resolvedSelection, settings, threads]);
  return { pending, succeeded, error, exportReview, prompt };
}
