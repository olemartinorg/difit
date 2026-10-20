import type {
  DiffCommentThread,
  DiffContextStorage,
  LegacyDiffContextStorage,
} from '../../types/diff';
import { mergeCommentThreads } from '../../utils/commentImports';

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
  if (stored) return JSON.parse(stored) as ReviewComments;

  // Migrate all comparisons once. Keeping an empty review record prevents cleared
  // comments from being imported again, while old viewed-file records stay intact.
  const prefix = `difit-storage-v1/${repositoryId ? `${repositoryId}/` : ''}`;
  let threads: DiffCommentThread[] = [];
  const importIds = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix) || key.slice(prefix.length).includes('/')) continue;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as
        | DiffContextStorage
        | LegacyDiffContextStorage
        | null;
      if (!raw) continue;
      const migrated =
        raw.version === 1
          ? raw.comments.map(({ body, author, ...comment }) => ({
              ...comment,
              messages: [
                {
                  id: comment.id,
                  body,
                  author,
                  createdAt: comment.createdAt,
                  updatedAt: comment.updatedAt,
                },
              ],
            }))
          : raw.threads;
      threads = mergeCommentThreads(threads, migrated).threads;
      for (const id of 'appliedCommentImportIds' in raw ? (raw.appliedCommentImportIds ?? []) : [])
        importIds.add(id);
    } catch (error) {
      console.error('Could not migrate stored review comments:', error);
    }
  }
  const data = { threads, appliedCommentImportIds: [...importIds] };
  saveReviewComments(data, repositoryId);
  return data;
}
