import { reviewFetch } from '../services/reviewContext';
import { reviewIntroduction } from '../../utils/reviewIntroduction';
import { useCallback, useRef, useState } from 'react';

import type { DiffCommentThread, DiffResponse, DiffSelection } from '../../types/diff';
import type { CommentPromptDiffContext } from '../../utils/commentFormatting';
import { normalizeBaseMode } from '../../utils/diffSelection';
import {
  DEFAULT_REVIEW_SETTINGS,
  formatReviewExport,
  type ReviewSettings,
} from '../../utils/reviewExport';
import { clearExportedComments } from '../services/reviewExport';
import { captureReviewHandoffContext } from '../services/reviewHandoffContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { generateDiffHash } from '../utils/diffUtils';

interface ReviewExportOptions {
  diff: DiffResponse | null;
  selection: DiffSelection;
  resolvedSelection: DiffSelection | null;
  threads: DiffCommentThread[];
  settings: ReviewSettings;
  ready: boolean;
  handoff?: boolean;
  commentsUrl: string;
  commentVersion: number | null;
  generatePrompt: (context?: CommentPromptDiffContext, separator?: string) => string;
  resetViewed: () => Promise<void>;
  clearComments: (version: number) => void;
}

export function useReviewExport(options: ReviewExportOptions) {
  const { diff, selection, resolvedSelection, threads, settings } = options;
  const context = diff?.reviewId ?? diff?.repositoryId ?? '';
  const handoff = options.handoff ?? diff?.agentHandoff === true;
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
    let capturingContext = false;
    const originalThreads = JSON.stringify(threads);
    const isOrigin = () => currentRef.current.context === context;
    try {
      const text =
        (diff.reviewSubject
          ? reviewIntroduction(
              diff.reviewSubject,
              resolvedSelection.baseCommitish,
              resolvedSelection.targetCommitish,
            )
          : '') + formatReviewExport(prompt, settings.template);
      capturingContext = handoff;
      const hostContext = handoff ? captureReviewHandoffContext() : undefined;
      if (handoff) {
        const capturedHostContext = await hostContext;
        capturingContext = false;
        const captured = capturedHostContext as { submissionId?: string } | undefined;
        const snapshot = {
          id: captured?.submissionId,
          reviewId: diff.reviewId,
          subject: diff.reviewSubject,
          selection,
          resolvedSelection,
          commit: diff.commit,
          diffHash: await generateDiffHash(JSON.stringify(diff.files)),
          ignoreWhitespace: diff.ignoreWhitespace === true,
          threads,
          text,
          hostContext: capturedHostContext,
        };
        const response = await reviewFetch('/api/review-handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error ?? 'Could not pass the review to the agent.');
        }
        const result = (await response.json()) as {
          delivery?: { outcome: string; error?: string };
        };
        if (result.delivery && result.delivery.outcome !== 'accepted')
          throw new Error(
            `Review submitted; delivery ${result.delivery.outcome}. ${result.delivery.error ?? 'Feedback is retained in submitted history.'}`,
          );
      } else {
        await copyTextToClipboard(text);
      }
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
            repositoryId: diff.reviewId
              ? `${diff.repositoryId}/${diff.reviewId}`
              : diff.repositoryId,
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
      if (capturingContext) console.error('Could not capture review handoff context:', cause);
      const message = capturingContext
        ? 'Could not prepare the review for the agent. Your comments have been kept.'
        : cause instanceof Error
          ? cause.message
          : 'Could not export the review.';
      setError(exported ? `Review exported, but cleanup failed: ${message}` : message);
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }, [context, diff, handoff, options, prompt, resolvedSelection, selection, settings, threads]);
  return { pending, succeeded, error, exportReview, prompt };
}
