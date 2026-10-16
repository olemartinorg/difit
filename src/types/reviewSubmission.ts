import type { DiffCommentThread, DiffSelection } from './diff';

export interface ReviewSubmission {
  id: string;
  submittedAt: string;
  repositoryId: string;
  selection: DiffSelection;
  resolvedSelection: DiffSelection;
  commit: string;
  diffHash: string;
  ignoreWhitespace: boolean;
  threads: DiffCommentThread[];
  text: string;
}
