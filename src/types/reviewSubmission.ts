import type { DiffCommentThread, DiffSelection } from './diff';

export interface ReviewSubmission {
  id: string;
  reviewId?: string;
  subject?: import('../server/review-store.js').ReviewSubject;
  submittedAt: string;
  repositoryId: string;
  selection: DiffSelection;
  resolvedSelection: DiffSelection;
  commit: string;
  diffHash: string;
  ignoreWhitespace: boolean;
  threads: DiffCommentThread[];
  text: string;
  /** Optional opaque embedder context. Text exports remain unchanged. */
  hostContext?: unknown;
}
