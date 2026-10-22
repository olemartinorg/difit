import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch } from 'undici';
import { expect, it, vi } from 'vitest';
import type { DiffResponse } from '../types/diff.js';
import { getDefaultReviewRange, resolveReviewRange } from '../utils/reviewSelection.js';
import type { ReviewInventory } from '../types/review.js';
import type { ReviewSubject } from '../types/reviewSubmission.js';
import { startServer } from './server.js';

it('publishes the actual comparison snapshot and files after a scoped review target changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'difit-target-diff-'));
  let server: Server | undefined;
  vi.stubEnv('DIFIT_CONFIG_DIR', join(root, 'config'));
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
  try {
    git('init', '-qb', 'trunk');
    git('config', 'user.name', 'Target snapshot test');
    git('config', 'user.email', 'snapshot@example.invalid');
    const base = commit('baseline');
    git('checkout', '-qb', 'feature');
    const parent = commit('first-feature');
    git('branch', 'stacked-parent');
    const head = commit('second-feature');
    git('checkout', '-q', 'trunk');
    const subject: ReviewSubject = {
      repository: root,
      branch: 'feature',
      head,
      base: 'trunk',
      baseHead: base,
      pullRequest: {
        number: 17,
        url: 'https://github.com/fixture/repo/pull/17',
        head,
        base: 'trunk',
        baseHead: base,
      },
    };
    const allocate = createServer();
    await new Promise<void>((resolve, reject) => {
      allocate.once('error', reject);
      allocate.listen(0, '127.0.0.1', resolve);
    });
    const port = (allocate.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      allocate.close((error) => (error ? reject(error) : resolve())),
    );
    const started = await startServer({
      repoPath: root,
      selection: { baseCommitish: base, targetCommitish: head },
      preferredPort: port,
      host: '127.0.0.1',
      openBrowser: false,
      keepAlive: true,
    });
    server = started.server;
    if (!server) throw new Error('Diff server did not start');
    const origin = `http://127.0.0.1:${started.port}`;
    const context = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
    });
    const diffFor = async (selection: { baseCommitish: string; targetCommitish: string }) => {
      const query = new URLSearchParams(context);
      query.set('base', selection.baseCommitish);
      query.set('target', selection.targetCommitish);
      const response = await fetch(`${origin}/api/diff?${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as DiffResponse;
    };
    const initial = await diffFor({ baseCommitish: base, targetCommitish: head });
    expect(initial.reviewSubject).toMatchObject({ head, comparisonHead: head, baseHead: base });
    expect(initial.files.map(({ path }) => path).sort()).toEqual([
      'first-feature',
      'second-feature',
    ]);
    const saved = await fetch(`${origin}/api/review/target?${context}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'stacked-parent' }),
    });
    expect(saved.status).toBe(200);
    const inventoryResponse = await fetch(`${origin}/api/review?${context}`);
    expect(inventoryResponse.status).toBe(200);
    const inventory = (await inventoryResponse.json()) as ReviewInventory;
    const selection = resolveReviewRange(inventory, getDefaultReviewRange(inventory));
    if (!selection) throw new Error('Changed target lost the scoped comparison');
    expect(selection).toEqual({ baseCommitish: parent, targetCommitish: head });
    const corrected = await diffFor(selection);
    expect(corrected.reviewSubject).toMatchObject({
      head,
      comparisonHead: head,
      baseHead: parent,
      pullRequest: { base: 'trunk', baseHead: base },
    });
    expect(corrected.files.map(({ path }) => path)).toEqual(['second-feature']);
    expect(git('branch', '--show-current')).toBe('trunk');
  } finally {
    if (server) {
      const owned = server;
      owned.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        owned.close((error) => (error ? reject(error) : resolve())),
      );
    }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
