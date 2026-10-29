import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom';

import { mockFetch as mockDefaultFetch } from '../../vitest.setup';
import type { DiffCommentThread, DiffResponse } from '../types/diff';
import type { ReviewInventory } from '../types/review';
import type { ClientWatchState } from '../types/watch';
import { DiffMode } from '../types/watch';

import App from './App';
import { useDiffComments } from './hooks/useDiffComments';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';

// Mock the useViewport hook
vi.mock('./hooks/useViewport', () => ({
  useViewport: vi.fn(() => ({ isMobile: false, isDesktop: true })),
}));

// Mock the useDiffComments hook
vi.mock('./hooks/useDiffComments', () => ({
  useDiffComments: vi.fn(() => ({
    hasLoadedComments: true,
    comments: [],
    threads: mockComments,
    replaceThreads: mockReplaceThreads,
    addComment: vi.fn(),
    addThread: vi.fn(),
    removeComment: vi.fn(),
    removeThread: vi.fn(),
    removeMessage: vi.fn(),
    replyToThread: vi.fn(),
    updateComment: vi.fn(),
    updateMessage: vi.fn(),
    clearAllComments: mockClearAllComments,
    applyCommentImports: mockApplyCommentImports,
    generatePrompt: vi.fn(),
    generateThreadPrompt: vi.fn(),
    generateAllCommentsPrompt: mockGenerateAllCommentsPrompt,
  })),
}));

// Mock the useViewedFiles hook
const mockClearViewedFiles = vi.fn();
const mockToggleFileViewed = vi.fn();
let mockViewedFiles = new Set<string>();
let mockHasLoadedInitialViewedFiles = true;
vi.mock('./hooks/useViewedFiles', () => ({
  useViewedFiles: vi.fn(() => ({
    viewedFiles: mockViewedFiles,
    changedSinceViewedFiles: new Set<string>(),
    hasLoadedInitialViewedFiles: mockHasLoadedInitialViewedFiles,
    toggleFileViewed: mockToggleFileViewed,
    isFileContentChanged: vi.fn(),
    getViewedFileRecord: vi.fn(),
    clearViewedFiles: mockClearViewedFiles,
  })),
}));

const mockWatchState: ClientWatchState = {
  isWatchEnabled: true,
  diffMode: DiffMode.DEFAULT,
  shouldReload: false,
  isReloading: false,
  lastChangeTime: null,
  lastChangeType: null,
  connectionStatus: 'connected',
};

let mockCommentsChanged: (() => Promise<void>) | undefined;
vi.mock('./hooks/useFileWatch', () => ({
  useFileWatch: vi.fn((onReload?: () => Promise<void>, onCommentsChanged?: () => Promise<void>) => {
    mockCommentsChanged = onCommentsChanged;
    return {
      shouldReload: mockWatchState.shouldReload,
      isConnected: true,
      error: null,
      reload: vi.fn(async () => {
        if (onReload) {
          await onReload();
        }
        mockWatchState.shouldReload = false;
        mockWatchState.lastChangeType = null;
      }),
      watchState: mockWatchState,
    };
  }),
}));

// Mock navigator.sendBeacon
Object.defineProperty(navigator, 'sendBeacon', {
  writable: true,
  value: vi.fn(),
});

// Mock window.confirm
const mockConfirm = vi.fn();
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: mockConfirm,
});

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  url: string;

  static clearInstances() {
    MockEventSource.instances = [];
  }
}
Object.defineProperty(window, 'EventSource', {
  writable: true,
  value: MockEventSource,
});

let mockComments: DiffCommentThread[] = [];
const mockReplaceThreads = vi.fn();
const mockClearAllComments = vi.fn();
const mockApplyCommentImports = vi.fn(() => []);
const mockGenerateAllCommentsPrompt = vi.fn(() => 'formatted prompt');

