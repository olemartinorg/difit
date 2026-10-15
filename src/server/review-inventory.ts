import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { simpleGit } from 'simple-git';

import type { ReviewCommit, ReviewInventory, ReviewTarget } from '../types/review.js';
import { getDefaultReviewRange, resolveReviewRange } from '../utils/reviewSelection.js';
import { ReviewDiffParser } from './review-diff.js';

export class ReviewInventoryService {
  private readonly git;
  private readonly parser;

  constructor(
    private readonly repoPath: string,
    parser?: ReviewDiffParser,
  ) {
    this.git = simpleGit(repoPath);
    this.parser = parser ?? new ReviewDiffParser(repoPath);
  }

  async getInventory(targetOverride?: string, ignoreWhitespace = false): Promise<ReviewInventory> {
    const [head, branch, refs, remotes, format] = await Promise.all([
      this.git.revparse(['HEAD']),
      this.git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'Detached HEAD'),
      this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
      this.git.getRemotes(),
      this.git.raw(['rev-parse', '--show-object-format']),
    ]);
    const emptyTree = createHash(format.trim()).update('tree 0\0').digest('hex');
    const targetOptions = refs
      .trim()
      .split('\n')
      .filter((ref) => ref && !ref.endsWith('/HEAD'))
      .map(
        (ref): ReviewTarget => ({
          name: ref.replace(/^refs\/(heads|remotes)\//, ''),
          kind: ref.startsWith('refs/remotes/') ? 'remote' : 'local',
        }),
      );
    const remoteHeads = await this.git.raw([
      'for-each-ref',
      '--format=%(symref:short)',
      'refs/remotes',
    ]);
    const defaultBranch =
      (await this.parser.getOriginDefaultBranch()) ??
      remoteHeads.split('\n').find((ref) => ref.trim());
    const target = [targetOverride, defaultBranch].find(
      (candidate) => candidate && targetOptions.some((option) => option.name === candidate),
    );
    const targetHash = target ? await this.git.revparse([`${target}^{commit}`]) : undefined;
    const branchBase = targetHash
      ? (await this.git.raw(['merge-base', head, targetHash]).catch(() => '')).trim() || emptyTree
      : emptyTree;
    const branchName = branch.trim();
    const pushRemote = await this.git
      .raw(['config', '--get', `branch.${branchName}.pushRemote`])
      .catch(() => '');
    const defaultPushRemote = await this.git
      .raw(['config', '--get', 'remote.pushDefault'])
      .catch(() => '');
    const trackingRemote = await this.git
      .raw(['config', '--get', `branch.${branchName}.remote`])
      .catch(() => '');
    const publicationRemote = [
      pushRemote.trim(),
      defaultPushRemote.trim(),
      trackingRemote.trim(),
      'origin',
    ].find((name) => remotes.some((remote) => remote.name === name));
    const revisionArgs = [head, ...(targetHash ? ['--not', targetHash] : [])];
    const [log, unpublished, worktree, staged] = await Promise.all([
      this.git.raw([
        'log',
        '--first-parent',
        '--format=%H%x00%P%x00%cI%x00%s',
        ...revisionArgs,
        '--',
      ]),
      publicationRemote
        ? this.git.raw([
            'rev-list',
            head,
            '--not',
            ...(targetHash ? [targetHash] : []),
            `--remotes=${publicationRemote}`,
            '--',
          ])
        : Promise.resolve(''),
      this.parser.getReviewStats(
        {
          baseCommitish: head,
          targetCommitish: '.',
          includeUntracked: true,
        },
        ignoreWhitespace,
      ),
      this.parser.getReviewStats(
        { baseCommitish: head, targetCommitish: 'staged' },
        ignoreWhitespace,
      ),
    ]);
    const localHashes = new Set(unpublished.trim().split('\n'));
    const commits: ReviewCommit[] = (target ? log.trim().split('\n').filter(Boolean) : []).map(
      (line) => {
        const [hash = '', parents = '', timestamp = '', message = ''] = line.split('\0');
        return {
          hash,
          shortHash: hash.slice(0, 7),
          message,
          timestamp,
          parent: parents.split(' ')[0] || emptyTree,
          isMerge: parents.includes(' '),
          pushed: Boolean(publicationRemote) && !localHashes.has(hash),
        };
      },
    );
    const inventory: ReviewInventory = {
      repositoryId: createHash('sha256').update(resolve(this.repoPath)).digest('hex'),
      branch: branchName,
      head,
      target,
      targetHash,
      branchBase,
      targetOptions,
      publicationRemote,
      commits,
      uncommitted: worktree.files ? worktree : undefined,
      stagedOnly: !worktree.files && staged.files > 0,
      defaultSelection: null,
      reviewByDefault: false,
    };
    const groupStats = async (pushed: boolean) => {
      const group = commits.filter((commit) => commit.pushed === pushed);
      const newest = group[0],
        oldest = group[group.length - 1];
      if (!newest || !oldest) return undefined;
      const selection = resolveReviewRange(inventory, { oldest: oldest.hash, newest: newest.hash });
      return selection ? this.parser.getReviewStats(selection, ignoreWhitespace) : undefined;
    };
    [inventory.localStats, inventory.pushedStats] = await Promise.all([
      groupStats(false),
      groupStats(true),
    ]);
    inventory.defaultSelection = resolveReviewRange(inventory, getDefaultReviewRange(inventory));
    return inventory;
  }
}
