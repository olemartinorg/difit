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
    this.git = simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 4 });
    this.parser = parser ?? new ReviewDiffParser(repoPath);
  }

  private async suggestBase(
    head: string,
    branch: string,
    refs: Array<{ name: string; head: string }>,
    fallback?: string,
  ) {
    const heads = new Map<string, string[]>();
    for (const { name, head: oid } of refs) {
      if (name === branch || name.endsWith(`/${branch}`) || oid === head) continue;
      const names = heads.get(oid) ?? [];
      names.push(name);
      heads.set(oid, names);
    }
    // simple-git's process pool bounds these independent native Git reads.
    const observations = await Promise.all(
      [...heads].map(async ([oid, names]) => {
        try {
          const mergeBase = (await this.git.raw(['merge-base', head, oid])).trim();
          return mergeBase === head ? undefined : { oid, names, mergeBase };
        } catch {
          return undefined; // Shallow and unrelated histories remain uncertain.
        }
      }),
    );
    const distances = new Map(
      await Promise.all(
        [...new Set(observations.flatMap((value) => (value ? [value.mergeBase] : [])))].map(
          async (mergeBase) => {
            try {
              return [
                mergeBase,
                Number(
                  (await this.git.raw(['rev-list', '--count', `${mergeBase}..${head}`])).trim(),
                ),
              ] as const;
            } catch {
              return [mergeBase, undefined] as const;
            }
          },
        ),
      ),
    );
    const candidates = new Map<string, { refs: string[]; distance: number }>();
    for (const value of observations) {
      if (!value) continue;
      const distance = distances.get(value.mergeBase);
      if (distance === undefined) continue;
      candidates.set(value.oid, { refs: value.names, distance });
    }
    const ordered = [...candidates.values()].sort((a, b) => a.distance - b.distance);
    const nearest = ordered.filter((value) => value.distance === ordered[0]?.distance);
    const only = nearest[0];
    if (nearest.length === 1 && only)
      return {
        ref: only.refs[0],
        reason: 'Nearest unambiguous branch point',
        ambiguous: false,
        candidates: only.refs,
      };
    return {
      ref: fallback,
      reason: nearest.length
        ? 'Ambiguous branch points; using known default'
        : 'No reliable ancestry; using known default',
      ambiguous: true,
      candidates: nearest.flatMap((value) => value.refs),
    };
  }

  async getInventory(
    targetOverride?: string,
    ignoreWhitespace = false,
    reviewedBranch?: string,
    reviewedHead?: string,
  ): Promise<ReviewInventory> {
    const [head, branch, refs, remotes, format] = await Promise.all([
      this.git.revparse([
        reviewedHead
          ? `${reviewedHead}^{commit}`
          : reviewedBranch
            ? `refs/heads/${reviewedBranch}^{commit}`
            : 'HEAD',
      ]),
      reviewedBranch
        ? Promise.resolve(reviewedBranch)
        : this.git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'Detached HEAD'),
      this.git.raw([
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        'refs/heads',
        'refs/remotes',
      ]),
      this.git.getRemotes(),
      this.git.raw(['rev-parse', '--show-object-format']),
    ]);
    const emptyTree = createHash(format.trim()).update('tree 0\0').digest('hex');
    const references = refs
      .trim()
      .split('\n')
      .map((line) => {
        const [ref = '', oid = ''] = line.split('\0');
        return { ref, head: oid };
      })
      .filter(({ ref }) => ref && !ref.endsWith('/HEAD'));
    const targetOptions = references.map(
      ({ ref }): ReviewTarget => ({
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
    const branchName = branch.trim();
    const explicitBase = (
      await this.git.raw(['config', '--get', `branch.${branchName}.gh-merge-base`]).catch(() => '')
    ).trim();
    const validTarget = (candidate: string | undefined) =>
      candidate &&
      (targetOptions.some((option) => option.name === candidate) ||
        /^[a-f0-9]{40,64}$/.test(candidate));
    const selectedTarget = [targetOverride, explicitBase].find(validTarget);
    const baseSuggestion = selectedTarget
      ? {
          ref: selectedTarget,
          reason:
            selectedTarget === targetOverride
              ? 'Selected comparison base'
              : 'Configured comparison base for this branch',
          ambiguous: false,
          candidates: [selectedTarget],
        }
      : await this.suggestBase(
          head.trim(),
          branchName,
          references.map(({ ref, head: oid }) => ({
            name: ref.replace(/^refs\/(heads|remotes)\//, ''),
            head: oid,
          })),
          defaultBranch?.trim(),
        );
    const target =
      selectedTarget ??
      [baseSuggestion.ref, defaultBranch?.trim()].find((candidate) => validTarget(candidate));
    const targetHash = target ? await this.git.revparse([`${target}^{commit}`]) : undefined;
    const commonBase = targetHash
      ? (await this.git.raw(['merge-base', head, targetHash]).catch(() => '')).trim()
      : '';
    if (targetHash && !commonBase)
      throw new Error(
        'No shared ancestry is available. Fetch missing history or choose a related comparison base.',
      );
    const branchBase = commonBase || emptyTree;
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
    const mergeRef = (
      await this.git.raw(['config', '--get', `branch.${branchName}.merge`]).catch(() => '')
    ).trim();
    const pushRef = (
      await this.git
        .raw(['for-each-ref', '--format=%(push)', `refs/heads/${branchName}`])
        .catch(() => '')
    ).trim();
    const publicationName =
      publicationRemote === trackingRemote.trim()
        ? mergeRef.replace(/^refs\/heads\//, '') || branchName
        : branchName;
    const publicationBranch = publicationRemote
      ? pushRef.startsWith(`refs/remotes/${publicationRemote}/`)
        ? pushRef
        : `refs/remotes/${publicationRemote}/${publicationName}`
      : undefined;
    const publicationHead = publicationBranch
      ? await this.git.revparse([`${publicationBranch}^{commit}`]).then(
          (value) => value.trim(),
          () => undefined,
        )
      : undefined;
    const revisionArgs = [head, ...(targetHash ? ['--not', targetHash] : [])];
    const [log, unpublished, worktree, staged] = await Promise.all([
      this.git.raw([
        'log',
        '--first-parent',
        '--format=%H%x00%P%x00%cI%x00%s',
        ...revisionArgs,
        '--',
      ]),
      publicationHead
        ? this.git.raw([
            'rev-list',
            head,
            '--not',
            ...(targetHash ? [targetHash] : []),
            publicationHead,
            '--',
          ])
        : this.git.raw(['rev-list', head, ...(targetHash ? ['--not', targetHash] : []), '--']),
      reviewedBranch
        ? Promise.resolve({ additions: 0, deletions: 0, files: 0, binaryFiles: 0 })
        : this.parser.getReviewStats(
            {
              baseCommitish: head,
              targetCommitish: '.',
              includeUntracked: true,
            },
            ignoreWhitespace,
          ),
      reviewedBranch
        ? Promise.resolve({ additions: 0, deletions: 0, files: 0, binaryFiles: 0 })
        : this.parser.getReviewStats(
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
          pushed: Boolean(publicationHead) && !localHashes.has(hash),
        };
      },
    );
    const inventory: ReviewInventory = {
      repositoryId: createHash('sha256').update(resolve(this.repoPath)).digest('hex'),
      branch: branchName,
      reviewedBranch,
      baseSuggestion,
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