function createMockThread({
  id,
  filePath,
  line,
  body,
  author = 'User',
}: {
  id: string;
  filePath: string;
  line: number;
  body: string;
  author?: string;
}): DiffCommentThread {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: { side: 'new', line },
    messages: [
      {
        id,
        body,
        author,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

// Helper to render App with HotkeysProvider
const renderApp = () => {
  return render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  mockComments = [];
  vi.unstubAllEnvs();
  MockEventSource.clearInstances();
  mockViewedFiles = new Set<string>();
  mockHasLoadedInitialViewedFiles = true;
  mockReplaceThreads.mockReset();
  mockGenerateAllCommentsPrompt.mockClear();
});

const mockDiffResponse: DiffResponse = {
  reviewId: 'review-fixture',
  repositoryId: 'repository-fixture',
  commit: 'abc123',
  baseCommitish: 'HEAD^',
  targetCommitish: 'HEAD',
  requestedBaseCommitish: 'HEAD^',
  requestedTargetCommitish: 'HEAD',
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      chunks: [],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

function mockReviewResponse(url: string): Response | undefined {
  if (url.startsWith('/api/review-state'))
    return new Response(JSON.stringify({ version: 0, forms: {} }), { status: 200 });
  if (url === '/api/reviews/unassigned') return new Response(JSON.stringify({}), { status: 200 });
  return undefined;
}

describe('review inventory failure recovery', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it.each([true, false])(
    'shows the inventory failure and retries without the old picker (checkout: %s)',
    async (checkout) => {
      const head = 'c'.repeat(40);
      window.history.replaceState(null, '', '/?reviewIntent=default');
      mockFetch({
        ...mockDiffResponse,
        reviewAvailable: true,
        reviewSubject: {
          repository: 'fixture',
          branch: 'feature',
          head,
          ...(checkout ? { checkout: { branch: 'feature', head } } : {}),
        },
      });
      const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
      let failed = true;
      vi.mocked(fetch).mockImplementation((input, init) => {
        if (String(input).startsWith('/api/review?'))
          return Promise.resolve(
            failed
              ? Response.json({ error: 'Comparison history is unavailable' }, { status: 400 })
              : Response.json({
                  repositoryId: 'fixture',
                  branch: 'feature',
                  head,
                  branchBase: head,
                  commits: [],
                  targetOptions: [],
                  stagedOnly: false,
                  reviewByDefault: true,
                  uncommitted: { additions: 14, deletions: 0, files: 1, binaryFiles: 0 },
                }),
          );
        return defaultFetch(input, init);
      });
      renderApp();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Comparison history is unavailable',
      );
      expect(screen.queryByRole('button', { name: /^Revision menu:/ })).not.toBeInTheDocument();
      expect(document.querySelector('[data-file-path="test.ts"]')).toBeInTheDocument();
      const uncommitted = screen.queryByRole('button', { name: 'Uncommitted changes' });
      if (checkout) {
        expect(uncommitted).toBeInTheDocument();
        fireEvent.click(uncommitted!);
        await waitFor(() =>
          expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining(`base=${head}&target=.&includeUntracked=true`),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } else expect(uncommitted).not.toBeInTheDocument();
      failed = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry change selection' }));
      expect(
        await screen.findByRole('button', { name: 'Choose changes to review' }),
      ).toHaveTextContent('uncommitted changes');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Choose changes to review' }));
      expect(screen.getByRole('checkbox', { name: 'Select uncommitted changes' })).toBeChecked();
    },
  );
});

function mockFetch(response: DiffResponse): void {
  mockDefaultFetch(response);
  const defaultFetch = vi.mocked(global.fetch).getMockImplementation();
  if (!defaultFetch) throw new Error('Default fetch fixture was not installed');
  vi.mocked(global.fetch).mockImplementation((input, init) => {
    const url = String(input);
    const reviewResponse = mockReviewResponse(url);
    if (reviewResponse) return Promise.resolve(reviewResponse);
    if (url.startsWith('/api/comments-json'))
      return Promise.resolve(
        new Response(JSON.stringify({ version: 0, threads: mockComments }), { status: 200 }),
      );
    if (url.startsWith('/api/comments?'))
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, version: 1 }), { status: 200 }),
      );
    return defaultFetch(input, init);
  });
}

