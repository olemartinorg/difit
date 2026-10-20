import type { DiffCommentThread } from '../../types/diff';

interface ReviewComments {
  threads: DiffCommentThread[];
  appliedCommentImportIds: string[];
}

const PREFIX = 'difit-review-comments-v1/';

export function saveReviewComments(data: ReviewComments, repositoryId?: string): void {
  localStorage.setItem(`${PREFIX}${repositoryId ?? '__default__'}`, JSON.stringify(data));
}

export function loadReviewComments(repositoryId?: string): ReviewComments {
  const stored = localStorage.getItem(`${PREFIX}${repositoryId ?? '__default__'}`);
  return stored ? (JSON.parse(stored) as ReviewComments) : { threads: [], appliedCommentImportIds: [] };
}
