import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch } from 'undici';
import { expect, it, vi } from 'vitest';
import type { DiffResponse } from '../types/diff.js';
import type { ReviewSubject } from '../types/reviewSubmission.js';
import { ReviewDiffParser } from './review-diff.js';
import { startServer } from './server.js';

it('admits fresh live reads without changing the base, notes, historical ranges or accepted submissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'difit-live-refresh-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  let server: Server | undefined;
  vi.stubEnv('DIFIT_CONFIG_DIR', join(root, 'config'));
  vi.stubEnv('DIFIT_REVIEW_STORE', join(root, 'reviews'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = (text: string) => {
    writeFileSync(join(repo, 'marker.txt'), `${text}\n`);
    git('add', 'marker.txt');
    git('commit', '-qm', text);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-qb', 'feature');
    git('config', 'user.name', 'Live review');
    git('config', 'user.email', 'live@example.invalid');
    const base = commit('base'),
      head = commit('original');
    const subject: ReviewSubject = {
      repository: repo,
      sourceRepository: 'local:fixture',
      branch: 'feature',
      head,
      baseHead: base,
      working: true,
      checkout: { branch: 'feature', head },
    };
    const started = await startServer({
      repoPath: repo,
      selection: { baseCommitish: base, targetCommitish: head },
      preferredPort: 0,
      host: '127.0.0.1',
      openBrowser: false,
      keepAlive: true,
      agentHandoff: true,
    });
    server = started.server;
    const origin = `http://127.0.0.1:${started.port}`;
    const context = new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: JSON.stringify(subject),
      base,
      target: '.',
      includeUntracked: 'true',
    });
    const diff = async () => {
      const response = await fetch(`${origin}/api/diff?${context}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as DiffResponse;
    };
    const first = await diff();
    context.set('reviewId', first.reviewId!);
    const note = {
      operations: [
        { kind: 'form', id: 'draft', value: { body: 'Unfinished review', context: {} } },
      ],
    };
    expect(
      (
        await fetch(`${origin}/api/comments?${context}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(note),
        })
      ).status,
    ).toBe(200);
    const advanced = commit('advanced');
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    const index = readFileSync(join(repo, '.git/index'));
    const refreshed = await diff();
    expect(refreshed.reviewId).toBe(first.reviewId);
    expect(refreshed.reviewSubject).toMatchObject({
      head: advanced,
      baseHead: base,
      checkout: { head: advanced },
    });
    expect(refreshed.files.map((file) => file.path).sort()).toEqual([
      'marker.txt',
      'staged.txt',
      'untracked.txt',
    ]);
    expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
    const historical = new URLSearchParams(context);
    historical.set('target', head);
    const captured = (await (
      await fetch(`${origin}/api/diff?${historical}`)
    ).json()) as DiffResponse;
    expect(captured.reviewSubject).toMatchObject({
      head: advanced,
      comparisonHead: head,
      baseHead: base,
    });
    expect(captured.files.map((file) => file.path)).toEqual(['marker.txt']);

    // The same real parser commits between reading bytes and sending the result.
    const parse = ReviewDiffParser.prototype.parseDiff;
    vi.spyOn(ReviewDiffParser.prototype, 'parseDiff').mockImplementationOnce(async function (
      this: ReviewDiffParser,
      ...args
    ) {
      const result = await parse.apply(this, args);
      commit('raced');
      return result;
    });
    const raced = await fetch(`${origin}/api/diff?${context}`);
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ code: 'REVIEW_READ_CHANGED' });
    vi.restoreAllMocks();
    const accepted = await diff();
    expect(accepted.reviewSubject?.head).toBe(git('rev-parse', 'HEAD'));
    const snapshot = {
      id: crypto.randomUUID(),
      subject: accepted.reviewSubject,
      reviewId: accepted.reviewId,
      selection: { baseCommitish: base, targetCommitish: '.', includeUntracked: true },
      resolvedSelection: { baseCommitish: base, targetCommitish: '.' },
      commit: accepted.commit,
      diffHash: 'accepted-rendered-bytes',
      ignoreWhitespace: false,
      threads: [],
      text: 'Captured review',
    };
    const submitted = fetch(`${origin}/api/review-handoff?${context}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    const receiver = await fetch(`${origin}/api/review-handoff`);
    const delivered = (await receiver.json()) as { id: string };
    await fetch(`${origin}/api/review-handoff/${delivered.id}/ack`, { method: 'POST' });
    expect((await submitted).status).toBe(200);
    const storedBefore = await (
      await fetch(`${origin}/api/reviews/submitted/${snapshot.id}`)
    ).json();
    commit('after immutable capture');
    await diff();
    expect(await (await fetch(`${origin}/api/reviews/submitted/${snapshot.id}`)).json()).toEqual(
      storedBefore,
    );
    git('checkout', '-qb', 'another-branch');
    for (const path of [
      '/api/diff',
      '/api/review',
      '/api/review/stats',
      '/api/blob/marker.txt',
      '/api/line-count/marker.txt',
      '/api/generated-status/marker.txt',
    ])
      expect((await fetch(`${origin}${path}?${context}`)).status).toBe(409);
    const saved = await fetch(`${origin}/api/comments?${context}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...note, writeId: crypto.randomUUID() }),
    });
    expect(saved.status).toBe(200);
    expect(
      (
        (await (await fetch(`${origin}/api/review-state?${context}`)).json()) as {
          forms: Record<string, { body: string }>;
        }
      ).forms.draft?.body,
    ).toBe('Unfinished review');
  } finally {
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