describe('App Component - Clear Comments Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockApplyCommentImports.mockReset();
    mockApplyCommentImports.mockReturnValue([]);
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  describe('Copy All Prompt Button', () => {
    it('should generate Copy All Prompt with requested and resolved diff context', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];
      mockFetch({
        ...mockDiffResponse,
        baseCommitish: 'abcdef1',
        targetCommitish: '1234567',
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        requestedBaseMode: 'merge-base',
      });

      renderApp();

      fireEvent.click(await screen.findByText(/Copy All Prompt/));

      await waitFor(() => {
        expect(mockGenerateAllCommentsPrompt).toHaveBeenCalledWith({
          requestedBaseCommitish: 'main',
          requestedTargetCommitish: 'feature/docs-update',
          baseMode: 'merge-base',
          resolvedBaseCommitish: 'abcdef1',
          resolvedTargetCommitish: '1234567',
        });
      });
    });
  });

  describe('Cleanup All Prompt Button', () => {
    it('should not show delete button when no comments exist', async () => {
      mockComments = [];

      renderApp();

      await waitFor(() => {
        // Cleanup All Prompt should not be visible without comments (dropdown doesn't exist)
        expect(screen.queryByText('Copy All Prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Cleanup All Prompt')).not.toBeInTheDocument();
      });
    });

    it('should show delete button when comments exist', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];

      renderApp();

      await waitFor(() => {
        // Find and click the dropdown toggle button (chevron)
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Cleanup All Prompt')).toBeInTheDocument();
      });
    });

    it('should call clearAllComments immediately when delete button is clicked', async () => {
      mockComments = [
        createMockThread({ id: '1', filePath: 'test.ts', line: 10, body: 'Comment 1' }),
        createMockThread({ id: '2', filePath: 'test.ts', line: 20, body: 'Comment 2' }),
      ];

      renderApp();

      await waitFor(() => {
        // First, open the dropdown
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        const deleteButton = screen.getByText('Cleanup All Prompt');
        fireEvent.click(deleteButton);
      });

      expect(mockClearAllComments).toHaveBeenCalled();
    });
  });

  describe('Clean flag on Startup', () => {
    it('should clear existing comments when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });
    });

    it('should clear viewed files when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearViewedFiles).toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is false', async () => {
      const responseWithoutClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: false,
      };

      mockFetch(responseWithoutClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is undefined', async () => {
      const responseWithoutFlag: DiffResponse = {
        ...mockDiffResponse,
        // clearComments is undefined
      };

      mockFetch(responseWithoutFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should log message when clearing comments via CLI flag', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(
          '✅ All existing comments and viewed files cleared as requested via --clean flag',
        );
      });

      consoleLogSpy.mockRestore();
    });

    it('hydrates comments from the server comment session on startup', async () => {
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);
        const reviewResponse = mockReviewResponse(url);
        if (reviewResponse) return Promise.resolve(reviewResponse);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
        '/api/comments-json?reviewId=review-fixture&base=HEAD%5E&target=HEAD',
      );
    });

    it('preserves server-provided comments after clearing local comments on startup', async () => {
      mockComments = [
        createMockThread({
          id: 'stale-local-thread',
          filePath: 'test.ts',
          line: 5,
          body: 'Stale local comment',
        }),
      ];
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);
        const reviewResponse = mockReviewResponse(url);
        if (reviewResponse) return Promise.resolve(reviewResponse);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => responseWithClearFlag,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(mockReplaceThreads).not.toHaveBeenCalledWith([...serverThreads, ...mockComments]);
    });
  });
});

describe('App Component - Heartbeat Connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('uses the direct API url for heartbeat when configured in development', async () => {
    vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');

    renderApp();

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe('http://localhost:4969/api/heartbeat');
    });
  });
});

