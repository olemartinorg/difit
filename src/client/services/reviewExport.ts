import type { DiffCommentThread, DiffSelection } from '../../types/diff';
import { storageService } from './StorageService';

export async function clearExportedComments(
  snapshot: {
    url: string;
    selection: DiffSelection;
    commit: string;
    repositoryId?: string;
    threads: DiffCommentThread[];
    baseVersion: number | null;
  },
  onCleared: (version: number) => void,
) {
  if (snapshot.baseVersion === null)
    throw new Error('Comments have not finished loading. They have been kept.');
  // Flush the exported snapshot before resetting. A stale version merges agent or
  // other-tab edits, which the conditional DELETE below will preserve.
  const synced = await fetch(snapshot.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads: snapshot.threads, baseVersion: snapshot.baseVersion }),
  });
  if (!synced.ok) throw new Error('Could not save review comments before clearing them.');
  const response = await fetch(snapshot.url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads: snapshot.threads }),
  });
  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? 'Could not clear review comments.');
  }
  const { version } = (await response.json()) as { version: number };
  const stored = storageService.getDiffContextData(
    snapshot.selection.baseCommitish,
    snapshot.selection.targetCommitish,
    snapshot.commit,
    undefined,
    snapshot.repositoryId,
    snapshot.selection.baseMode,
  );
  if (!stored || JSON.stringify(stored.threads) === JSON.stringify(snapshot.threads)) {
    storageService.saveCommentThreads(
      snapshot.selection.baseCommitish,
      snapshot.selection.targetCommitish,
      [],
      snapshot.commit,
      undefined,
      snapshot.repositoryId,
      snapshot.selection.baseMode,
    );
  }
  onCleared(version);
}
