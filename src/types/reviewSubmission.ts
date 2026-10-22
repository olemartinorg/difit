import type { DiffCommentThread, DiffSelection } from './diff';

export interface ReviewSubject {
  repository: string;
  branch: string;
  head: string;
  base?: string;
  baseHead?: string;
  comparisonHead?: string;
  pullRequest?: { number: number; url: string; head: string; base: string; baseHead?: string };
  unpublished?: boolean;
  working?: boolean;
}
export interface ReviewDeliveryReceipt {
  outcome: 'submitted' | 'accepted' | 'failed' | 'unknown';
  conversationId?: string;
  error?: string;
}

export interface SubmittedReview extends ReviewSubmission {
  receipt: ReviewDeliveryReceipt;
}

export type SubmittedReviewSummary = Pick<
  SubmittedReview,
  'id' | 'reviewId' | 'submittedAt' | 'repositoryId' | 'subject' | 'receipt'
>;

export interface ReviewSubmission {
  id: string;
  reviewId?: string;
  subject?: ReviewSubject;
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
