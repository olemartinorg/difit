import type { DiffSelection } from '../../types/diff';
import type { ReviewSubject } from '../../types/reviewSubmission';

// Capture the subject when this document opens. Explicit selections can change
// the compared range without changing that logical review.
const context = new URLSearchParams(window.location.search);

export function reviewURL(path: string, parameters?: URLSearchParams): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of parameters ?? []) url.searchParams.set(key, value);
  for (const key of ['reviewBranch', 'reviewSubject', 'reviewId']) {
    const value = context.get(key);
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  if (url.pathname === '/api/diff' && !url.searchParams.has('target'))
    for (const key of ['target', 'base', 'baseMode', 'includeUntracked']) {
      const value = context.get(key);
      if (value) url.searchParams.set(key, value);
    }
  return `${url.pathname}${url.search}`;
}

export function commentURL(
  path: string,
  reviewId?: string,
  selection?: DiffSelection | null,
): string {
  const params = new URLSearchParams();
  if (reviewId) params.set('reviewId', reviewId);
  if (selection) {
    params.set('base', selection.baseCommitish);
    params.set('target', selection.targetCommitish);
    if (selection.baseMode === 'merge-base') params.set('baseMode', selection.baseMode);
  }
  return reviewURL(path, params);
}

export async function reviewFetch(
  path: string,
  init?: RequestInit,
  subject?: ReviewSubject,
): Promise<Response> {
  const parameters = new URLSearchParams();
  if (subject) parameters.set('reviewSubject', JSON.stringify(subject));
  const url = reviewURL(path, parameters);
  const refresh = ['/api/diff', '/api/review'].includes(
    new URL(url, window.location.origin).pathname,
  );
  // A changed revision invalidates only this read. Join it before reading the
  // branch again; real failures and owner cancellation still reach the caller.
  for (;;) {
    init?.signal?.throwIfAborted();
    const response = await (init === undefined ? fetch(url) : fetch(url, init));
    if (response.ok || !refresh || (init?.method && init.method !== 'GET')) return response;
    const failure = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (failure?.code !== 'REVIEW_READ_CHANGED') return response;
    await response.arrayBuffer();
  }
}