describe('App Component - Initial file collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
    mockViewedFiles = new Set<string>();
    mockHasLoadedInitialViewedFiles = false;
  });

  it('collapses initially viewed files after viewed state finishes loading', async () => {
    const view = renderApp();

    await waitFor(() => {
      expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();
    });

    expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();

    act(() => {
      mockViewedFiles = new Set(['test.ts']);
      mockHasLoadedInitialViewedFiles = true;
      view.rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
    });
  });
});

describe('App Component - Comment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('writes only the deleted thread after the last comment is resolved', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
    ];
    const mockGlobalFetch = vi.mocked(global.fetch);
    const { rerender } = renderApp();
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalledWith(mockComments));
    expect(
      mockGlobalFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/comments?')),
    ).toHaveLength(0);

    mockComments = [];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(1);
      const [url, request] = commentCalls[0] as [string, RequestInit];
      expect(url).toBe('/api/comments?reviewId=review-fixture&base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({
        operations: [{ kind: 'thread', id: 'test-1', value: null }],
        writeId: expect.any(String),
        baseVersion: 0,
      });
    });
  });

  it('replays a remote change received while a local sync response is pending', async () => {
    const root = createMockThread({ id: 'root', filePath: 'test.ts', line: 10, body: 'Root' });
    const [rootMessage] = root.messages;
    if (!rootMessage) throw new Error('Root message fixture is missing');
    mockComments = [root];
    const { rerender } = renderApp();
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalled());
    await act(async () => {});
    mockReplaceThreads.mockClear();
    const originalFetch = vi.mocked(global.fetch).getMockImplementation();
    if (!originalFetch) throw new Error('Fetch fixture was not installed');
    let finish: ((value: Response) => void) | undefined;
    const remote = createMockThread({
      id: 'remote',
      filePath: 'test.ts',
      line: 20,
      body: 'Agent added this',
    });
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/comments-json'))
        return Promise.resolve(
          new Response(JSON.stringify({ version: 3, threads: [...mockComments, remote] }), {
            status: 200,
          }),
        );
      if (String(input).startsWith('/api/comments?') && init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return originalFetch(input, init);
    });
    mockComments = [
      {
        ...root,
        messages: [...root.messages, { ...rootMessage, id: 'local', body: 'Local reply' }],
      },
    ];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => {
      await mockCommentsChanged?.();
    });
    await act(async () => {
      finish?.(
        new Response(JSON.stringify({ version: 2, merged: false, threads: mockComments }), {
          status: 200,
        }),
      );
    });
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalledWith([...mockComments, remote]));
  });

  it('refreshes again without dropping a local reply when an earlier read finishes afterwards', async () => {
    const root = createMockThread({ id: 'root', filePath: 'test.ts', line: 10, body: 'Root' });
    const [rootMessage] = root.messages;
    if (!rootMessage) throw new Error('Root message fixture is missing');
    mockComments = [root];
    const { rerender } = renderApp();
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalled());
    mockReplaceThreads.mockClear();
    const originalFetch = vi.mocked(global.fetch).getMockImplementation();
    if (!originalFetch) throw new Error('Fetch fixture was not installed');
    let finish: ((value: Response) => void) | undefined;
    let reads = 0;
    const remote = createMockThread({
      id: 'remote',
      filePath: 'test.ts',
      line: 20,
      body: 'Agent added this',
    });
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/comments-json')) {
        reads++;
        if (reads === 1) {
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              version: 3,
              threads: [...mockComments, remote],
            }),
            { status: 200 },
          ),
        );
      }
      return originalFetch(input, init);
    });
    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = mockCommentsChanged?.();
    });
    mockComments = [
      {
        ...root,
        messages: [...root.messages, { ...rootMessage, id: 'reply', body: 'New reply' }],
      },
    ];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );
    await act(async () => {
      finish?.(new Response(JSON.stringify({ version: 1, threads: [root] }), { status: 200 }));
      await refreshing;
    });
    expect(mockReplaceThreads).not.toHaveBeenCalledWith([root]);
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalledWith([...mockComments, remote]));
  });

  it('never turns an unadopted delayed refresh into deletion of another client thread', async () => {
    const root = createMockThread({ id: 'root', filePath: 'test.ts', line: 10, body: 'Root' });
    const remote = createMockThread({
      id: 'remote',
      filePath: 'test.ts',
      line: 20,
      body: 'Other client',
    });
    mockComments = [root];
    const { rerender } = renderApp();
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalled());
    await act(async () => {});
    mockReplaceThreads.mockClear();
    const originalFetch = vi.mocked(global.fetch).getMockImplementation();
    if (!originalFetch) throw new Error('Fetch fixture was not installed');
    let finishRead: ((value: Response) => void) | undefined;
    let finishSave: ((value: Response) => void) | undefined;
    const writes: Array<{
      operations: Array<{ kind: string; id: string; value: unknown }>;
      baseVersion?: number;
    }> = [];
    let reads = 0;
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/comments-json')) {
        reads++;
        if (reads === 1)
          return new Promise<Response>((resolve) => {
            finishRead = resolve;
          });
        return Promise.resolve(
          new Response(JSON.stringify({ version: 5, threads: [...mockComments, remote] })),
        );
      }
      if (String(input).startsWith('/api/comments?') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        if (writes.length === 1)
          return new Promise<Response>((resolve) => {
            finishSave = resolve;
          });
        return Promise.resolve(
          new Response(
            JSON.stringify({ version: 4, merged: true, threads: [...mockComments, remote] }),
          ),
        );
      }
      return originalFetch(input, init);
    });
    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = mockCommentsChanged?.();
    });
    const edit = (body: string) => {
      mockComments = [
        { ...root, messages: root.messages.map((message) => ({ ...message, body })) },
      ];
      rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );
    };
    edit('First local edit');
    await waitFor(() => expect(finishSave).toBeTypeOf('function'));
    await act(async () => {
      finishRead?.(new Response(JSON.stringify({ version: 2, threads: [root, remote] })));
      await refreshing;
    });
    expect(mockReplaceThreads).not.toHaveBeenCalledWith([root, remote]);
    edit('Second local edit');
    await waitFor(() =>
      expect(
        Object.keys(localStorage).filter((key) => key.startsWith('difit-pending-comments/')),
      ).toHaveLength(2),
    );
    await act(async () => {
      finishSave?.(
        new Response(JSON.stringify({ version: 3, merged: true, threads: [root, remote] })),
      );
    });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.flatMap((write) => write.operations)).not.toContainEqual({
      kind: 'thread',
      id: 'remote',
      value: null,
    });
    expect(writes[1]?.operations).toEqual([
      expect.objectContaining({
        kind: 'message',
        id: 'root',
        value: expect.objectContaining({ body: 'Second local edit' }),
      }),
    ]);
    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalledWith([...mockComments, remote]));
  });

  it('recovers pending affected-field saves before loading current comments', async () => {
    mockComments = [];
    const pending = {
      operations: [{ kind: 'thread', id: 'resolved-thread', value: null }],
      writeId: 'pending-write',
    };
    const pendingKey = 'difit-pending-comments/review-fixture/pending-write';
    localStorage.setItem(pendingKey, JSON.stringify(pending));
    const mockGlobalFetch = vi.mocked(global.fetch);
    renderApp();

    await waitFor(() => expect(mockReplaceThreads).toHaveBeenCalledWith([]));
    const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/comments?'),
    );
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]).toEqual([
      '/api/comments?reviewId=review-fixture&base=HEAD%5E&target=HEAD',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(pending) }),
    ]);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    const writeIndex = mockGlobalFetch.mock.calls.findIndex(([url]) =>
      String(url).startsWith('/api/comments?'),
    );
    const readIndex = mockGlobalFetch.mock.calls.findIndex(([url]) =>
      String(url).startsWith('/api/comments-json?'),
    );
    expect(writeIndex).toBeLessThan(readIndex);
    fireEvent(window, new Event('beforeunload'));
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it('shows author badges in the comments modal when the diff has multiple authors', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'User comment' }),
      createMockThread({
        id: 'test-2',
        filePath: 'other.ts',
        line: 20,
        body: 'Reviewer comment',
        author: 'Reviewer',
      }),
    ];
    mockFetch({
      ...mockDiffResponse,
      files: [
        ...mockDiffResponse.files,
        {
          path: 'other.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          chunks: [],
        },
      ],
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('User')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });
});

