import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { simpleGit } from 'simple-git';

import { validateDiffArguments } from '../cli/utils.js';
import type { DiffFile, DiffResponse, DiffSelection } from '../types/diff.js';
import type { ReviewStats } from '../types/review.js';
import { getMergeBaseTargetRef } from '../utils/diffSelection.js';
import { GitDiffParser } from './git-diff.js';

type UntrackedDiffFile = DiffFile & { binary?: boolean };

// Keep the upstream parser unchanged; local review adds read-only untracked files.
export class ReviewDiffParser extends GitDiffParser {
  private readonly reviewGit;

  constructor(private readonly reviewPath: string) {
    super(reviewPath);
    this.reviewGit = simpleGit({ baseDir: reviewPath, binary: ['git', '--no-optional-locks'] });
  }

  override async parseDiff(
    selection: DiffSelection,
    ignoreWhitespace = false,
    contextLines?: number,
  ): Promise<DiffResponse> {
    const result = await super.parseDiff(selection, ignoreWhitespace, contextLines);
    if (selection.targetCommitish === '.' && selection.includeUntracked) {
      result.files.push(...(await this.getUntrackedDiffFiles(contextLines)));
      result.isEmpty = result.files.length === 0;
    }
    result.requestedIncludeUntracked = selection.includeUntracked;
    return result;
  }

  private async getUntrackedDiffFiles(contextLines = 3): Promise<UntrackedDiffFile[]> {
    const paths = (await this.reviewGit.raw(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const files = await Promise.all(
      paths.map(async (path): Promise<UntrackedDiffFile | null> => {
        try {
          const absolute = resolve(this.reviewPath, path);
          const info = await lstat(absolute);
          if (!info.isFile() && !info.isSymbolicLink()) return null;
          const content = info.isSymbolicLink()
            ? Buffer.from(await readlink(absolute))
            : await readFile(absolute);
          if (content.includes(0)) {
            return {
              path,
              status: 'added',
              additions: 0,
              deletions: 0,
              chunks: [],
              binary: true,
            };
          }
          const patch = createTwoFilesPatch(
            '/dev/null',
            path,
            '',
            content.toString('utf8'),
            '',
            '',
            { context: contextLines },
          );
          return (
            this.parseStdinDiff(patch).files[0] ?? {
              path,
              status: 'added',
              additions: 0,
              deletions: 0,
              chunks: [],
            }
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }),
    );
    return files.filter((file): file is UntrackedDiffFile => file !== null);
  }

  async getReviewStats(selection: DiffSelection, ignoreWhitespace = false): Promise<ReviewStats> {
    const validation = validateDiffArguments(selection.targetCommitish, selection.baseCommitish);
    if (!validation.valid) throw new Error(validation.error);
    const base =
      selection.baseMode === 'merge-base'
        ? (
            await this.reviewGit.raw([
              'merge-base',
              getMergeBaseTargetRef(selection.targetCommitish),
              selection.baseCommitish,
            ])
          ).trim()
        : selection.baseCommitish;
    const args =
      selection.targetCommitish === '.'
        ? [base]
        : selection.targetCommitish === 'staged'
          ? ['--cached', base]
          : [base, selection.targetCommitish];
    const raw = await this.reviewGit.diff([
      ...args,
      ...(ignoreWhitespace ? ['-w'] : []),
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--color=never',
      '--',
    ]);
    const stats: ReviewStats = { additions: 0, deletions: 0, files: 0, binaryFiles: 0 };
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const match = records[i]?.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
      if (!match) continue;
      stats.files++;
      if (match[1] === '-') stats.binaryFiles++;
      else {
        stats.additions += Number(match[1]);
        stats.deletions += Number(match[2]);
      }
      if (!match[3]) i += 2; // Renames have separate NUL-delimited old and new paths.
    }
    if (selection.targetCommitish === '.' && selection.includeUntracked) {
      for (const file of await this.getUntrackedDiffFiles()) {
        stats.files++;
        stats.additions += file.additions;
        if (file.binary) stats.binaryFiles++;
      }
    }
    return stats;
  }
}
