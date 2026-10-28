import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch } from 'undici';
import { expect, it, vi } from 'vitest';
import type { DiffResponse } from '../types/diff.js';
import type { ReviewInventory } from '../types/review.js';
import { getDefaultReviewRange, resolveReviewRange } from '../utils/reviewSelection.js';
import { ReviewInventoryService } from './review-inventory.js';
import { startServer } from './server.js';

it.each(['sha1', 'sha256'])(
  'opens a published checkout without a known base (%s)',
  async (format) => {
    const root = mkdtempSync(join(tmpdir(), 'difit-empty-tree-'));
    let server: Server | undefined;
    vi.stubEnv('DIFIT_CONFIG_DIR', join(root, 'config'));
    vi.stubEnv('DIFIT_REVIEW_STORE', join(root, 'reviews'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      git('init', '-qb', 'feature', `--object-format=${format}`);
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(root, 'committed'), 'committed content\n');
      git('add', 'committed');
      git('commit', '-qm', 'published');
      const head = git('rev-parse', 'HEAD');
      git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
      git('update-ref', 'refs/remotes/origin/feature', head);
      git('config', 'branch.feature.remote', 'origin');
      git('config', 'branch.feature.merge', 'refs/heads/feature');
      writeFileSync(join(root, 'staged'), 'staged\n');
      git('add', 'staged');
      writeFileSync(join(root, 'untracked'), 'new\n'.repeat(13));
      const index = readFileSync(join(root, '.git', 'index'));
      const comparison = await new ReviewInventoryService(root).getComparison(
        undefined,
        'feature',
        head,
      );
      expect(comparison.target).toBeUndefined();
      const subject = {
        repository: root,
        branch: 'feature',
        head,
        baseHead: comparison.branchBase,
        checkout: { branch: 'feature', head },
        working: true,
      };
      const started = await startServer({
        repoPath: root,
        selection: { baseCommitish: comparison.branchBase, targetCommitish: head },
        preferredPort: 0,
        host: '127.0.0.1',
        openBrowser: false,
        keepAlive: true,
      });
      server = started.server;
      const origin = `http://127.0.0.1:${started.port}`;
      const context = new URLSearchParams({
        reviewBranch: 'feature',
        reviewSubject: JSON.stringify(subject),
      });
      const response = await fetch(`${origin}/api/review?${context}`);
      const inventory = (await response.json()) as ReviewInventory;
      expect(response.status, JSON.stringify(inventory)).toBe(200);
      expect(inventory.target).toBeUndefined();
      expect(inventory.branchBase).toBe(comparison.branchBase);
      expect(inventory.commits).toEqual([]);
      expect(inventory.uncommitted).toMatchObject({ additions: 14, deletions: 0 });
      const selection = resolveReviewRange(inventory, getDefaultReviewRange(inventory));
      expect(selection).toEqual({
        baseCommitish: head,
        targetCommitish: '.',
        includeUntracked: true,
      });
      const query = new URLSearchParams(context);
      query.set('base', head);
      query.set('target', '.');
      query.set('includeUntracked', 'true');
      const diffResponse = await fetch(`${origin}/api/diff?${query}`);
      expect(diffResponse.status).toBe(200);
      const diff = (await diffResponse.json()) as DiffResponse;
      expect(diff.files.map((file) => file.path).sort()).toEqual(['staged', 'untracked']);
      expect(readFileSync(join(root, '.git', 'index'))).toEqual(index);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
