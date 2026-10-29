import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewDiffParser } from './review-diff.js';
import { ReviewInventoryService } from './review-inventory.js';

describe('arbitrary branch review inventory', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-inventory-'));
    git('init', '-q', '-b', 'trunk');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'file'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const commit = (body: string) => {
    writeFileSync(join(root, 'file'), `${body}\n`);
    git('commit', '-qam', body);
    return git('rev-parse', 'HEAD');
  };

  it('counts local-only commits against the resolved review target while keeping publication unknown', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    commit('one');
    const head = commit('two');
    const service = new ReviewInventoryService(root);
    const result = await service.getSummaryBatch([
      { branch: 'feature', head, base: 'trunk', publication: null },
    ]);
    expect(result[0]?.status).toMatchObject({
      targetHash: base,
      uniqueCommits: 2,
      ahead: null,
      pushedAhead: null,
      behind: null,
    });
    const zero = await service.getSummaryBatch([
      { branch: 'trunk', head: base, base: 'feature', publication: null },
    ]);
    expect(zero[0]?.status).toMatchObject({ uniqueCommits: 0, targetHash: head });
  });

  it('does not manufacture a local-only count when no review target can be resolved', async () => {
    const head = git('rev-parse', 'HEAD');
    const result = await new ReviewInventoryService(root).getSummaryBatch([
      { branch: 'trunk', head, publication: null },
    ]);
    expect(result[0]?.status).toMatchObject({
      availability: 'unavailable',
      uniqueCommits: null,
      ahead: null,
    });
  });

  it('batch summaries equal individual calculations for distinct heads, configured mappings, ambiguity and checkout edits', async () => {
    const base = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    git('update-ref', 'refs/remotes/origin/trunk', base);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const requests = [];
    for (let index = 0; index < 5; index++) {
      const branch = `feature-${index}`;
      git('checkout', '-qB', branch, base);
      const published = commit(`published-${index}`);
      git('update-ref', `refs/remotes/origin/published-${index}`, published);
      git('config', `branch.${branch}.remote`, 'origin');
      git('config', `branch.${branch}.merge`, `refs/heads/published-${index}`);
      const head = commit(`local-${index}`);
      requests.push({ branch, head, checkout: index === 4 });
    }
    git('config', 'branch.feature-0.gh-merge-base', 'origin/trunk');
    writeFileSync(join(root, 'file'), 'dirty checkout\n');
    const before = readFileSync(join(root, '.git', 'index'));
    const service = new ReviewInventoryService(root);
    const individual = await Promise.all(
      requests.map((request) =>
        service.getSummary(undefined, request.branch, request.head, request.checkout),
      ),
    );
    const batch = await service.getSummaryBatch(requests);
    expect(batch.map((item) => item.status)).toEqual(individual);
    expect(batch.every((item) => !item.error)).toBe(true);
    expect(new Set(individual.map((item) => item.head)).size).toBe(5);
    expect(individual[0]?.baseSuggestion.reason).toBe('Configured comparison base for this branch');
    expect(individual[4]?.dirty).toBe(true);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(before);
    // No snapshot or query memo survives a batch, including another branch's effect on inference.
    git('update-ref', 'refs/remotes/origin/trunk', requests[0]!.head);
    const changed = await service.getSummaryBatch(requests);
    expect(changed.map((item) => item.status)).toEqual(
      await Promise.all(
        requests.map((request) =>
          service.getSummary(undefined, request.branch, request.head, request.checkout),
        ),
      ),
    );
    expect(changed[0]?.status?.targetHash).toBe(requests[0]!.head);
  }, 30_000);

  it('batch failures preserve successful peers and fresh checkout admission', async () => {
    const head = git('rev-parse', 'HEAD');
    const service = new ReviewInventoryService(root);
    const requests = [
      { branch: 'trunk', head, checkout: true },
      { branch: 'missing', head: 'a'.repeat(40) },
      { branch: 'wrong-checkout', head, checkout: true },
    ];
    const results = await service.getSummaryBatch(requests);
    expect(results[0]?.status?.head).toBe(head);
    expect(results[1]?.error).toBeTruthy();
    expect(results[2]?.error).toContain('captured checkout changed');
    await expect(service.getSummaryBatch([])).rejects.toThrow('between 1 and 128');
    await expect(
      service.getSummaryBatch(Array.from({ length: 129 }, () => requests[0]!)),
    ).rejects.toThrow('between 1 and 128');
  });

  it('counts published and local commits from captured PR history without symbolic defaults or exploratory settings', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    commit('published one');
    commit('published two');
    const publication = commit('published three');
    const head = commit('local');
    git('remote', 'add', 'unrelated', 'https://github.com/elsewhere/other.git');
    git('update-ref', 'refs/remotes/unrelated/other', head);
    writeFileSync(join(root, 'file'), 'dirty\n');
    writeFileSync(join(root, 'new'), 'untracked\n');
    const before = readFileSync(join(root, '.git', 'index'));
    const service = new ReviewInventoryService(root);
    const summary = await service.getSummary(base, 'feature', head, true, {
      head: publication,
      source: 'fork/repo',
    });
    expect(summary).toMatchObject({
      availability: 'available',
      head,
      targetHash: base,
      publicationHead: publication,
      ahead: 1,
      pushedAhead: 3,
      behind: 0,
      dirty: true,
      edits: { files: 2 },
    });
    expect(
      await service.getSummary(base, 'feature', head, false, {
        head: publication,
        source: 'fork/repo',
      }),
    ).toMatchObject({ ahead: 1, pushedAhead: 3, dirty: null, edits: undefined });
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(before);
  });

  it('keeps full-graph totals through merges and detects a mode-only dirty checkout', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    const published = commit('published');
    git('checkout', '-qb', 'side');
    writeFileSync(join(root, 'side'), 'side\n');
    git('add', '.');
    git('commit', '-qm', 'side');
    git('checkout', '-q', 'feature');
    commit('local');
    git('merge', '--no-ff', '-qm', 'merge', 'side');
    git('update-index', '--chmod=+x', 'file');
    const summary = await new ReviewInventoryService(root).getSummary(
      base,
      'feature',
      git('rev-parse', 'HEAD'),
      true,
      { head: published, source: 'fixture/repo' },
    );
    expect(summary).toMatchObject({ ahead: 3, pushedAhead: 1, dirty: true });
  });

  it('preserves committed-only summaries and diagnoses missing optional publication history', async () => {
    git('checkout', '-qb', 'feature');
    commit('feature');
    const parser = new ReviewDiffParser(root);
    const stats = vi
      .spyOn(parser, 'getReviewStats')
      .mockRejectedValue(new Error('Unexpected diff read'));
    await new ReviewInventoryService(root, parser).getSummary('trunk', 'feature');
    expect(stats).not.toHaveBeenCalled();
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await new ReviewInventoryService(root).getSummary('trunk', 'feature')).toMatchObject({
      availability: 'available',
      target: 'trunk',
      ahead: null,
      pushedAhead: null,
      behind: null,
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining(
        'Push comparison history is unavailable: refs/remotes/origin/feature',
      ),
    );
    await expect(
      new ReviewInventoryService(root).getInventory('trunk', false, 'feature'),
    ).rejects.toThrow('Push comparison history is unavailable');
  });

  it('maps PR upstreams through the native fetch refspec without requiring a PR lookup', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    const pushed = commit('pushed');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/pull/21140/head');
    git('update-ref', 'refs/remotes/origin/pr/21140', pushed);
    const service = new ReviewInventoryService(root);
    expect(await service.getSummary(base, 'feature')).toMatchObject({
      publicationBranch: 'refs/remotes/origin/pr/21140',
      publicationHead: pushed,
      ahead: 0,
      pushedAhead: 1,
      behind: 0,
    });
    commit('local');
    expect(await service.getSummary(base, 'feature')).toMatchObject({ ahead: 1, pushedAhead: 1 });
    git('update-ref', '-d', 'refs/remotes/origin/pr/21140');
    expect(await service.getSummary(base, 'feature')).toMatchObject({
      targetHash: base,
      ahead: null,
      pushedAhead: null,
      behind: null,
    });
  });

  it('counts a normal remote branch without a PR before and after local commits', async () => {
    git('checkout', '-qb', 'feature');
    const pushed = commit('pushed');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
    git('update-ref', 'refs/remotes/origin/feature', pushed);
    const service = new ReviewInventoryService(root);
    expect(await service.getSummary('trunk', 'feature')).toMatchObject({
      ahead: 0,
      pushedAhead: 1,
      behind: 0,
    });
    commit('local');
    expect(await service.getSummary('trunk', 'feature')).toMatchObject({
      ahead: 1,
      pushedAhead: 1,
      behind: 0,
    });
  });

  it('compares the known default branch with its remote instead of an older feature branch', async () => {
    const old = git('rev-parse', 'HEAD');
    git('branch', 'old-feature', old);
    const head = commit('default branch update');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('update-ref', 'refs/remotes/origin/trunk', head);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    git('config', 'branch.trunk.remote', 'origin');
    git('config', 'branch.trunk.merge', 'refs/heads/trunk');
    const before = readFileSync(join(root, '.git', 'index'));
    const service = new ReviewInventoryService(root);
    expect(await service.getSummary(undefined, 'trunk', head, true)).toMatchObject({
      target: 'origin/trunk',
      targetHash: head,
      ahead: 0,
      pushedAhead: 0,
      behind: 0,
      baseSuggestion: { ambiguous: false, reason: 'Known default branch publication' },
    });
    const remote = git(
      'commit-tree',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      head,
      '-m',
      'remote update',
    );
    git('update-ref', 'refs/remotes/origin/trunk', remote);
    expect(await service.getSummary(undefined, 'trunk', head)).toMatchObject({
      target: 'origin/trunk',
      targetHash: remote,
      pushedAhead: 0,
      behind: 1,
    });
    expect((await service.getComparison('old-feature', 'trunk', head)).target).toBe('old-feature');
    git('config', 'branch.trunk.gh-merge-base', 'old-feature');
    expect((await service.getComparison(undefined, 'trunk', head)).target).toBe('old-feature');
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(before);
  });

  it('treats an unmapped PR upstream as unknown instead of inventing a remote ref', async () => {
    git('checkout', '-qb', 'feature');
    commit('local');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.pushRemote', 'origin');
    git('config', 'branch.feature.merge', 'refs/pull/21140/head');
    expect(await new ReviewInventoryService(root).getSummary('trunk', 'feature')).toMatchObject({
      availability: 'available',
      publicationBranch: undefined,
      ahead: null,
      pushedAhead: null,
      behind: null,
    });
  });

  it('opens local-only work with a normal prospective push destination', async () => {
    git('checkout', '-qb', 'feature');
    const head = commit('local');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('config', 'push.default', 'current');
    const service = new ReviewInventoryService(root);
    expect(await service.getSummary('trunk', 'feature')).toMatchObject({
      ahead: null,
      pushedAhead: null,
    });
    expect((await service.getInventory('trunk', false, 'feature')).commits).toEqual([
      expect.objectContaining({ hash: head, pushed: false }),
    ]);
  });

  it('keeps absent upstream push counts unknown without failing a normal local branch', async () => {
    git('checkout', '-qb', 'feature');
    commit('local');
    expect(await new ReviewInventoryService(root).getSummary('trunk', 'feature')).toMatchObject({
      availability: 'available',
      ahead: null,
      pushedAhead: null,
      behind: null,
    });
  });

  it('resolves the captured comparison without reading diffs or commit statistics', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    const head = commit('feature');
    const parser = new ReviewDiffParser(root);
    const stats = vi
      .spyOn(parser, 'getReviewStats')
      .mockRejectedValue(new Error('Unnecessary diff read'));
    const comparison = await new ReviewInventoryService(root, parser).getComparison(
      'trunk',
      'feature',
      head,
    );
    expect(comparison).toMatchObject({ head, branchBase: base, target: 'trunk' });
    expect(stats).not.toHaveBeenCalled();
  });
  it('offers published PR commits but defaults to staged, unstaged and untracked edits without changing the checkout or index', async () => {
    git('checkout', '-qb', 'feature');
    const head = commit('published');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('update-ref', 'refs/remotes/origin/feature', head);
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
    writeFileSync(join(root, 'file'), 'staged\n');
    git('add', 'file');
    writeFileSync(join(root, 'file'), 'unstaged\n');
    writeFileSync(join(root, 'untracked'), 'new\n');
    const index = readFileSync(join(root, '.git', 'index')),
      status = git('status', '--porcelain=v1');
    const inventory = await new ReviewInventoryService(root).getInventory(
      'trunk',
      false,
      'feature',
      head,
      true,
    );
    expect(inventory.commits).toEqual([expect.objectContaining({ hash: head, pushed: true })]);
    expect(inventory.uncommitted).toMatchObject({ files: 2, additions: 2, deletions: 1 });
    expect(inventory.defaultSelection).toEqual({
      baseCommitish: head,
      targetCommitish: '.',
      includeUntracked: true,
    });
    expect(git('status', '--porcelain=v1')).toBe(status);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('rejects an explicitly unavailable comparison instead of selecting a guessed target', async () => {
    await expect(
      new ReviewInventoryService(root).getInventory('missing-target', false, 'trunk'),
    ).rejects.toThrow('Comparison target is unavailable');
  });

  it('reviews a pinned non-current branch without moving HEAD, changing the index, or including current edits', async () => {
    git('checkout', '-qb', 'feature');
    const featureHead = commit('feature');
    git('checkout', '-q', 'trunk');
    writeFileSync(join(root, 'file'), 'current unstaged edit\n');
    const index = readFileSync(join(root, '.git', 'index')),
      status = git('status', '--porcelain=v1');
    const inventory = await new ReviewInventoryService(root).getInventory(
      'trunk',
      false,
      'feature',
      featureHead,
    );
    expect(inventory.branch).toBe('feature');
    expect(inventory.head.trim()).toBe(featureHead);
    expect(inventory.commits.map((value) => value.hash)).toEqual([featureHead]);
    expect(inventory.uncommitted).toBeUndefined();
    expect(git('branch', '--show-current')).toBe('trunk');
    expect(git('status', '--porcelain=v1')).toBe(status);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('current unstaged edit\n');
  });

  it('suggests a stacked parent and honors an explicit corrected base beyond conventional branch names', async () => {
    git('checkout', '-qb', 'parent');
    commit('parent');
    git('checkout', '-qb', 'child');
    commit('child');
    const service = new ReviewInventoryService(root);
    const guessed = await service.getInventory(undefined, false, 'child');
    expect(guessed.target).toBe('parent');
    expect(guessed.baseSuggestion?.ambiguous).toBe(false);
    git('config', 'branch.child.gh-merge-base', 'trunk');
    expect((await service.getInventory(undefined, false, 'child')).target).toBe('trunk');
    expect(git('config', '--get', 'branch.child.gh-merge-base')).toBe('trunk');
  });

  it('does not call a commit published because an unrelated branch on the intended remote contains it', async () => {
    const base = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'https://github.com/base/repo.git');
    git('remote', 'add', 'fork', 'https://github.com/owner/repo.git');
    git('checkout', '-qb', 'feature');
    const feature = commit('feature');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/trunk');
    git('config', 'branch.feature.pushRemote', 'fork');
    git('update-ref', 'refs/remotes/fork/feature', base);
    git('update-ref', 'refs/remotes/fork/unrelated', feature);
    git('update-ref', 'refs/remotes/fork/trunk', feature);
    git('update-ref', 'refs/remotes/origin/feature', feature);
    const inventory = await new ReviewInventoryService(root).getInventory(
      'trunk',
      false,
      'feature',
    );
    expect(inventory.publicationRemote).toBe('fork');
    expect(inventory.commits[0]).toMatchObject({ hash: feature, pushed: false });
  });

  it('defaults to published commits only when there is no local work', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    const head = commit('published change');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('update-ref', 'refs/remotes/origin/feature', head);
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
    const service = new ReviewInventoryService(root);
    const scoped = await service.getInventory('trunk', false, 'feature', head);
    expect(scoped).toMatchObject({
      reviewedBranch: 'feature',
      defaultSelection: {
        baseCommitish: base,
        targetCommitish: head,
      },
    });
    expect(scoped.commits).toEqual([expect.objectContaining({ hash: head, pushed: true })]);
    const current = await service.getInventory('trunk');
    expect(current.reviewedBranch).toBeUndefined();
    expect(current.defaultSelection).toEqual({ baseCommitish: base, targetCommitish: head });
    writeFileSync(join(root, 'file'), 'working edit\n');
    expect((await service.getInventory('trunk')).defaultSelection).toEqual({
      baseCommitish: head,
      targetCommitish: '.',
      includeUntracked: true,
    });
  });
  it('leaves equally plausible sibling bases uncertain until the user selects a base', async () => {
    git('branch', 'main');
    git('checkout', '-qb', 'left');
    commit('left');
    git('checkout', '-qb', 'right', 'trunk');
    commit('right');
    git('checkout', '-qb', 'reviewed', 'trunk');
    commit('reviewed');
    const service = new ReviewInventoryService(root);
    const inventory = await service.getInventory(undefined, false, 'reviewed');
    expect(inventory.baseSuggestion?.ambiguous).toBe(true);
    const head = git('rev-parse', 'reviewed');
    const summary = await service.getSummaryBatch([
      { branch: 'reviewed', head, publication: null },
    ]);
    expect(summary[0]?.status).toMatchObject({
      uniqueCommits: null,
      baseSuggestion: { ambiguous: true },
    });
    expect(inventory.target).toBeUndefined();
    expect(inventory.baseSuggestion?.candidates).toEqual(expect.arrayContaining(['left', 'right']));
    expect((await service.getInventory('left', false, 'reviewed')).target).toBe('left');
  });

  it('rejects a selected unrelated history without substituting an empty-tree comparison', async () => {
    git('checkout', '--orphan', 'unrelated');
    git('rm', '-q', '-rf', '.');
    writeFileSync(join(root, 'other'), 'unrelated\n');
    git('add', '.');
    git('commit', '-qm', 'unrelated');
    const service = new ReviewInventoryService(root);
    await expect(service.getInventory('trunk', false, 'unrelated')).rejects.toThrow(
      'No shared ancestry',
    );
  });

  it.each(['selected', 'configured'])(
    'does not scan unrelated branches with a %s target',
    async (source) => {
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-qb', 'feature');
      commit('feature');
      for (let index = 0; index < 80; index++)
        git('update-ref', `refs/remotes/origin/other-${index}`, base);
      if (source === 'configured') git('config', 'branch.feature.gh-merge-base', 'trunk');
      const trace = join(root, 'git-trace.log');
      vi.stubEnv('GIT_TRACE', trace);
      const inventory = await new ReviewInventoryService(root).getInventory(
        source === 'selected' ? 'trunk' : undefined,
        false,
        'feature',
      );
      expect(inventory.target).toBe('trunk');
      expect(inventory.baseSuggestion?.ambiguous).toBe(false);
      // Only the selected comparison's merge-base is needed, regardless of ref count.
      expect(readFileSync(trace, 'utf8').match(/built-in: git merge-base /g)).toHaveLength(1);
    },
  );
});
