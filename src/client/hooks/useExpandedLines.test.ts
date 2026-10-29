import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFile } from '../../types/diff';

import { useExpandedLines } from './useExpandedLines';

function createMockDiffFile(): DiffFile {
  return {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [
      {
        header: '@@ -2 +2 @@',
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: [
          {
            type: 'delete',
            content: 'old changed line',
            oldLineNumber: 2,
          },
          {
            type: 'add',
            content: 'new changed line',
            newLineNumber: 2,
          },
        ],
      },
    ],
  };
}

describe('useExpandedLines', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      const ref = url.searchParams.get('ref');

      const contentByRef: Record<string, string> = {
        'base-a': 'base a line 1\nold changed line\n',
        'base-b': 'base b line 1\nold changed line\n',
        target: 'target line 1\nnew changed line\n',
      };
      const body = ref ? contentByRef[ref] : undefined;

      if (!body) {
        return Promise.resolve({
          ok: false,
          statusText: `missing fixture for ${rawUrl}`,
          text: async () => '',
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        text: async () => body,
      } as Response);
    });
  });

  it('clears expanded state and refetches content when the revision changes', async () => {
    const file = createMockDiffFile();
    const { result, rerender } = renderHook(
      ({ baseCommitish, targetCommitish, diffIdentity }) =>
        useExpandedLines({
          baseCommitish,
          targetCommitish,
          diffIdentity,
        }),
      {
        initialProps: {
          baseCommitish: 'base-a',
          targetCommitish: 'target',
          diffIdentity: 'diff-a',
        },
      },
    );

    await act(async () => {
      await result.current.expandLines(file, 0, 'up', 1);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base a line 1');

    rerender({
      baseCommitish: 'base-b',
      targetCommitish: 'target',
      diffIdentity: 'diff-b',
    });

    await waitFor(() => {
      expect(result.current.expandedState).toEqual({});
    });

    await act(async () => {
      await result.current.expandLines(file, 0, 'up', 1);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base b line 1');
  });

  it('clears expanded state and refetches content when the diff identity changes', async () => {
    const file = createMockDiffFile();
    let baseAContent = 'base a line 1\nold changed line\n';

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      const ref = url.searchParams.get('ref');

      const contentByRef: Record<string, string> = {
        'base-a': baseAContent,
        target: 'target line 1\nnew changed line\n',
      };
      const body = ref ? contentByRef[ref] : undefined;

      if (!body) {
        return Promise.resolve({
          ok: false,
          statusText: `missing fixture for ${rawUrl}`,
          text: async () => '',
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        text: async () => body,
      } as Response);
    });

    const { result, rerender } = renderHook(
      ({ diffIdentity }) =>
        useExpandedLines({
          baseCommitish: 'base-a',
          targetCommitish: 'target',
          diffIdentity,
        }),
      {
        initialProps: {
          diffIdentity: 'diff-a',
        },
      },
    );

    await act(async () => {
      await result.current.expandLines(file, 0, 'up', 1);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base a line 1');

    baseAContent = 'base a rewritten line 1\nold changed line\n';

    rerender({
      diffIdentity: 'diff-b',
    });

    await waitFor(() => {
      expect(result.current.expandedState).toEqual({});
    });

    await act(async () => {
      await result.current.expandLines(file, 0, 'up', 1);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe(
      'base a rewritten line 1',
    );
  });

  it('does not request unavailable blob data for stdin diffs', async () => {
    const file = createMockDiffFile();
    const { result } = renderHook(() =>
      useExpandedLines({
        baseCommitish: 'stdin',
        targetCommitish: 'stdin',
        diffIdentity: 'stdin-diff',
      }),
    );

    await act(async () => {
      await result.current.prefetchFileContent(file);
      await result.current.expandLines(file, 0, 'up', 1);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.expandedState).toEqual({});
  });

  it('retains untouched-file expansion and remaps refreshed context when a preceding hunk is inserted in the same review', async () => {
    const original = createMockDiffFile();
    const incoming: DiffFile = {
      ...original,
      chunks: [
        {
          header: '@@ -0,0 +1 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [{ type: 'add', content: 'inserted earlier', newLineNumber: 1 }],
        },
        {
          ...original.chunks[0]!,
          newStart: 3,
          lines: original.chunks[0]!.lines.map((line) => ({
            ...line,
            ...(line.newLineNumber ? { newLineNumber: line.newLineNumber + 1 } : {}),
          })),
        },
      ],
    };
    vi.mocked(fetch).mockImplementation(async (input) => {
      const ref = new URL(String(input), 'http://localhost').searchParams.get('ref');
      return new Response(
        ref === 'base'
          ? 'base context\nold changed line\n'
          : ref === 'head-2'
            ? 'inserted earlier\nfresh context\nnew changed line\n'
            : 'target context\nnew changed line\n',
      );
    });
    const originalFiles = [original];
    const { result, rerender } = renderHook(
      ({ files, head }) =>
        useExpandedLines({
          baseCommitish: 'base',
          targetCommitish: head,
          files,
          intentKey: 'same-live-review',
          diffIdentity: head,
        }),
      { initialProps: { files: originalFiles, head: 'head-1' } },
    );
    await act(async () => {
      await result.current.expandLines(original, 0, 'up', 1);
    });
    expect(result.current.expandedState[original.path]?.expandedRanges).toEqual([
      { chunkIndex: 0, direction: 'up', count: 1 },
    ]);
    rerender({ files: originalFiles, head: 'unrelated-file-commit' });
    expect(result.current.expandedState[original.path]?.expandedRanges).toHaveLength(1);
    rerender({ files: [incoming], head: 'head-2' });
    await waitFor(() =>
      expect(result.current.expandedState[original.path]?.newContent?.[1]).toBe('fresh context'),
    );
    expect(result.current.expandedState[original.path]?.expandedRanges).toEqual([
      { chunkIndex: 1, direction: 'up', count: 1 },
    ]);
    expect(
      result.current
        .getMergedChunks(incoming)
        .flatMap((chunk) => chunk.lines)
        .some((line) => line.content === 'base context'),
    ).toBe(true);
  });
  it('keeps context on the corresponding directional boundary when an amended hunk splits', async () => {
    const content = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    vi.mocked(fetch).mockImplementation(async () => new Response(content));
    const chunk = (start: number, end: number) => ({
      header: `@@ -${start},${end - start + 1} +${start},${end - start + 1} @@`,
      oldStart: start,
      oldLines: end - start + 1,
      newStart: start,
      newLines: end - start + 1,
      lines: Array.from({ length: end - start + 1 }, (_, index) => ({
        type: 'normal' as const,
        content: `line ${start + index}`,
        oldLineNumber: start + index,
        newLineNumber: start + index,
      })),
    });
    const original: DiffFile = {
      path: 'split.txt',
      status: 'modified',
      additions: 1,
      deletions: 1,
      chunks: [chunk(10, 40)],
    };
    const split = { ...original, chunks: [chunk(10, 16), chunk(34, 40)] };
    const { result, rerender } = renderHook(
      ({ files, head }) =>
        useExpandedLines({
          files,
          baseCommitish: 'base',
          targetCommitish: head,
          intentKey: 'same-review',
          diffIdentity: head,
        }),
      { initialProps: { files: [original], head: 'h1' } },
    );
    await act(async () => {
      await result.current.expandLines(original, 0, 'down', 20);
      await result.current.expandLines(original, 0, 'up', 5);
    });
    expect(
      result.current
        .getMergedChunks(original)
        .flatMap((entry) => entry.lines)
        .some((line) => line.content === 'line 60'),
    ).toBe(true);
    rerender({ files: [split], head: 'h2' });
    await waitFor(() =>
      expect(result.current.expandedState[original.path]?.newContent).toBeDefined(),
    );
    expect(result.current.expandedState[original.path]?.expandedRanges).toEqual([
      { chunkIndex: 1, direction: 'down', count: 20 },
      { chunkIndex: 0, direction: 'up', count: 5 },
    ]);
    const visible = result.current
      .getMergedChunks(split)
      .flatMap((entry) => entry.lines)
      .map((line) => line.content);
    expect(visible).toContain('line 60');
    expect(visible).toContain('line 5');
  });
});
