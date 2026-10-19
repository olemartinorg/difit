import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { DiffResponse } from '../../types/diff';
import { DEFAULT_REVIEW_SETTINGS } from '../../utils/reviewExport';
import { generateDiffHash } from '../utils/diffUtils';

import { useReviewExport } from './useReviewExport';

vi.mock('../utils/diffUtils', () => ({ generateDiffHash: vi.fn() }));

afterEach(() => {
  delete window.difitHost;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('captures host context at export entry before hashing and keeps it after navigation', async () => {
  let selected = 'conversation-a';
  let finishHash: ((value: string) => void) | undefined;
  vi.mocked(generateDiffHash).mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finishHash = resolve;
      }),
  );
  const capture = vi.fn(() => Promise.resolve({ destination: selected }));
  window.difitHost = { captureReviewHandoffContext: capture };
  const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
  vi.stubGlobal('fetch', request);
  const selection = {
    baseCommitish: 'HEAD',
    targetCommitish: 'working',
    baseMode: 'direct' as const,
  };
  const { result } = renderHook(() =>
    useReviewExport({
      diff: { files: [], commit: 'head', agentHandoff: true } as unknown as DiffResponse,
      selection,
      resolvedSelection: selection,
      threads: [],
      settings: DEFAULT_REVIEW_SETTINGS,
      ready: true,
      commentsUrl: '/comments',
      commentVersion: 0,
      generatePrompt: () => 'Review Ω\nsecond line',
      resetViewed: async () => {},
      clearComments: () => {},
    }),
  );
  let exported: Promise<void> | undefined;
  act(() => {
    exported = result.current.exportReview();
  });
  expect(capture).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  selected = 'conversation-b';
  await act(async () => {
    await Promise.resolve();
    finishHash?.('hash');
    await exported;
  });
  const snapshot = JSON.parse(request.mock.calls[0]?.[1]?.body as string) as {
    hostContext: unknown;
  };
  expect(snapshot.hostContext).toEqual({ destination: 'conversation-a' });
});
