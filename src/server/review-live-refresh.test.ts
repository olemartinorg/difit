import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch } from 'undici';
import { expect, it, vi } from 'vitest';
import type { DiffResponse } from '../types/diff.js';
import type { ReviewSubject } from '../types/reviewSubmission.js';
import { ReviewDiffParser } from './review-diff.js';
import { startServer } from './server.js';

it.each(['.', 'working', 'staged'])(
  'rejects a mode-only %s patch when its body changes after native diff parsing',
  async (target) => {
    const root = mkdtempSync(join(tmpdir(), 'difit-mode-only-race-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      git('init', '-qb', 'feature');
      git('config', 'user.name', 'Mode-only review');
      git('config', 'user.email', 'mode@example.invalid');
      git('config', 'core.fileMode', 'true');
      const path = join(root, 'script');
      writeFileSync(path, 'accepted original body\n');
      git('add', '.');
      git('commit', '-qm', 'baseline');
      const head = git('rev-parse', 'HEAD');
      chmodSync(path, 0o755);
      if (target === 'staged') git('add', 'script');
      const args = target === 'staged' ? ['--cached', head] : target === '.' ? [head] : [];
      const nativePatch = git('diff', ...args, '--full-index');
      expect(nativePatch).toContain('old mode 100644');
      expect(nativePatch).toContain('new mode 100755');
      expect(nativePatch).not.toContain('index ');
      expect(nativePatch).not.toContain('@@');
      const selection = {
        baseCommitish: target === 'working' ? 'staged' : head,
        targetCommitish: target,
      };
      const parser = new ReviewDiffParser(root);
      const accepted = await parser.parseDiff(selection);
      expect(accepted.files[0]!.oldBlobId).toBeTruthy();
      expect(accepted.files[0]!.newBlobId).toBe(accepted.files[0]!.oldBlobId);

      // The first old-side identity read occurs only after the real native diff
      // returned its mode-only patch. Replace the mutable new body at that gap.
      const getBlobId = parser.getBlobId.bind(parser);
      vi.spyOn(parser, 'getBlobId').mockImplementationOnce(async (...args) => {
        const id = await getBlobId(...args);
        writeFileSync(path, 'unaccepted replacement body\n');
        if (target === 'staged') git('add', 'script');
        return id;
      });
      await expect(parser.parseDiff(selection)).rejects.toMatchObject({
        code: 'REVIEW_READ_CHANGED',
      });
      expect(git('rev-parse', 'HEAD')).toBe(head);
      const refreshed = await parser.parseDiff(selection);
      expect(refreshed.files[0]!.chunks.flatMap((chunk) => chunk.lines)).toContainEqual(
        expect.objectContaining({ type: 'add', content: 'unaccepted replacement body' }),
      );
      expect(
        (await parser.getBlobContent('script', target, refreshed.files[0]!.newBlobId)).toString(),
      ).toBe('unaccepted replacement body\n');
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
    // The still-displayed original diff must not receive advanced working-tree
    // bytes through context expansion or generated-file detection in manual mode.
    for (const path of [
      '/api/blob/marker.txt?ref=.',
      '/api/line-count/marker.txt?newRef=.',
      '/api/generated-status/marker.txt?ref=.',
    ]) {
      const obsolete = await fetch(`${origin}${path}&${context}`);
      expect(obsolete.status).toBe(409);
      expect(await obsolete.json()).toMatchObject({ code: 'REVIEW_READ_CHANGED' });
    }
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
    const acceptedContext = new URLSearchParams(context);
    acceptedContext.set('reviewSubject', JSON.stringify(refreshed.reviewSubject));
    acceptedContext.set(
      'blobId',
      refreshed.files.find((file) => file.path === 'marker.txt')!.newBlobId!,
    );
    const blob = await fetch(`${origin}/api/blob/marker.txt?ref=.&${acceptedContext}`);
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe('advanced\n');
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

it('keeps native gitlink rendering and binds symbolic-link text without following its target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'difit-native-file-identities-'));
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const init = (directory: string) => {
    git(directory, 'init', '-qb', 'feature');
    git(directory, 'config', 'user.name', 'Native files');
    git(directory, 'config', 'user.email', 'native@example.invalid');
  };
  try {
    init(root);
    const nested = join(root, 'nested');
    mkdirSync(nested);
    init(nested);
    writeFileSync(join(nested, 'file'), 'nested baseline\n');
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'nested baseline');
    symlinkSync('/outside/original-target', join(root, 'link'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'baseline');
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(nested, 'file'), 'nested changed\n');
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'nested changed');
    unlinkSync(join(root, 'link'));
    symlinkSync('/outside/accepted-target', join(root, 'link'));
    const parser = new ReviewDiffParser(root);
    const diff = await parser.parseDiff({ baseCommitish: head, targetCommitish: '.' });
    expect(diff.files.map((file) => file.path).sort()).toEqual(['link', 'nested']);
    expect(
      diff.files
        .find((file) => file.path === 'nested')!
        .chunks.flatMap((chunk) => chunk.lines)
        .some((line) => line.content.startsWith('Subproject commit ')),
    ).toBe(true);
    const link = diff.files.find((file) => file.path === 'link')!;
    expect((await parser.getBlobContent('link', '.', link.newBlobId)).toString()).toBe(
      '/outside/accepted-target',
    );
    unlinkSync(join(root, 'link'));
    symlinkSync('/outside/unaccepted-target', join(root, 'link'));
    await expect(parser.getBlobContent('link', '.', link.newBlobId)).rejects.toMatchObject({
      code: 'REVIEW_READ_CHANGED',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { target: '.', untracked: false },
  { target: 'working', untracked: false },
  { target: 'staged', untracked: false },
  { target: '.', untracked: true },
  { target: '.', untracked: false, crlf: true },
])(
  'binds manual same-HEAD $target content (untracked: $untracked, CRLF: $crlf) to the accepted file bytes',
  async ({ target, untracked, crlf }) => {
    const root = mkdtempSync(join(tmpdir(), 'difit-accepted-content-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    let server: Server | undefined;
    vi.stubEnv('DIFIT_CONFIG_DIR', join(root, 'config'));
    vi.stubEnv('DIFIT_REVIEW_STORE', join(root, 'reviews'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const file = 'notebook.ipynb';
    const notebook = (value: string) =>
      JSON.stringify({
        cells: [{ cell_type: 'markdown', source: [value], metadata: {} }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }) + (crlf ? '\r\n' : '\n');
    try {
      git('init', '-qb', 'feature');
      git('config', 'user.name', 'Accepted content');
      git('config', 'user.email', 'accepted@example.invalid');
      if (crlf) git('config', 'core.autocrlf', 'true');
      writeFileSync(join(repo, untracked ? 'baseline' : file), notebook('baseline'));
      git('add', '.');
      git('commit', '-qm', 'baseline');
      const head = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, file), notebook('accepted original'));
      if (target === 'staged') git('add', file);
      const started = await startServer({
        repoPath: repo,
        selection: { baseCommitish: head, targetCommitish: head },
        preferredPort: 0,
        host: '127.0.0.1',
        openBrowser: false,
        keepAlive: true,
      });
      server = started.server;
      const origin = `http://127.0.0.1:${started.port}`;
      const subject: ReviewSubject = {
        repository: repo,
        branch: 'feature',
        head,
        checkout: { branch: 'feature', head },
        baseHead: head,
        working: true,
      };
      const query = new URLSearchParams({
        reviewSubject: JSON.stringify(subject),
        base: target === 'working' ? 'staged' : head,
        target,
        includeUntracked: String(untracked),
      });
      const response = await fetch(`${origin}/api/diff?${query}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const accepted = (await response.json()) as DiffResponse;
      const acceptedFile = accepted.files.find((entry) => entry.path === file)!;
      expect(acceptedFile.newBlobId).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
      const auxiliary = (path: string, key = 'blobId', blobId = acceptedFile.newBlobId!) => {
        const params = new URLSearchParams({
          reviewSubject: JSON.stringify(accepted.reviewSubject),
          [key]: blobId,
        });
        return fetch(`${origin}${path}&${params}`);
      };
      expect(await (await auxiliary(`/api/blob/${file}?ref=${target}`)).text()).toBe(
        notebook('accepted original'),
      );
      // A manual document and a pending/failed replacement still display this
      // accepted diff, although the working tree or index changed at the same HEAD.
      writeFileSync(join(repo, file), notebook('newer unaccepted content'));
      if (target === 'staged') git('add', file);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      vi.spyOn(ReviewDiffParser.prototype, 'parseDiff').mockRejectedValueOnce(
        new Error('Disposable replacement read failed'),
      );
      expect((await fetch(`${origin}/api/diff?${query}`)).status).toBe(500);
      for (const [path, key] of [
        [`/api/blob/${file}?ref=${target}`, 'blobId'],
        [`/api/line-count/${file}?newRef=${target}`, 'newBlobId'],
        [`/api/generated-status/${file}?ref=${target}`, 'blobId'],
      ]) {
        const stale = await auxiliary(path!, key!);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ code: 'REVIEW_READ_CHANGED' });
      }
      const missing = await fetch(
        `${origin}/api/blob/${file}?ref=${target}&reviewSubject=${encodeURIComponent(JSON.stringify(subject))}`,
      );
      expect(missing.status).toBe(409);
      if (!untracked) {
        const oldRef = target === 'working' ? 'staged' : head;
        expect(
          await (
            await auxiliary(`/api/blob/${file}?ref=${oldRef}`, 'blobId', acceptedFile.oldBlobId!)
          ).text(),
        ).toBe(notebook('baseline').replace(/\r\n/g, '\n'));
      }
      const refreshed = (await (await fetch(`${origin}/api/diff?${query}`)).json()) as DiffResponse;
      const updated = refreshed.files.find((entry) => entry.path === file)!;
      expect(updated.newBlobId).not.toBe(acceptedFile.newBlobId);
      expect(
        await (
          await auxiliary(`/api/blob/${file}?ref=${target}`, 'blobId', updated.newBlobId!)
        ).text(),
      ).toBe(notebook('newer unaccepted content'));
      git('switch', '-qc', 'other-branch');
      expect(
        (await auxiliary(`/api/blob/${file}?ref=${target}`, 'blobId', updated.newBlobId!)).status,
      ).toBe(409);
    } finally {
      vi.restoreAllMocks();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
