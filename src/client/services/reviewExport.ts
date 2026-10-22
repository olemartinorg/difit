import { reviewFetch } from './reviewContext';
import type { DiffCommentThread } from '../../types/diff';
import { loadReviewComments, saveReviewComments } from './reviewComments';

export async function clearExportedComments(
  snapshot: {
    url: string;
    repositoryId?: string;
    threads: DiffCommentThread[];
    baseVersion: number | null;
  },
  onCleared: (version: number) => void,
) {
  if (snapshot.baseVersion === null)
    throw new Error('Comments have not finished loading. They have been kept.');
  const response = await reviewFetch(snapshot.url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads: snapshot.threads }),
  });
  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? 'Could not clear review comments.');
  }
  const { version } = (await response.json()) as { version: number };
  const stored = loadReviewComments(snapshot.repositoryId);
  if (JSON.stringify(stored.threads) === JSON.stringify(snapshot.threads)) {
    saveReviewComments({ ...stored, threads: [] }, snapshot.repositoryId);
  }
  onCleared(version);
}
