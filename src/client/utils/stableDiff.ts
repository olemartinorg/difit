import type { DiffFile, DiffResponse } from '../../types/diff';
import type { MergedChunk } from '../hooks/useExpandedLines';

// A changed file can render its new hunks immediately while expanded context is
// recalculated, instead of briefly unmounting every line and comment form.
export function getInitialMergedChunks(file: DiffFile): MergedChunk[] {
  const complete = file.status === 'added' || file.status === 'deleted';
  return file.chunks.map((chunk, index) => {
    const previous = file.chunks[index - 1];
    return {
      ...chunk,
      originalIndices: [index],
      hiddenLinesBefore: complete
        ? 0
        : Math.max(0, chunk.oldStart - (previous ? previous.oldStart + previous.oldLines : 1)),
      hiddenLinesAfter: complete || index < file.chunks.length - 1 ? 0 : -1,
    };
  });
}

export function reconcileDiffResponse(
  previous: DiffResponse | null,
  incoming: DiffResponse,
): DiffResponse {
  if (!previous) return incoming;
  const sameContext =
    previous.baseCommitish === incoming.baseCommitish &&
    previous.targetCommitish === incoming.targetCommitish &&
    previous.repositoryId === incoming.repositoryId;
  const oldFiles = new Map(sameContext ? previous.files.map((file) => [file.path, file]) : []);
  const files = incoming.files.map((file) => {
    const old = oldFiles.get(file.path);
    if (!old) return file;
    const next = file.isGenerated === undefined ? { ...file, isGenerated: old.isGenerated } : file;
    return JSON.stringify(old) === JSON.stringify(next) ? old : file;
  });
  if (
    files.length === previous.files.length &&
    files.every((file, i) => file === previous.files[i]) &&
    JSON.stringify({ ...previous, files: [] }) === JSON.stringify({ ...incoming, files: [] })
  )
    return previous;
  return { ...incoming, files };
}
