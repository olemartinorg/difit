import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewInventory } from '../../types/review';
import { useReviewInventory } from './useReviewInventory';

const base = 'a'.repeat(40),
  parent = 'b'.repeat(40),
  head = 'c'.repeat(40);
function inventory(target = 'trunk'): ReviewInventory {
  const commits = [
    {
      hash: head,
      parent,
      shortHash: head.slice(0, 7),
      message: 'second',
      timestamp: '2026-10-22T12:00:00Z',
      pushed: true,
      isMerge: false,
    },
    {
      hash: parent,
      parent: base,
      shortHash: parent.slice(0, 7),
      message: 'first',
      timestamp: '2026-10-22T11:00:00Z',
      pushed: true,
      isMerge: false,
    },
  ];
  return {
    repositoryId: 'fixture',
    branch: 'feature',
    reviewedBranch: 'feature',
    head,
    target,
    targetHash: target === 'trunk' ? base : parent,
    branchBase: target === 'trunk' ? base : parent,
    targetOptions: [
      { name: 'trunk', kind: 'local' },
      { name: 'stacked-parent', kind: 'local' },
    ],
    commits: target === 'trunk' ? commits : commits.slice(0, 1),
    stagedOnly: false,
    defaultSelection: { baseCommitish: target === 'trunk' ? base : parent, targetCommitish: head },
    reviewByDefault: true,
  };
}

