import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('includes published PR commits and staged, unstaged and untracked edits without changing the checkout or index', async () => {
    const base = git('rev-parse', 'HEAD');
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
      true,
    );
    expect(inventory.commits).toEqual([expect.objectContaining({ hash: head, pushed: true })]);
    expect(inventory.uncommitted).toMatchObject({ files: 2, additions: 2, deletions: 1 });
    expect(inventory.defaultSelection).toEqual({
      baseCommitish: base,
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

  it('defaults scoped reviews to published commits while current working review keeps local-only defaults', async () => {
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
    expect(current.defaultSelection).toBeNull();
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
