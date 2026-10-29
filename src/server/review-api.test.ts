import express from 'express';
import { fetch } from 'undici';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewInventory } from '../types/review.js';
import { getDefaultReviewRange, resolveReviewRange } from '../utils/reviewSelection.js';
import { ReviewApi } from './review-api.js';
import { ReviewDiffParser } from './review-diff.js';
import type { ReviewSubject } from '../types/reviewSubmission.js';
import { readUserConfig, updateUserClientSettings } from './user-config.js';

describe('scoped review target API', () => {
  let root: string;
  let server: Server | undefined;
  const repositoryId = 'private-target-fixture';
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = (name: string) => {
    writeFileSync(join(root, name), `${name}\n`);
    git('add', name);
    git('commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-review-target-'));
    vi.stubEnv('DIFIT_CONFIG_DIR', join(root, 'config'));
    git('init', '-qb', 'trunk');
    git('config', 'user.name', 'Target test');
    git('config', 'user.email', 'target@example.invalid');
  });
  afterEach(async () => {
    if (server) {
      const owned = server;
      owned.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        owned.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function fixture() {
    const base = commit('baseline.txt');
    git('checkout', '-qb', 'feature');
    const parent = commit('first-feature.txt');
    git('branch', 'stacked-parent');
    const head = commit('second-feature.txt');
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git('update-ref', 'refs/remotes/origin/feature', head);
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
    git('config', 'branch.feature.gh-merge-base', 'stacked-parent');
    git('checkout', '-q', 'trunk');
    const declaredBase = commit('base-advanced.txt');
    git('branch', 'declared-target');
    // HEAD is unrelated to the PR. Only its pinned head shares this target.
    git('checkout', '--orphan', 'current-unrelated');
    git('rm', '-qrf', '.');
    commit('current-only.txt');
    const subject: ReviewSubject = {
      repository: repositoryId,
      branch: 'feature',
      sourceRepository: 'fixture/repo',
      head,
      base: 'declared-target',
      baseHead: base,
      pullRequest: {
        number: 17,
        url: 'https://github.com/fixture/repo/pull/17',
        head,
        base: 'declared-target',
        baseHead: declaredBase,
      },
    };
    const parser = new ReviewDiffParser(root);
    const app = express();
    app.use(express.json());
    const changed = vi.fn();
    new ReviewApi(root, repositoryId, parser, true, false).registerRoutes(app, changed);
    const listener = app.listen(0, '127.0.0.1');
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('listening', resolve);
      listener.once('error', reject);
    });
    const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const context = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const inventory = async (target?: string) => {
      const query = new URLSearchParams(context);
      if (target) query.set('target', target);
      const response = await fetch(`${origin}/api/review?${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as ReviewInventory;
    };
    return {
      base,
      parent,
      head,
      declaredBase,
      subject,
      parser,
      changed,
      origin,
      context,
      inventory,
    };
  }

  it('initially compares every published PR commit against its captured GitHub target', async () => {
    const f = await fixture();
    const index = readFileSync(join(root, '.git', 'index'));
    // A generic HEAD preference must not become the base of this branch review.
    await updateUserClientSettings({
      reviewTargets: { [`${repositoryId}:HEAD`]: 'stacked-parent' },
    });
    const inventory = await f.inventory();
    expect(inventory).toMatchObject({
      reviewedBranch: 'feature',
      head: f.head,
      target: f.declaredBase,
      targetHash: f.declaredBase,
      branchBase: f.base,
      defaultSelection: { baseCommitish: f.base, targetCommitish: f.head },
      baseSuggestion: { reason: 'Pull request target: declared-target', ambiguous: false },
    });
    expect(inventory.targetOptions).toContainEqual({
      name: f.declaredBase,
      label: `declared-target (${f.declaredBase.slice(0, 7)})`,
      kind: 'remote',
    });
    expect(inventory.commits.map(({ hash, pushed }) => ({ hash, pushed }))).toEqual([
      { hash: f.head, pushed: true },
      { hash: f.parent, pushed: true },
    ]);
    const selection = resolveReviewRange(inventory, getDefaultReviewRange(inventory));
    expect(selection).toEqual(inventory.defaultSelection);
    if (!selection) throw new Error('Published PR range was lost');
    const diff = await f.parser.parseDiff(selection);
    expect(diff).toMatchObject({
      requestedBaseCommitish: f.base,
      requestedTargetCommitish: f.head,
    });
    expect(git('rev-parse', diff.baseCommitish ?? 'missing')).toBe(f.base);
    expect(git('rev-parse', diff.targetCommitish ?? 'missing')).toBe(f.head);
    expect(diff.files.map(({ path }) => path).sort()).toEqual([
      'first-feature.txt',
      'second-feature.txt',
    ]);
    expect(git('branch', '--show-current')).toBe('current-unrelated');
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
  });

  it('admits commits, amendments and rewritten HEAD on the same live branch while preserving the captured PR base', async () => {
    const f = await fixture();
    git('checkout', '-q', 'feature');
    const subject = { ...f.subject, checkout: { branch: 'feature', head: f.head } };
    const query = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const read = async () => {
      const response = await fetch(`${f.origin}/api/review?${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as ReviewInventory;
    };
    for (const change of ['commit', 'amend', 'rewrite']) {
      if (change === 'rewrite') git('reset', '--soft', f.base);
      if (change === 'amend') git('commit', '--amend', '--allow-empty', '-qm', 'amended live work');
      else commit(`${change}-live.txt`);
      const current = git('rev-parse', 'HEAD');
      const inventory = await read();
      expect(inventory.head).toBe(current);
      expect(inventory.target).toBe(f.declaredBase);
      expect(inventory.checkout).toBe(true);
      expect(inventory.commits[0]?.hash).toBe(current);
    }
    // A historical document keeps its intentional revision despite live changes.
    expect((await f.inventory()).head).toBe(f.head);
    git('checkout', '-qb', 'another-branch');
    expect((await fetch(`${f.origin}/api/review?${query}`)).status).toBe(400);
  });

  it('keeps existing captured PR target preference keys while live HEAD advances', async () => {
    const f = await fixture();
    git('checkout', '-q', 'feature');
    const subject = { ...f.subject, checkout: { branch: 'feature', head: f.head } };
    const query = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const key = `${repositoryId}:feature:fixture/repo:${f.head}:${subject.pullRequest!.url}:${f.declaredBase}`;
    await updateUserClientSettings({ reviewTargets: { [key]: 'stacked-parent' } });
    commit('advanced-preferences.txt');
    const loaded = await fetch(`${f.origin}/api/review?${query}`);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      target: 'stacked-parent',
      head: git('rev-parse', 'HEAD'),
    });
    const saved = await fetch(`${f.origin}/api/review/target?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'declared-target' }),
    });
    expect(saved.status).toBe(200);
    const targets = (await readUserConfig()).client.reviewTargets as Record<string, string>;
    expect(targets[key]).toBe('declared-target');
    expect(Object.keys(targets)).toEqual([key]);
  });

  it('fences a checkout change during native inventory reads', async () => {
    const f = await fixture();
    git('checkout', '-q', 'feature');
    const subject = { ...f.subject, checkout: { branch: 'feature', head: f.head } };
    const context = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const original = f.parser.getReviewStats.bind(f.parser);
    vi.spyOn(f.parser, 'getReviewStats').mockImplementationOnce(async (...args) => {
      const stats = await original(...args);
      git('checkout', '-q', 'trunk');
      return stats;
    });
    const response = await fetch(`${f.origin}/api/review?${context}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('checkout changed'),
    });
  });

  it('pins saved and explicitly selected symbolic targets per document while retaining their preference labels', async () => {
    const f = await fixture();
    git('checkout', '-q', 'feature');
    const subject = { ...f.subject, checkout: { branch: 'feature', head: f.head } };
    const query = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const key = `${repositoryId}:feature:fixture/repo:${f.head}:${subject.pullRequest!.url}:${f.declaredBase}`;
    await updateUserClientSettings({ reviewTargets: { [key]: 'stacked-parent' } });
    const initial = (await (
      await fetch(`${f.origin}/api/review?${query}`)
    ).json()) as ReviewInventory;
    query.set('target', 'stacked-parent');
    query.set('targetHead', initial.targetHash!);
    query.set('comparisonBase', initial.branchBase);
    git('branch', '-f', 'stacked-parent', f.head);
    commit('live-after-base-moved.txt');
    const pinned = (await (
      await fetch(`${f.origin}/api/review?${query}`)
    ).json()) as ReviewInventory;
    expect(pinned.target).toBe('stacked-parent');
    expect(pinned.targetHash).toBe(initial.targetHash);
    expect(pinned.branchBase).toBe(initial.branchBase);
    const changed = await fetch(`${f.origin}/api/review/target?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'stacked-parent' }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ targetHash: f.head });
    expect(((await readUserConfig()).client.reviewTargets as Record<string, string>)[key]).toBe(
      'stacked-parent',
    );
  });

  it.each(['targetHead', 'comparisonBase'])(
    'rejects an invalid captured %s without moving the base',
    async (key) => {
      const f = await fixture();
      const query = new URLSearchParams({ [key]: 'stacked-parent' });
      const response = await fetch(`${f.origin}/api/review?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `Invalid captured ${key}` });
    },
  );

  it.each([
    { localCommits: 2, dirty: true },
    { localCommits: 2, dirty: false },
    { localCommits: 0, dirty: true },
    { localCommits: 0, dirty: false },
  ])(
    'prefers local work over a pushed PR history ($localCommits unpushed, dirty: $dirty)',
    async ({ localCommits, dirty }) => {
      const f = await fixture();
      git('checkout', '-q', 'feature');
      for (let count = 0; count < 8; count++)
        git('commit', '--allow-empty', '-qm', `pushed ${count}`);
      const published = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/feature', published);
      const localFiles = Array.from({ length: localCommits }, (_, index) => `local-${index}.txt`);
      for (const file of localFiles) commit(file);
      const head = git('rev-parse', 'HEAD');
      if (dirty) {
        writeFileSync(join(root, 'staged.txt'), 'staged\n');
        git('add', 'staged.txt');
        writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
      }
      const index = readFileSync(join(root, '.git', 'index'));
      const subject: ReviewSubject = {
        ...f.subject,
        head,
        checkout: { branch: 'feature', head },
        pullRequest: { ...f.subject.pullRequest!, head: published },
      };
      const context = new URLSearchParams({
        reviewBranch: 'feature',
        reviewSubject: JSON.stringify(subject),
      });
      const response = await fetch(`${f.origin}/api/review?${context}`);
      expect(response.status).toBe(200);
      const inventory = (await response.json()) as ReviewInventory;
      expect(inventory.commits.filter((commit) => commit.pushed)).toHaveLength(10);
      expect(inventory.commits.filter((commit) => !commit.pushed)).toHaveLength(localCommits);
      const expected = {
        baseCommitish: localCommits || dirty ? published : f.base,
        targetCommitish: dirty ? '.' : head,
        ...(dirty ? { includeUntracked: true } : {}),
      };
      expect(inventory.defaultSelection).toEqual(expected);
      expect(resolveReviewRange(inventory, getDefaultReviewRange(inventory))).toEqual(expected);
      const diff = await f.parser.parseDiff(expected);
      expect(diff.files.map((file) => file.path).sort()).toEqual(
        (localCommits || dirty
          ? [...localFiles, ...(dirty ? ['staged.txt', 'untracked.txt'] : [])]
          : ['first-feature.txt', 'second-feature.txt']
        ).sort(),
      );
      expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
      expect(git('rev-parse', 'HEAD')).toBe(head);
    },
  );

  it('changes compared OIDs and parsed files, validates against pinned head, and remembers the branch correction', async () => {
    const f = await fixture();
    // Remote-only PRs retain the captured head without a same-name local branch.
    git('branch', '-D', 'feature');
    const response = await fetch(`${f.origin}/api/review/target?${f.context}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'stacked-parent' }),
    });
    // The current unrelated checkout has no merge base with this target.
    expect(response.status).toBe(200);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect((await readUserConfig()).client.reviewTargets).toEqual({
      [`${repositoryId}:feature:fixture/repo:${f.head}:https://github.com/fixture/repo/pull/17:${f.declaredBase}`]:
        'stacked-parent',
    });
    const corrected = await f.inventory();
    expect(corrected).toMatchObject({
      target: 'stacked-parent',
      targetHash: f.parent,
      branchBase: f.parent,
      defaultSelection: { baseCommitish: f.parent, targetCommitish: f.head },
    });
    if (!corrected.defaultSelection) throw new Error('Corrected PR range was lost');
    const diff = await f.parser.parseDiff(corrected.defaultSelection);
    expect(diff).toMatchObject({
      requestedBaseCommitish: f.parent,
      requestedTargetCommitish: f.head,
    });
    expect(git('rev-parse', diff.baseCommitish ?? 'missing')).toBe(f.parent);
    expect(git('rev-parse', diff.targetCommitish ?? 'missing')).toBe(f.head);
    expect(diff.files.map(({ path }) => path)).toEqual(['second-feature.txt']);
    // Explicit navigation takes precedence over a remembered branch correction.
    expect(await f.inventory(f.declaredBase)).toMatchObject({
      target: f.declaredBase,
      defaultSelection: { baseCommitish: f.base, targetCommitish: f.head },
    });
  });
});
