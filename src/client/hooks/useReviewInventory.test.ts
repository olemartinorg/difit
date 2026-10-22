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
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    vi.mocked(fetch).mockResolvedValue(Response.json(data));
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
});