describe('App Component - Diff Mode Persistence', () => {
  it('initializes the selected view mode from localStorage', async () => {
    mockFetch(mockDiffResponse);
    window.localStorage.setItem('difit.diffViewMode', 'unified');

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
  });

  it('persists the selected view mode to localStorage', async () => {
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    expect(window.localStorage.getItem('difit.diffViewMode')).toBe('unified');
  });

  it('keeps the selected view mode after triggering refresh', async () => {
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockClear();
    mockComments = [];
    mockClearAllComments.mockReset();
    mockConfirm.mockReturnValue(false);
    mockWatchState.shouldReload = true;
    mockWatchState.lastChangeType = 'file';
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });

    const refreshButton = await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      const diffCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/diff'),
      );
      expect(diffCalls).toHaveLength(2);
    });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
    mockWatchState.shouldReload = false;
    mockWatchState.lastChangeType = null;
  });
});

describe('App Component - Merge-base selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('clears the resolved base revision after switching to a merge-base quick diff', async () => {
    const initialDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '88aabb0',
      targetCommitish: '.',
      requestedBaseCommitish: 'HEAD',
      requestedTargetCommitish: '.',
    };
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
        {
          hash: '1122334fffff1111222233334444555566667777',
          shortHash: '1122334',
          message: 'merge base',
        },
      ],
      originDefaultBranch: 'origin/main',
    };

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      const reviewResponse = mockReviewResponse(url);
      if (reviewResponse) return Promise.resolve(reviewResponse);

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => revisionsResponse,
        } as Response);
      }

      if (url.includes('/api/diff')) {
        const response =
          url.includes('base=origin%2Fmain') && url.includes('baseMode=merge-base')
            ? mergeBaseDiffResponse
            : initialDiffResponse;

        return Promise.resolve({
          ok: true,
          json: async () => response,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'origin/main...Uncommitted (merge-base)' }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });

  it('uses stable review identity for comment storage and resolved revisions for viewed state', async () => {
    const response: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1234567',
      targetCommitish: '98664e1',
      requestedBaseCommitish: '98664e1^',
      requestedTargetCommitish: '98664e1',
    };

    mockFetch(response);

    renderApp();

    await waitFor(() => {
      expect(vi.mocked(useDiffComments)).toHaveBeenCalledWith(
        '1234567',
        '98664e1',
        'abc123',
        undefined,
        'repository-fixture/review-fixture',
        undefined,
      );
    });

    expect(vi.mocked(useViewedFiles)).toHaveBeenCalledWith(
      '1234567',
      '98664e1',
      'abc123',
      undefined,
      response.files,
      'repository-fixture/review-fixture',
      [],
      undefined,
    );
  });

  it('ignores stale resolvedBase from /api/revisions on initial merge-base load', async () => {
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
      ],
      originDefaultBranch: 'origin/main',
      resolvedBase: '88aabb0',
      resolvedTarget: '1122334',
    };

    let resolveRevisions: (() => void) | null = null;

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      const reviewResponse = mockReviewResponse(url);
      if (reviewResponse) return Promise.resolve(reviewResponse);

      if (url.includes('/api/revisions')) {
        return new Promise<Response>((resolve) => {
          resolveRevisions = () =>
            resolve({
              ok: true,
              json: async () => revisionsResponse,
            } as Response);
        });
      }

      if (url.includes('/api/diff')) {
        return Promise.resolve({
          ok: true,
          json: async () => mergeBaseDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Reviewing:')).toBeInTheDocument();
    });

    await act(async () => {
      resolveRevisions?.();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('App Component - Revision-aware refetching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('keeps the selected revisions when refetching without explicit revision params', async () => {
    const diffResponse: DiffResponse = {
      ...mockDiffResponse,
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
    };

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const reviewResponse = mockReviewResponse(url);
      if (reviewResponse) return Promise.resolve(reviewResponse);

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            specialOptions: [],
            branches: [],
            commits: [
              {
                hash: 'abc1234',
                shortHash: 'abc1234',
                message: 'Test commit',
              },
            ],
          }),
        } as Response);
      }

      if (url.startsWith('/api/comments?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => diffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Previous commit' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(2);
      expect(String(diffCalls[1]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[1]?.[0])).toContain('target=HEAD%5E');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore Whitespace' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(3);
      expect(String(diffCalls[2]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[2]?.[0])).toContain('target=HEAD%5E');
    });
  });
});

