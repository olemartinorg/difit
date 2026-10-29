import { act, renderHook } from '@testing-library/react';
import type { DiffResponse } from '../../types/diff';
import { describe, it, expect, afterEach } from 'vitest';

import { getFileElementId } from '../utils/domUtils';

import { useLazyDiffRendering } from './useLazyDiffRendering';

function renderLazyDiffRendering(container: HTMLElement | null) {
  return renderHook(() =>
    useLazyDiffRendering({
      diffData: null,
      diffScrollContainerRef: { current: container },
      setDiffData: () => {},
    }),
  );
}

function stubRect(element: HTMLElement, top: number) {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 100,
      left: 0,
      right: 0,
      width: 0,
      height: 100,
    }) as DOMRect;
}

describe('useLazyDiffRendering', () => {
  it('keeps an already rendered deep file across default-selection OID advancement but resets on a new intent', () => {
    const diff: DiffResponse = {
      repositoryId: 'repo',
      reviewId: 'review',
      commit: 'h1',
      baseCommitish: 'base',
      targetCommitish: 'h1',
      requestedBaseCommitish: 'base',
      requestedTargetCommitish: 'h1',
      ignoreWhitespace: false,
      isEmpty: false,
      files: Array.from({ length: 12 }, (_, index) => ({
        path: `file-${index}`,
        status: 'modified' as const,
        chunks: [],
        additions: 0,
        deletions: 0,
      })),
    };
    const { result, rerender } = renderHook(
      ({ data, intent }) =>
        useLazyDiffRendering({
          diffData: data,
          intentKey: intent,
          diffScrollContainerRef: { current: null },
          setDiffData: () => {},
        }),
      { initialProps: { data: diff, intent: 'same-review' } },
    );
    act(() => result.current.ensureFileRendered('file-11'));
    rerender({
      data: { ...diff, commit: 'h2', targetCommitish: 'h2', requestedTargetCommitish: 'h2' },
      intent: 'same-review',
    });
    expect(result.current.renderedFilePaths.has('file-11')).toBe(true);
    rerender({ data: diff, intent: 'explicit-other-range' });
    expect(result.current.renderedFilePaths.has('file-11')).toBe(false);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('isFileScrolledPastContainerTop', () => {
    const filePath = 'src/example.ts';

    function setup(containerTop: number, targetTop: number) {
      const container = document.createElement('div');
      stubRect(container, containerTop);
      const target = document.createElement('div');
      target.id = getFileElementId(filePath);
      stubRect(target, targetTop);
      document.body.appendChild(target);

      return renderLazyDiffRendering(container);
    }

    it('returns true when the file header is scrolled above the container top', () => {
      const { result } = setup(50, 20);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(true);
    });

    it('returns false when the file header is visible below the container top', () => {
      const { result } = setup(50, 120);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the file header is aligned with the container top', () => {
      const { result } = setup(50, 50);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the scroll container is not available', () => {
      const target = document.createElement('div');
      target.id = getFileElementId(filePath);
      stubRect(target, 0);
      document.body.appendChild(target);

      const { result } = renderLazyDiffRendering(null);
      expect(result.current.isFileScrolledPastContainerTop(filePath)).toBe(false);
    });

    it('returns false when the file element does not exist', () => {
      const container = document.createElement('div');
      stubRect(container, 0);

      const { result } = renderLazyDiffRendering(container);
      expect(result.current.isFileScrolledPastContainerTop('missing/file.ts')).toBe(false);
    });
  });
});
