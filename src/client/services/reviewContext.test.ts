import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  vi.resetModules();
});

test('review requests retain captured identity defaults without changing the global fetch function', async () => {
  window.history.replaceState(
    null,
    '',
    '/?reviewBranch=feature&reviewSubject=captured&reviewId=initial&target=head&base=base&baseMode=merge-base&includeUntracked=true',
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  const { reviewFetch, reviewURL, commentURL } = await import('./reviewContext');
  expect(globalThis.fetch).toBe(fetcher);
  expect(new URL(reviewURL('/api/diff'), window.location.origin).searchParams).toEqual(
    new URLSearchParams({
      reviewBranch: 'feature',
      reviewSubject: 'captured',
      reviewId: 'initial',
      target: 'head',
      base: 'base',
      baseMode: 'merge-base',
      includeUntracked: 'true',
    }),
  );
  const explicit = new URL(
    reviewURL('/api/diff?target=selected&base=chosen'),
    window.location.origin,
  );
  expect(explicit.searchParams.get('target')).toBe('selected');
  expect(explicit.searchParams.get('base')).toBe('chosen');
  expect(explicit.searchParams.has('baseMode')).toBe(false);
  const comments = new URL(
    commentURL('/api/comments?keep=yes', 'resolved', {
      baseCommitish: 'new-base',
      targetCommitish: 'new-head',
    }),
    window.location.origin,
  );
  expect(Object.fromEntries(comments.searchParams)).toEqual({
    keep: 'yes',
    reviewId: 'resolved',
    base: 'new-base',
    target: 'new-head',
    reviewBranch: 'feature',
    reviewSubject: 'captured',
  });
  window.history.replaceState(null, '', '/?reviewBranch=another');
  await reviewFetch('/api/review', { method: 'GET' });
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/review?reviewBranch=feature&reviewSubject=captured&reviewId=initial',
    { method: 'GET' },
  );
  await fetch('/api/user-settings');
  await fetch('/api/blob/file?ref=chosen');
  await fetch('/api/open-in-editor', { method: 'POST' });
  expect(fetcher.mock.calls.slice(-3).map((call) => call[0])).toEqual([
    '/api/user-settings',
    '/api/blob/file?ref=chosen',
    '/api/open-in-editor',
  ]);
});

test('reconciles only obsolete read attempts and preserves actual failures and mutation outcomes', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: 'Changed during read', code: 'REVIEW_READ_CHANGED' }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json({ head: 'accepted' }))
    .mockResolvedValueOnce(Response.json({ error: 'Missing Git object' }, { status: 500 }))
    .mockResolvedValueOnce(
      Response.json({ error: 'Changed during read', code: 'REVIEW_READ_CHANGED' }, { status: 409 }),
    );
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  const { reviewFetch } = await import('./reviewContext');
  expect(await (await reviewFetch('/api/diff')).json()).toEqual({ head: 'accepted' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await reviewFetch('/api/diff')).status).toBe(500);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect((await reviewFetch('/api/review-handoff', { method: 'POST', body: '{}' })).status).toBe(
    409,
  );
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test('owner cancellation stops an obsolete read before a replacement dispatch', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    return Response.json({ code: 'REVIEW_READ_CHANGED' }, { status: 409 });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  const { reviewFetch } = await import('./reviewContext');
  await expect(reviewFetch('/api/diff', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test('auxiliary reads use the accepted diff subject and never replay an obsolete context', async () => {
  window.history.replaceState(null, '', '/?reviewSubject=original');
  const accepted = {
    repository: 'fixture',
    branch: 'feature',
    head: 'accepted',
    checkout: { branch: 'feature', head: 'accepted' },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json({ code: 'REVIEW_READ_CHANGED' }, { status: 409 }),
    );
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  const { reviewFetch } = await import('./reviewContext');
  for (const path of [
    '/api/blob/file?ref=.',
    '/api/line-count/file?newRef=.',
    '/api/generated-status/file?ref=.',
  ]) {
    expect((await reviewFetch(path, undefined, accepted)).status).toBe(409);
    const request = new URL(String(fetcher.mock.lastCall?.[0]), window.location.origin);
    expect(JSON.parse(request.searchParams.get('reviewSubject')!)).toEqual(accepted);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
});
