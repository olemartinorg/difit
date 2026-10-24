import type { CommitInfo, DiffSelection } from './diff.js';

export interface ReviewStats {
  additions: number;
  deletions: number;
  files: number;
  binaryFiles: number;
}

export interface ReviewCommit extends CommitInfo {
  parent: string;
  timestamp: string;
  isMerge: boolean;
  pushed: boolean;
}

export interface ReviewTarget {
  name: string;
  kind: 'remote' | 'local';
  label?: string;
}

export interface ReviewInventory {
  checkout?: boolean;
  includePublished?: boolean;
  repositoryId: string;
  branch: string;
  reviewedBranch?: string;
  baseSuggestion?: { ref?: string; reason: string; ambiguous: boolean; candidates: string[] };
  head: string;
  target?: string;
  targetHash?: string;
  branchBase: string;
  targetOptions: ReviewTarget[];
  publicationRemote?: string;
  commits: ReviewCommit[];
  uncommitted?: ReviewStats;
  stagedOnly: boolean;
  localStats?: ReviewStats;
  pushedStats?: ReviewStats;
  defaultSelection: DiffSelection | null;
  reviewByDefault: boolean;
}

export interface ReviewRange {
  oldest: string;
  newest: string;
}
