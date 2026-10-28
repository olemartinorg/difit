import { execFile as execute } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { simpleGit } from 'simple-git';

import type { ReviewCommit, ReviewInventory, ReviewTarget } from '../types/review.js';
import { getDefaultReviewRange, resolveReviewRange } from '../utils/reviewSelection.js';
import { ReviewDiffParser } from './review-diff.js';

const execFile = promisify(execute);

export class ReviewInventoryService {
  private readonly git;
  private readonly parser;

  constructor(
    private readonly repoPath: string,
    parser?: ReviewDiffParser,
  ) {
    this.git = simpleGit({
      baseDir: repoPath,
      maxConcurrentProcesses: 4,
      binary: ['git', '--no-optional-locks'],
    });
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

  async getComparison(targetOverride?: string, reviewedBranch?: string, reviewedHead?: string) {
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
    // A captured review can start at the empty tree when no target is known.
    // It is a comparison boundary, not a commit or a branch to resolve.
    const capturedEmptyTree = targetOverride === emptyTree;
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
    if (targetOverride && !validTarget(targetOverride))
      throw new Error(
        `Comparison target is unavailable: ${targetOverride}. Fetch missing history and retry.`,
      );
    const selectedTarget = capturedEmptyTree
      ? undefined
      : [targetOverride, explicitBase].find(validTarget);
    const baseSuggestion = capturedEmptyTree
      ? {
          ref: undefined,
          reason: 'No comparison branch was captured',
          ambiguous: true,
          candidates: [],
        }
      : selectedTarget
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
    const target = capturedEmptyTree
      ? undefined
      : (selectedTarget ??
        [baseSuggestion.ref, defaultBranch?.trim()].find((candidate) => validTarget(candidate)));
    const targetHash = target ? await this.git.revparse([`${target}^{commit}`]) : undefined;
    const commonBase = targetHash
      ? (await this.git.raw(['merge-base', head, targetHash]).catch(() => '')).trim()
      : '';
    if (targetHash && !commonBase)
      throw new Error(
        'No shared ancestry is available. Fetch missing history or choose a related comparison base.',
      );
    const branchBase = commonBase || emptyTree;
    return {
      head: head.trim(),
      branchName,
      target,
      targetHash: targetHash?.trim(),
      branchBase,
      targetOptions,
      baseSuggestion,
      remotes,
      emptyTree,
    };
  }

  private async getPublication(
    branchName: string,
    remotes: Array<{ name: string }>,
    publication?: { head: string; source: string },
    summary = false,
  ) {
    const resolvePublication = async (ref: string) => {
      try {
        const { stdout } = await execFile(
          'git',
          ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
          { cwd: this.repoPath },
        );
        return stdout.trim();
      } catch (error) {
        if (!summary || (error as { code?: unknown }).code !== 1) throw error;
        console.error(`Push comparison history is unavailable: ${ref}. ${String(error)}`);
        return undefined;
      }
    };
    if (publication) {
      if (!publication.source || !/^[a-f0-9]{40,64}$/.test(publication.head))
        throw new Error('Verified publication identity is invalid');
      return {
        publicationHead: await resolvePublication(publication.head),
        publicationRemote: publication.source,
        publicationBranch: undefined,
      };
    }
    const entries = (await this.git.raw(['config', '--list', '--null']))
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('\n');
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      });
    const config = new Map(entries);
    const trackingRemote = config.get(`branch.${branchName}.remote`);
    const selectedRemote =
      config.get(`branch.${branchName}.pushremote`) ??
      config.get('remote.pushdefault') ??
      trackingRemote ??
      'origin';
    const publicationRemote = remotes.some((remote) => remote.name === selectedRemote)
      ? selectedRemote
      : undefined;
    const mergeRef = config.get(`branch.${branchName}.merge`);
    const pushRef = (
      await this.git.raw(['for-each-ref', '--format=%(push)', `refs/heads/${branchName}`])
    ).trim();
    // Git maps branch.merge through remote.fetch. A PR ref or a custom fetch
    // destination cannot be reconstructed by prepending refs/remotes/<remote>.
    const upstreamRef = (
      await this.git.raw(['for-each-ref', '--format=%(upstream)', `refs/heads/${branchName}`])
    ).trim();
    const publicationBranch = publicationRemote
      ? pushRef ||
        (publicationRemote === trackingRemote ? upstreamRef : '') ||
        (!mergeRef || publicationRemote !== trackingRemote
          ? `refs/remotes/${publicationRemote}/${branchName}`
          : undefined)
      : undefined;
    const knownRefs = summary
      ? new Set((await this.git.raw(['for-each-ref', '--format=%(refname)'])).trim().split('\n'))
      : undefined;
    const publicationHead =
      publicationBranch &&
      (!summary || upstreamRef || mergeRef || knownRefs?.has(publicationBranch))
        ? summary
          ? await resolvePublication(publicationBranch)
          : await this.git.revparse([`${publicationBranch}^{commit}`]).then(
              (value) => value.trim(),
              () => undefined,
            )
        : undefined;
    if (!summary && publicationBranch && !publicationHead && (mergeRef || upstreamRef))
      throw new Error(
        `Push comparison history is unavailable: ${publicationBranch}. Fetch missing history and retry.`,
      );
    return { publicationHead, publicationRemote, publicationBranch };
  }

  /** Authoritative counts use supplied Git facts, never saved exploratory targets. */
  async getSummary(
    targetOverride?: string,
    reviewedBranch?: string,
    reviewedHead?: string,
    checkout = false,
    publication?: { head: string; source: string },
  ) {
    const comparison = await this.getComparison(targetOverride, reviewedBranch, reviewedHead);
    const { head, targetHash, branchName, remotes } = comparison;
    const verifyCheckout = async () => {
      if (!checkout) return;
      const current = (await this.git.revparse(['HEAD'])).trim();
      const branch = (await this.git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      if (current !== head || branch !== branchName)
        throw new Error('The captured checkout changed while reading branch status');
    };
    await verifyCheckout();
    const published = await this.getPublication(branchName, remotes, publication, true);
    const count = async (args: string[]) =>
      Number((await this.git.raw(['rev-list', '--count', ...args, '--'])).trim());
    const [ahead, pushedAhead, behind, dirty, edits] = await Promise.all([
      targetHash && published.publicationHead
        ? count([head, '--not', targetHash, published.publicationHead])
        : null,
      targetHash && published.publicationHead
        ? count([head, '--not', targetHash]).then(
            async (total) =>
              total - (await count([head, '--not', targetHash, published.publicationHead ?? head])),
          )
        : null,
      published.publicationHead ? count([published.publicationHead, '--not', head]) : null,
      checkout
        ? this.git
            .raw(['status', '--porcelain=v1', '--untracked-files=all'])
            .then((value) => Boolean(value.trim()))
        : Promise.resolve(false),
      checkout
        ? this.parser.getReviewStats(
            { baseCommitish: head, targetCommitish: '.', includeUntracked: true },
            false,
          )
        : Promise.resolve(undefined),
    ]);
    await verifyCheckout();
    return {
      head,
      branch: branchName,
      target: comparison.target,
      targetHash,
      branchBase: comparison.branchBase,
      baseSuggestion: comparison.baseSuggestion,
      ...published,
      availability: targetHash ? ('available' as const) : ('unavailable' as const),
      ahead,
      pushedAhead,
      behind,
      dirty: checkout ? dirty : null,
      edits,
    };
  }

  async getInventory(
    targetOverride?: string,
    ignoreWhitespace = false,
    reviewedBranch?: string,
    reviewedHead?: string,
    checkout = false,
    publication?: { head: string; source: string },
  ): Promise<ReviewInventory> {
    const {
      head,
      branchName,
      target,
      targetHash,
      branchBase,
      targetOptions,
      baseSuggestion,
      remotes,
      emptyTree,
    } = await this.getComparison(targetOverride, reviewedBranch, reviewedHead);
    const { publicationHead, publicationRemote } = await this.getPublication(
      branchName,
      remotes,
      publication,
    );
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
      reviewedBranch && !checkout
        ? Promise.resolve({ additions: 0, deletions: 0, files: 0, binaryFiles: 0 })
        : this.parser.getReviewStats(
            {
              baseCommitish: head,
              targetCommitish: '.',
              includeUntracked: true,
            },
            ignoreWhitespace,
          ),
      reviewedBranch && !checkout
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
      checkout,
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
      stagedAvailable: staged.files > 0,
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
