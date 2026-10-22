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