describe('review inventory selection', () => {
  it('pins the resolved target and base for background reads and repins only an explicit target choice', async () => {
    const first = inventory(),
      next = inventory('stacked-parent');
    const fetcher = vi.mocked(fetch);
    fetcher.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT')
        return Response.json({ ok: true, targetHash: parent, branchBase: parent });
      const url = new URL(String(input), 'http://localhost');
      return Response.json(url.searchParams.get('target') === 'stacked-parent' ? next : first);
    });
    const { result } = renderHook(() => useReviewInventory(vi.fn(), true, false, false));
    await waitFor(() => expect(result.current.inventory).not.toBeNull());
    await act(async () => {
      await result.current.refresh();
    });
    let request = new URL(String(fetcher.mock.lastCall?.[0]), 'http://localhost');
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      target: 'trunk',
      targetHead: base,
      comparisonBase: base,
    });
    expect(new URLSearchParams(location.hash.slice(1)).get('reviewTargetHead')).toBe(base);
    await act(async () => {
      await result.current.changeTarget('stacked-parent');
    });
    request = new URL(String(fetcher.mock.lastCall?.[0]), 'http://localhost');
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      target: 'stacked-parent',
      targetHead: parent,
      comparisonBase: parent,
    });
  });
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('honors default intent on each document even when the reused process started in advanced mode', async () => {
    const data = { ...inventory(), reviewByDefault: false };
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(data)));
    window.history.replaceState(null, '', '/?reviewIntent=default');
    const changed = vi.fn();
    const first = renderHook(() => useReviewInventory(changed, true, false, false));
    await waitFor(() => expect(first.result.current.active).toBe(true));
    expect(first.result.current.range).toEqual({ oldest: parent, newest: head });
    act(() => first.result.current.useAdvanced());
    await act(async () => {
      await first.result.current.refresh();
    });
    expect(first.result.current.active).toBe(false);
    first.unmount();
    window.history.replaceState(null, '', '/?reviewIntent=default&reviewBranch=other');
    const second = renderHook(() => useReviewInventory(changed, true, false, false));
    await waitFor(() => expect(second.result.current.active).toBe(true));
    expect(second.result.current.range).toEqual({ oldest: parent, newest: head });
  });

  it('preserves an explicit empty range instead of replacing it with launch defaults', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...inventory(), reviewByDefault: false }));
    window.history.replaceState(null, '', '/?reviewIntent=default#review=empty');
    const { result } = renderHook(() => useReviewInventory(vi.fn(), true, false, false));
    await waitFor(() => expect(result.current.inventory).not.toBeNull());
    expect(result.current.active).toBe(true);
    expect(result.current.range).toBeNull();
  });

  it('retains a fully published scoped comparison and changes the resolved base when target changes', async () => {
    const initial = inventory(),
      corrected = inventory('stacked-parent');
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/review/target') return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(
        Response.json(url.includes('target=stacked-parent') ? corrected : initial),
      );
    });
    const changed = vi.fn();
    const { result } = renderHook(() => useReviewInventory(changed, true, false, false));
    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith(
        { baseCommitish: base, targetCommitish: head },
        initial,
        true,
      ),
    );
    expect(result.current.range).toEqual({ oldest: parent, newest: head });
    changed.mockClear();
    await act(async () => {
      await result.current.changeTarget('stacked-parent');
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/review/target',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ target: 'stacked-parent' }),
      }),
    );
    expect(fetch).toHaveBeenCalledWith('/api/review?ignoreWhitespace=false&target=stacked-parent');
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      { baseCommitish: parent, targetCommitish: head },
      corrected,
      true,
    );
    expect(result.current.range).toEqual({ oldest: head, newest: head });
  });

  it('keeps current working review limited to unpublished work and current edits', async () => {
    const data = {
      ...inventory(),
      reviewedBranch: undefined,
      uncommitted: { additions: 1, deletions: 0, files: 1, binaryFiles: 0 },
      defaultSelection: { baseCommitish: head, targetCommitish: '.', includeUntracked: true },
    };
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(data)));
    const changed = vi.fn();
    const { result } = renderHook(() => useReviewInventory(changed, true, false, false));
    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith(
        { baseCommitish: head, targetCommitish: '.', includeUntracked: true },
        data,
        true,
      ),
    );
    expect(result.current.range).toEqual({ oldest: 'worktree', newest: 'worktree' });
  });

  it('updates the automatic PR range as local work appears and is published', async () => {
    const published = inventory();
    const local = {
      ...published,
      checkout: true,
      commits: published.commits.map((commit) => ({
        ...commit,
        pushed: commit.hash !== head,
      })),
      uncommitted: { additions: 1, deletions: 0, files: 1, binaryFiles: 0 },
    };
    let data = published;
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(data)));
    const changed = vi.fn();
    const { result } = renderHook(() => useReviewInventory(changed, true, false, false));
    await waitFor(() => expect(result.current.range).toEqual({ oldest: parent, newest: head }));
    data = local;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.range).toEqual({ oldest: head, newest: 'worktree' });
    expect(changed).toHaveBeenLastCalledWith(
      { baseCommitish: parent, targetCommitish: '.', includeUntracked: true },
      local,
      true,
    );
    data = published;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.range).toEqual({ oldest: parent, newest: head });
    expect(changed).toHaveBeenLastCalledWith(
      { baseCommitish: base, targetCommitish: head },
      published,
      true,
    );
  });

  it.each(['pushed', 'empty'])(
    'preserves an explicit %s range through refresh and reopening',
    async (selection) => {
      const data = {
        ...inventory(),
        checkout: true,
        uncommitted: { additions: 1, deletions: 0, files: 1, binaryFiles: 0 },
      };
      vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(data)));
      const changed = vi.fn();
      const first = renderHook(() => useReviewInventory(changed, true, false, false));
      await waitFor(() => expect(first.result.current.range?.oldest).toBe('worktree'));
      act(() =>
        first.result.current.select(
          selection === 'pushed' ? [parent, head] : ['worktree'],
          selection === 'pushed',
        ),
      );
      const expectedRange = selection === 'pushed' ? { oldest: parent, newest: head } : null;
      expect(first.result.current.range).toEqual(expectedRange);
      await act(async () => {
        await first.result.current.refresh();
      });
      expect(first.result.current.range).toEqual(expectedRange);
      first.unmount();
      const second = renderHook(() => useReviewInventory(changed, true, false, false));
      await waitFor(() => expect(second.result.current.inventory).not.toBeNull());
      expect(second.result.current.range).toEqual(expectedRange);
      expect(changed).toHaveBeenLastCalledWith(
        selection === 'pushed' ? { baseCommitish: base, targetCommitish: head } : null,
        data,
        true,
      );
    },
  );
});
