import type { DiffFile, DiffSelection, ViewedFileRecord } from '../../types/diff';
import { matchesAutoViewedPatterns } from '../utils/autoViewedPatterns';
import { generateDiffHash, getDiffContentForHashing } from '../utils/diffUtils';
import { storageService, VIEWED_HASH_VERSION } from './StorageService';

export function resetViewedState(
  context: DiffSelection & {
    commit?: string;
    repositoryId?: string;
    branchToHash?: Map<string, string>;
  },
  files: DiffFile[],
  patterns: string[],
  currentReviewOnly: boolean,
): ViewedFileRecord[] | Promise<ViewedFileRecord[]> {
  const { baseCommitish, targetCommitish, commit, branchToHash, repositoryId, baseMode } = context;
  const storeRecords = (automaticRecords: ViewedFileRecord[]) => {
    const stored = storageService.getViewedFiles(
      baseCommitish,
      targetCommitish,
      commit,
      branchToHash,
      repositoryId,
      baseMode,
    );
    if (currentReviewOnly) storageService.removeViewedHashes(repositoryId, stored);
    else storageService.clearViewedHashIndex(repositoryId);
    storageService.saveViewedFiles(
      baseCommitish,
      targetCommitish,
      automaticRecords,
      commit,
      branchToHash,
      repositoryId,
      baseMode,
    );
    storageService.recordViewedHashes(
      repositoryId,
      automaticRecords.map((record) => ({
        ...record,
        hashVersion: VIEWED_HASH_VERSION,
      })),
    );
    return automaticRecords;
  };
  const automaticFiles = files.filter(
    (file) =>
      file.isGenerated ||
      file.status === 'deleted' ||
      matchesAutoViewedPatterns(file.path, patterns),
  );
  if (automaticFiles.length === 0) return storeRecords([]);
  return Promise.all(
    automaticFiles.map(
      async (file): Promise<ViewedFileRecord> => ({
        filePath: file.path,
        viewedAt: new Date().toISOString(),
        diffContentHash: await generateDiffHash(getDiffContentForHashing(file)),
      }),
    ),
  ).then(storeRecords);
}