describe('App Component - Sidebar persistence', () => {
  it('preserves manual file collapse when a different file advances the same review', async () => {
    mockWatchState.shouldReload = true;
    mockWatchState.lastChangeType = 'file';
    mockFetch({ ...mockDiffResponse, commit: 'h1', targetCommitish: 'h1' });
    renderApp();
    fireEvent.click(await screen.findByTitle('Collapse file (Alt+Click to collapse all)'));
    expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
    mockFetch({
      ...mockDiffResponse,
      commit: 'h2',
      targetCommitish: 'h2',
      requestedTargetCommitish: 'h2',
      files: [
        ...mockDiffResponse.files,
        { path: 'another.ts', status: 'modified', additions: 1, deletions: 0, chunks: [] },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(document.querySelector('[data-file-path="another.ts"]')).toBeInTheDocument(),
    );
    expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch(mockDiffResponse);
  });

  it('restores file tree open state from localStorage', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'false');

    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists file tree open state when toggled', async () => {
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('false');
    });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('true');
    });
  });
});

describe('App Component - Mobile sidebar auto-close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('closes the sidebar when a file is selected on mobile', async () => {
    mockFetch(mockDiffResponse);
    renderApp();

    // Sidebar toggle button
    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    // Wait for file list to render, then click the file row
    const fileRow = await screen.findByTitle('test.ts');
    fireEvent.click(fileRow.closest('[data-file-row]')!);

    // Sidebar should now be closed on mobile
    await waitFor(() => {
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

describe('App Component - Comparison loading feedback', () => {
  const base = 'a'.repeat(40),
    parent = 'b'.repeat(40),
    head = 'c'.repeat(40);
  const inventory: ReviewInventory = {
    repositoryId: 'repository-fixture',
    branch: 'feature',
    head,
    branchBase: base,
    target: 'main',
    targetOptions: [
      { name: 'main', kind: 'local' },
      { name: 'other', kind: 'local' },
    ],
    commits: [
      {
        hash: head,
        parent,
        shortHash: head.slice(0, 7),
        message: 'newest',
        pushed: false,
        isMerge: false,
        timestamp: '2026-10-22T12:00:00Z',
      },
      {
        hash: parent,
        parent: base,
        shortHash: parent.slice(0, 7),
        message: 'oldest',
        pushed: false,
        isMerge: false,
        timestamp: '2026-10-22T11:00:00Z',
      },
    ],
    stagedOnly: false,
    defaultSelection: { baseCommitish: base, targetCommitish: head },
    reviewByDefault: true,
  };
  const initialDiff: DiffResponse = {
    ...mockDiffResponse,
    reviewAvailable: true,
    baseCommitish: base,
    targetCommitish: head,
    requestedBaseCommitish: base,
    requestedTargetCommitish: head,
  };
  const pending: {
    finish: (response: Response) => void;
    signal: AbortSignal | null | undefined;
  }[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    pending.length = 0;
    window.history.replaceState(null, '', '/');
    mockFetch(initialDiff);
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/review?'))
        return Promise.resolve(Response.json(inventory));
      return defaultFetch(input, init);
    });
    renderApp();
    const picker = await screen.findByRole('button', { name: 'Choose changes to review' });
    await waitFor(() => expect(picker).toHaveTextContent('2 commits'));
    await waitFor(() =>
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false'),
    );
    // Keep new requests pending even after abort so stale completions can be exercised.
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/diff?')) {
        return new Promise<Response>((finish) => pending.push({ finish, signal: init?.signal }));
      }
      if (String(input).startsWith('/api/review?'))
        return Promise.resolve(Response.json(inventory));
      return defaultFetch(input, init);
    });
    fireEvent.click(picker);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  function toggleNewest() {
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${head.slice(0, 7)} newest` }));
  }

  it('shows feedback immediately in the picker and toolbar until the response body loads', async () => {
    toggleNewest();
    const panel = screen.getByRole('dialog', { name: 'Changes to review' });
    expect(within(panel).getByRole('status')).toHaveTextContent('Updating diff…');
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelector('[data-file-path="test.ts"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose changes to review' }));
    expect(screen.getByRole('status')).toHaveTextContent('Updating diff…');
    let finishBody!: (data: DiffResponse) => void;
    const body = new Promise<DiffResponse>((resolve) => {
      finishBody = resolve;
    });
    await act(async () => {
      pending[0]!.finish({ ok: true, json: () => body } as Response);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Updating diff…');
    await act(async () => {
      finishBody({ ...initialDiff, targetCommitish: parent, requestedTargetCommitish: parent });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps feedback for the newest selection when an older request completes', async () => {
    toggleNewest();
    toggleNewest();
    expect(pending).toHaveLength(2);
    expect(pending[0]!.signal?.aborted).toBe(true);
    await act(async () => {
      pending[0]!.finish(Response.json({ ...initialDiff, files: [] }));
    });
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(document.querySelector('[data-file-path="test.ts"]')).toBeInTheDocument();
    await act(async () => {
      pending[1]!.finish(Response.json(initialDiff));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
  });

  it('clears feedback on a real failure and keeps the previous diff with an error', async () => {
    toggleNewest();
    await act(async () => {
      pending[0]!.finish(new Response(null, { status: 500 }));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch diff data');
    expect(document.querySelector('[data-file-path="test.ts"]')).toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
  });

  it.each([
    {
      status: 409,
      body: JSON.stringify({
        error: 'The checkout changed. Reopen Review to use the current checkout.',
      }),
      message: 'The checkout changed. Reopen Review to use the current checkout.',
    },
    {
      status: 500,
      body: JSON.stringify({
        error: 'Comparison history is unavailable. Fetch missing history and retry.',
      }),
      message: 'Comparison history is unavailable. Fetch missing history and retry.',
    },
    {
      status: 502,
      body: '<html>Bad gateway</html>',
      message: 'Failed to fetch diff data (HTTP 502)',
    },
    {
      status: 500,
      body: JSON.stringify({ error: { unexpected: true } }),
      message: 'Failed to fetch diff data (HTTP 500)',
    },
  ])(
    'preserves the existing diff and displays a useful HTTP $status failure',
    async ({ status, body, message }) => {
      toggleNewest();
      await act(async () => {
        pending[0]!.finish(new Response(body, { status }));
      });
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(document.querySelector('[data-file-path="test.ts"]')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
    },
  );

  it('shows feedback while a target branch is being saved before loading its diff', async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let finishSave!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === '/api/review/target')
        return new Promise<Response>((resolve) => {
          finishSave = resolve;
        });
      return defaultFetch(input, init);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Target branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'other' }));
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      finishSave(Response.json({ ok: true }));
    });
    expect(pending).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    await act(async () => {
      pending[0]!.finish(Response.json(initialDiff));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
  });
});
