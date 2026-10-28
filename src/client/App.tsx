import { commentURL, reviewFetch } from './services/reviewContext';
import { commentOperations } from './services/commentOperations';
import { ReviewDrafts } from './components/ReviewDrafts';
import { Columns, AlignLeft } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

import {
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type DiffViewMode,
  type DiffSide,
  type LineNumber,
  type CommentThread,
  type RevisionsResponse,
} from '../types/diff';
import { DEFAULT_DIFF_VIEW_MODE, normalizeDiffViewMode } from '../utils/diffMode';
import { getEmptyReviewSelection } from '../utils/reviewSelection';
import {
  createDiffSelection,
  diffSelectionsEqual,
  getDiffSelectionKey,
  normalizeBaseMode,
} from '../utils/diffSelection';

import { Checkbox } from './components/Checkbox';
import { CommentsDropdown } from './components/CommentsDropdown';
import { CommentsListModal } from './components/CommentsListModal';
import { DiffQuickMenu } from './components/DiffQuickMenu';
import { DiffLoadingStatus } from './components/DiffLoadingStatus';
import { ReviewPicker } from './components/ReviewPicker';
import { useReviewInventory } from './hooks/useReviewInventory';
import { useReviewSettings } from './hooks/useReviewSettings';
import { ReviewSettingsSection } from './components/ReviewSettingsSection';
import { getInitialMergedChunks, reconcileDiffResponse } from './utils/stableDiff';
import { useReviewReset } from './hooks/useReviewReset';
import { DiffViewer } from './components/DiffViewer';
import { FileList } from './components/FileList';
import { GitHubIcon } from './components/GitHubIcon';
import { HelpModal } from './components/HelpModal';
import { Logo } from './components/Logo';
import { ReviewScrollContainer } from './components/ReviewScrollContainer';
import { ReviewLayoutControls } from './components/ReviewLayoutControls';
import './styles/minimal-ui.css';
import { ReloadButton } from './components/ReloadButton';
import { RevisionDetailModal } from './components/RevisionDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { SparkleAnimation } from './components/SparkleAnimation';
import { WordHighlightProvider } from './contexts/WordHighlightContext';
import { useAppearanceSettings } from './hooks/useAppearanceSettings';
import { useDiffComments } from './hooks/useDiffComments';
import { useExpandedLines } from './hooks/useExpandedLines';
import { useFileWatch } from './hooks/useFileWatch';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { useLazyDiffRendering } from './hooks/useLazyDiffRendering';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';
import { fetchClientSettings, saveClientSettings } from './services/userSettings';
import { hasMultipleCommentAuthors } from './utils/commentAuthors';
import { useReviewExport } from './hooks/useReviewExport';
import { matchesAutoViewedPatterns } from './utils/autoViewedPatterns';
import { ResetViewedButton } from './components/ResetViewedButton';
import { getFileElementId } from './utils/domUtils';
import { findCommentPosition } from './utils/navigation/positionHelpers';
import { resolveEventSourceUrl } from './utils/eventSourceUrl';
import {
  EMPTY_MERGED_CHUNKS_STATE,
  buildMergedChunksState,
  getMergedChunksForVersion,
} from './utils/mergedChunks';
import { buildFileLineIndex, isThreadOutdated } from './utils/outdatedComments';

const EMPTY_COMMENT_THREADS: CommentThread[] = [];
const DIFF_VIEW_MODE_STORAGE_KEY = 'difit.diffViewMode';
const SIDEBAR_WIDTH_STORAGE_KEY = 'difit.sidebarWidth';
const SIDEBAR_OPEN_STORAGE_KEY = 'difit.sidebarOpen';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_DEFAULT_WIDTH = 280;

const parseDiffViewMode = (value: unknown): DiffViewMode | null => {
  switch (value) {
    case 'split':
    case 'side-by-side':
    case 'unified':
    case 'inline':
      return normalizeDiffViewMode(value);
    default:
      return null;
  }
};

const getStoredDiffViewMode = (): DiffViewMode | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return parseDiffViewMode(window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
};

const getInitialDiffViewMode = () => getStoredDiffViewMode() ?? DEFAULT_DIFF_VIEW_MODE;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

const getStoredSidebarWidth = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  const parsed = Number.parseInt(stored, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampSidebarWidth(parsed);
};

const getInitialSidebarWidth = () => getStoredSidebarWidth() ?? SIDEBAR_DEFAULT_WIDTH;

const getStoredSidebarOpen = (): boolean | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
  if (stored === 'true') {
    return true;
  }
  if (stored === 'false') {
    return false;
  }
  return null;
};

const getInitialFileTreeOpen = () => getStoredSidebarOpen() ?? true;

function App() {
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const diffDataRef = useRef(diffData);
  diffDataRef.current = diffData;
  const [diffDataVersion, setDiffDataVersion] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffViewMode>(getInitialDiffViewMode);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reviewReset = useReviewReset();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(getInitialFileTreeOpen);
  const [isDragging, setIsDragging] = useState(false);
  const [showSparkles, setShowSparkles] = useState(false);
  const [hasTriggeredSparkles, setHasTriggeredSparkles] = useState(false);
  const [isCommentsListOpen, setIsCommentsListOpen] = useState(false);
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const collapsedInitializedRef = useRef(false);
  const diffScrollContainerRef = useRef<HTMLElement | null>(null);

  // Revision selector state
  const [revisionOptions, setRevisionOptions] = useState<RevisionsResponse | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<DiffSelection>(
    createDiffSelection('', ''),
  );
  const [resolvedBaseRevision, setResolvedBaseRevision] = useState<string>('');
  const [resolvedTargetRevision, setResolvedTargetRevision] = useState<string>('');
  const hasUserSelectedRevisionRef = useRef(false);
  const currentRequestedBaseModeRef = useRef(selectedRevision.baseMode);
  currentRequestedBaseModeRef.current = diffData?.requestedBaseMode ?? selectedRevision.baseMode;
  const selectedRevisionRef = useRef(selectedRevision);
  selectedRevisionRef.current = selectedRevision;
  const diffRequestIdRef = useRef(0);
  const activeDiffAbortControllerRef = useRef<AbortController | null>(null);
  const resolvedSelection = useMemo<DiffSelection | null>(() => {
    if (!diffData?.baseCommitish || !diffData?.targetCommitish) {
      return null;
    }

    return createDiffSelection(
      diffData.baseCommitish,
      diffData.targetCommitish,
      diffData.requestedBaseMode,
    );
  }, [diffData]);
  const resolvedSelectionKey = useMemo(() => {
    if (!resolvedSelection) {
      return null;
    }

    return getDiffSelectionKey(resolvedSelection);
  }, [resolvedSelection]);

  const { settings, updateSettings } = useAppearanceSettings();
  const { settings: reviewSettings, updateSettings: updateReviewSettings } = useReviewSettings();
  const { isMobile, isDesktop } = useViewport();

  // New diff-aware comment system
  const {
    hasLoadedComments,
    threads,
    replaceThreads,
    addThread,
    replyToThread,
    removeThread,
    removeMessage,
    updateMessage,
    clearAllComments,
    generateThreadPrompt,
    generateAllCommentsPrompt,
  } = useDiffComments(
    resolvedSelection?.baseCommitish,
    resolvedSelection?.targetCommitish,
    diffData?.commit, // Using commit as currentCommitHash
    undefined, // branchToHash map - could be populated from server data
    diffData?.reviewId ? `${diffData.repositoryId}/${diffData.reviewId}` : undefined, // Review-scoped browser cache
    resolvedSelection?.baseMode,
  );

  const latestThreadsRef = useRef(threads);
  latestThreadsRef.current = threads;
  const pendingCommentSyncRef = useRef(0);
  const pendingCommentRefreshRef = useRef(false);

  const commentsContextKey = useMemo(() => {
    if (!resolvedSelectionKey) {
      return null;
    }

    return diffData?.reviewId ?? null;
  }, [diffData?.reviewId, resolvedSelectionKey]);
  const currentReviewRef = useRef({ key: resolvedSelectionKey, commit: diffData?.commit });
  currentReviewRef.current = { key: resolvedSelectionKey, commit: diffData?.commit };
  const getCommentApiUrl = useCallback(
    (path: string) => commentURL(path, diffData?.reviewId, resolvedSelection),
    [diffData?.reviewId, resolvedSelection],
  );
  const [bootstrappedCommentsKey, setBootstrappedCommentsKey] = useState<string | null>(null);
  const hasBootstrappedComments =
    commentsContextKey !== null && commentsContextKey === bootstrappedCommentsKey;
  const bootstrappingCommentsKeyRef = useRef<string | null>(null);
  const skipNextCommentSyncRef = useRef(false);
  // Last server comment version seen; echoed back as baseVersion so the server can detect concurrent writes.
  const serverCommentVersionRef = useRef<number | null>(null);
  const syncedThreadsRef = useRef<DiffCommentThread[]>([]);
  const saveQueueRef = useRef(Promise.resolve());
  const commentsContextRef = useRef(commentsContextKey);
  commentsContextRef.current = commentsContextKey;
  const [commentSaveError, setCommentSaveError] = useState<string | null>(null);
  const pendingBootstrapAfterLocalResetRef = useRef(false);

  useEffect(() => {
    serverCommentVersionRef.current = null;
    syncedThreadsRef.current = [];
    setCommentSaveError(null);
  }, [commentsContextKey]);

  useEffect(() => {
    if (commentsContextKey !== bootstrappedCommentsKey) {
      skipNextCommentSyncRef.current = false;
    }
  }, [bootstrappedCommentsKey, commentsContextKey]);

  const fetchServerThreads = useCallback(async () => {
    const response = await fetch(getCommentApiUrl('/api/comments-json'));
    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as {
      version?: number;
      threads?: DiffCommentThread[];
    };
    return {
      version: payload.version,
      threads: Array.isArray(payload.threads) ? payload.threads : [],
    };
  }, [getCommentApiUrl]);

  const adoptServerThreads = useCallback(
    (snapshot: { version?: number; threads: DiffCommentThread[] }) => {
      if (
        typeof snapshot.version === 'number' &&
        snapshot.version < (serverCommentVersionRef.current ?? 0)
      )
        return false;
      if (typeof snapshot.version === 'number') serverCommentVersionRef.current = snapshot.version;
      syncedThreadsRef.current = snapshot.threads;
      skipNextCommentSyncRef.current = true;
      replaceThreads(snapshot.threads);
      return true;
    },
    [replaceThreads],
  );

  const handleCommentsChanged = useCallback(
    async function refreshComments() {
      if (pendingCommentSyncRef.current > 0) {
        pendingCommentRefreshRef.current = true;
        return;
      }
      pendingCommentRefreshRef.current = false;
      const originalThreads = latestThreadsRef.current;
      const generation = reviewReset.generationRef.current;
      const capturedContext = commentsContextKey;
      try {
        const snapshot = await fetchServerThreads();
        if (commentsContextRef.current !== capturedContext) return;
        if (generation !== reviewReset.generationRef.current) return;
        // A local edit made while this read was pending has its own sync request.
        // Read again after it settles instead of adopting this older snapshot.
        if (latestThreadsRef.current !== originalThreads || pendingCommentSyncRef.current > 0) {
          pendingCommentRefreshRef.current = true;
          if (pendingCommentSyncRef.current === 0) void refreshComments();
          return;
        }
        if (!adoptServerThreads(snapshot)) return;
        if (commentsContextKey) {
          setBootstrappedCommentsKey(commentsContextKey);
        }
      } catch (commentsError) {
        console.error('Failed to refresh comments from server:', commentsError);
      }
    },
    [commentsContextKey, fetchServerThreads, adoptServerThreads, reviewReset.generationRef],
  );

  const syncThreadsToServer = useCallback(
    async (nextThreads: DiffCommentThread[]) => {
      const operations = commentOperations(syncedThreadsRef.current, nextThreads);
      syncedThreadsRef.current = nextThreads;
      if (!operations.length) return;
      const capturedContext = commentsContextKey;
      const writeId = crypto.randomUUID();
      const pendingKey = `difit-pending-comments/${capturedContext}/${writeId}`;
      localStorage.setItem(pendingKey, JSON.stringify({ operations, writeId }));
      pendingCommentSyncRef.current++;
      const previousSave = saveQueueRef.current;
      let finishSave!: () => void;
      saveQueueRef.current = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      await previousSave;
      try {
        const generation = reviewReset.generationRef.current;
        const pendingPrefix = `difit-pending-comments/${capturedContext}/`;
        const orderedWrites = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).filter((key): key is string => !!key?.startsWith(pendingPrefix));
        const ownIndex = orderedWrites.indexOf(pendingKey);
        const olderWrites = ownIndex >= 0 ? orderedWrites.slice(0, ownIndex) : [];
        for (const key of olderWrites) {
          const recovered = await fetch(getCommentApiUrl('/api/comments'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: localStorage.getItem(key),
          });
          if (!recovered.ok)
            throw new Error(
              'Earlier review saves are still pending. Your comments remain on this device.',
            );
          localStorage.removeItem(key);
        }
        const response = await fetch(getCommentApiUrl('/api/comments'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operations,
            writeId,
            baseVersion: serverCommentVersionRef.current ?? undefined,
          }),
        });
        if (!response.ok)
          throw new Error(
            'Review save failed. Your comments remain on this device. Retry by editing the comment.',
          );
        localStorage.removeItem(pendingKey);
        if (commentsContextRef.current !== capturedContext) return;
        setCommentSaveError(null);

        const result = (await response.json()) as {
          version?: number;
          merged?: boolean;
          threads?: DiffCommentThread[];
        };
        if (typeof result.version === 'number') {
          serverCommentVersionRef.current = Math.max(
            serverCommentVersionRef.current ?? 0,
            result.version,
          );
        }
        // Server merged in a concurrent change; adopt it so we don't push a stale set back.
        if (
          generation === reviewReset.generationRef.current &&
          result.merged &&
          latestThreadsRef.current === nextThreads &&
          Array.isArray(result.threads)
        ) {
          skipNextCommentSyncRef.current = true;
          syncedThreadsRef.current = result.threads;
          replaceThreads(result.threads);
        }
      } catch (cause) {
        if (commentsContextRef.current === capturedContext) setCommentSaveError(String(cause));
        throw cause;
      } finally {
        finishSave();
        pendingCommentSyncRef.current--;
        if (pendingCommentSyncRef.current === 0 && pendingCommentRefreshRef.current) {
          void handleCommentsChanged();
        }
      }
    },
    [
      commentsContextKey,
      getCommentApiUrl,
      handleCommentsChanged,
      replaceThreads,
      reviewReset.generationRef,
    ],
  );

  // Viewed files management
  const {
    viewedFiles,
    changedSinceViewedFiles,
    hasLoadedInitialViewedFiles,
    toggleFileViewed,
    setFilesViewed,
    clearViewedFiles,
  } = useViewedFiles(
    resolvedSelection?.baseCommitish,
    resolvedSelection?.targetCommitish,
    diffData?.commit,
    undefined,
    diffData?.files,
    diffData?.reviewId ? `${diffData.repositoryId}/${diffData.reviewId}` : undefined, // Review-scoped browser cache
    settings.autoViewedPatterns,
    resolvedSelection?.baseMode,
  );

  const resetViewedProgress = async () => {
    await clearViewedFiles(true);
    if (
      currentReviewRef.current.key !== resolvedSelectionKey ||
      currentReviewRef.current.commit !== diffData?.commit
    )
      return;
    setCollapsedFiles(
      new Set(
        (diffData?.files ?? [])
          .filter(
            (file) =>
              file.isGenerated ||
              file.status === 'deleted' ||
              matchesAutoViewedPatterns(file.path, settings.autoViewedPatterns),
          )
          .map((file) => file.path),
      ),
    );
  };

  const reviewExportOptions = {
    diff: diffData,
    selection: selectedRevision,
    resolvedSelection,
    threads,
    settings: reviewSettings,
    ready: hasBootstrappedComments,
    commentsUrl: getCommentApiUrl('/api/comments'),
    commentVersion: serverCommentVersionRef.current,
    generatePrompt: generateAllCommentsPrompt,
    resetViewed: resetViewedProgress,
    clearComments: (version: number) => {
      serverCommentVersionRef.current = version;
      reviewReset.invalidate();
      skipNextCommentSyncRef.current = true;
      clearAllComments();
    },
  };
  const reviewExport = useReviewExport(reviewExportOptions);
  const clipboardExport = useReviewExport({ ...reviewExportOptions, handoff: false });
  const [lastExportAction, setLastExportAction] = useState<'copy' | 'handoff'>('handoff');
  const exportError = lastExportAction === 'copy' ? clipboardExport.error : reviewExport.error;
  const isCopiedAll = diffData?.agentHandoff ? reviewExport.succeeded : clipboardExport.succeeded;
  const handleCopyAllComments = () => {
    setLastExportAction('copy');
    return clipboardExport.exportReview();
  };
  const handlePassToAgent = () => {
    setLastExportAction('handoff');
    return reviewExport.exportReview();
  };
  const showMobileCommentsBar =
    isMobile && (threads.length > 0 || diffData?.agentHandoff === true || exportError !== null);

  // Reset initialization flag when diff context changes
  useEffect(() => {
    collapsedInitializedRef.current = false;
  }, [diffData?.repositoryId, resolvedSelectionKey, diffData?.commit]);

  // Initialize collapsed files from viewed files (only once per diff)
  useEffect(() => {
    if (!collapsedInitializedRef.current && hasLoadedInitialViewedFiles) {
      setCollapsedFiles(new Set(viewedFiles));
      collapsedInitializedRef.current = true;
    }
  }, [viewedFiles, hasLoadedInitialViewedFiles]);
  const {
    renderedFilePaths,
    ensureFileRendered,
    ensureFilesRenderedUpTo,
    registerLazyFileContainer,
    scrollFileIntoDiffContainer,
    isFileScrolledPastContainerTop,
  } = useLazyDiffRendering({
    diffData,
    diffScrollContainerRef,
    setDiffData,
  });

  const toggleFileReviewed = useCallback(
    async (filePath: string) => {
      if (!diffData) return;

      const file = diffData.files.find((f) => f.path === filePath);
      if (!file) return;

      const wasViewed = viewedFiles.has(filePath);
      // Measure before the collapse re-renders: only re-anchor the header when
      // the user is scrolled past it (deep inside a long file), so the viewport
      // doesn't land in unrelated content after collapsing (#164). If the header
      // is already visible, stay stationary and let files below fill up (#402).
      const shouldScrollToHeader = !wasViewed && isFileScrolledPastContainerTop(filePath);
      await toggleFileViewed(filePath, file);

      // Update collapsed state based on viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        if (!wasViewed) {
          // Marking as viewed -> collapse the file
          newSet.add(filePath);
        } else {
          // Marking as not viewed -> expand the file
          newSet.delete(filePath);
        }
        return newSet;
      });

      if (shouldScrollToHeader) {
        setTimeout(() => {
          scrollFileIntoDiffContainer(filePath);
        }, 100);
      }
    },
    [
      diffData,
      isFileScrolledPastContainerTop,
      scrollFileIntoDiffContainer,
      toggleFileViewed,
      viewedFiles,
    ],
  );

  const toggleFolderReviewed = useCallback(
    async (folderPath: string, reviewed: boolean) => {
      if (!diffData) return;

      const folderFiles = diffData.files.filter((file) => file.path.startsWith(`${folderPath}/`));
      if (folderFiles.length === 0) return;

      await setFilesViewed(folderFiles, reviewed);

      // Keep the collapse state of every file in the folder in sync with its viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        folderFiles.forEach((file) => {
          if (reviewed) {
            newSet.add(file.path);
          } else {
            newSet.delete(file.path);
          }
        });
        return newSet;
      });
    },
    [diffData, setFilesViewed],
  );

  const toggleFileCollapsed = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  }, []);

  const toggleAllFilesCollapsed = useCallback(
    (shouldCollapse: boolean) => {
      if (!diffData) return;

      if (shouldCollapse) {
        // Collapse all files
        setCollapsedFiles(new Set(diffData.files.map((f) => f.path)));
      } else {
        // Expand all files
        setCollapsedFiles(new Set());
      }
    },
    [diffData],
  );

  const handleMobileFileSelected = useCallback(() => {
    setIsFileTreeOpen(false);
  }, []);

  const handleDiffModeChange = useCallback((mode: DiffViewMode) => {
    setDiffMode(mode);
    try {
      window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    saveClientSettings({ diffViewMode: mode });
  }, []);

  // Lift expand state to App level so navigation and rendering share the same merged chunks
  const {
    isLoading: isExpandLoading,
    expandLines,
    expandAllBetweenChunks,
    prefetchFileContent,
    getMergedChunks,
    lastUpdatedAt,
  } = useExpandedLines({
    baseCommitish: diffData?.baseCommitish,
    targetCommitish: diffData?.targetCommitish,
    diffIdentity: diffDataVersion,
    files: diffData?.files,
  });

  const getMergedChunksRef = useRef(getMergedChunks);
  useEffect(() => {
    getMergedChunksRef.current = getMergedChunks;
  }, [getMergedChunks]);

  const [mergedChunksState, setMergedChunksState] = useState(EMPTY_MERGED_CHUNKS_STATE);
  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffResponse['files'][number]>();
    diffData?.files.forEach((file) => {
      map.set(file.path, file);
    });
    return map;
  }, [diffData]);

  // Recompute merged chunks for the current fetched diff only.
  useEffect(() => {
    if (!diffData) {
      setMergedChunksState(EMPTY_MERGED_CHUNKS_STATE);
      return;
    }

    setMergedChunksState(
      buildMergedChunksState(diffDataVersion, renderedFilePaths, filesByPath, (file) =>
        getMergedChunksRef.current(file),
      ),
    );
  }, [diffData, diffDataVersion, filesByPath, renderedFilePaths, lastUpdatedAt]);

  // Create files with merged chunks for keyboard navigation
  const navigableFiles = useMemo(() => {
    if (!diffData) return [];
    return diffData.files.map((file) => ({
      ...file,
      chunks:
        getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path, file) ||
        file.chunks,
    }));
  }, [diffData, diffDataVersion, mergedChunksState]);

  const fileLineIndexByPath = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildFileLineIndex>>();
    navigableFiles.forEach((file) => {
      map.set(file.path, buildFileLineIndex(file));
    });
    return map;
  }, [navigableFiles]);

  const normalizedThreads = useMemo<CommentThread[]>(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        file: thread.filePath,
        line:
          typeof thread.position.line === 'number'
            ? thread.position.line
            : ([thread.position.line.start, thread.position.line.end] as [number, number]),
        side: thread.position.side,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        codeContent: thread.codeSnapshot?.content,
        isOutdated: isThreadOutdated(thread, fileLineIndexByPath.get(thread.filePath)),
        messages: thread.messages,
      })),
    [threads, fileLineIndexByPath],
  );
  const showAuthorBadges = useMemo(
    () => hasMultipleCommentAuthors(normalizedThreads.flatMap((thread) => thread.messages)),
    [normalizedThreads],
  );
  const threadsByFile = useMemo(() => {
    const map = new Map<string, CommentThread[]>();
    normalizedThreads.forEach((thread) => {
      const entry = map.get(thread.file);
      if (entry) {
        entry.push(thread);
      } else {
        map.set(thread.file, [thread]);
      }
    });
    return map;
  }, [normalizedThreads]);

  // State to trigger comment creation from keyboard
  const [commentTrigger, setCommentTrigger] = useState<{
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null>(null);
  const fetchDiffDataRef = useRef<((selection?: DiffSelection) => Promise<void>) | null>(null);
  const refreshReviewRef = useRef<(() => Promise<boolean | undefined>) | null>(null);
  const handleWatchReload = useCallback(async () => {
    const handled = await refreshReviewRef.current?.();
    if (!handled) await fetchDiffDataRef.current?.();
  }, []);

  // File watch for reload functionality - initialize with callback
  const {
    shouldReload,
    reload,
    watchState,
    error: watchError,
  } = useFileWatch(handleWatchReload, handleCommentsChanged);

  // Track which file the mouse is over so `v` works without a cursor
  const hoveredFileIndexRef = useRef<number | null>(null);
  const getHoveredFileIndex = useCallback(() => hoveredFileIndexRef.current, []);

  const { cursor, isHelpOpen, setIsHelpOpen, setCursorPosition, rememberFilePosition } =
    useKeyboardNavigation({
      files: navigableFiles,
      comments: normalizedThreads,
      viewMode: diffMode,
      reviewedFiles: viewedFiles,
      onToggleReviewed: toggleFileReviewed,
      getHoveredFileIndex,
      onCreateComment: () => {
        if (cursor) {
          setCommentTrigger({
            fileIndex: cursor.fileIndex,
            chunkIndex: cursor.chunkIndex,
            lineIndex: cursor.lineIndex,
          });
        }
      },
      onCopyAllComments: () => {
        if (threads.length > 0) {
          void handleCopyAllComments();
        }
      },
      onDeleteAllComments: () => {
        if (threads.length > 0 && confirm('Delete all comments?')) {
          clearAllComments();
        }
      },
      onShowCommentsList: () => {
        setIsCommentsListOpen(true);
      },
      onRefresh: () => {
        reload();
      },
    });

  // Viewed button in the diff header: silently remember the toggled file as
  // the navigation position, so keyboard navigation resumes from it without
  // showing any keyboard UI for a mouse interaction
  const handleViewedButtonToggle = useCallback(
    (filePath: string) => {
      void toggleFileReviewed(filePath);
      if (diffData) {
        const fileIndex = diffData.files.findIndex((f) => f.path === filePath);
        if (fileIndex !== -1) {
          rememberFilePosition(fileIndex);
        }
      }
    },
    [toggleFileReviewed, diffData, rememberFilePosition],
  );

  const deferredCursorScrollRef = useRef<typeof cursor>(null);
  useEffect(() => {
    if (!diffData || !cursor) return;

    const filePath = diffData.files[cursor.fileIndex]?.path;
    if (!filePath) return;

    if (!renderedFilePaths.has(filePath)) {
      deferredCursorScrollRef.current = cursor;
      ensureFilesRenderedUpTo(filePath);
      return;
    }

    // Scroll after the deferred rows have committed, when their geometry exists.
    const pendingCursor = deferredCursorScrollRef.current;
    deferredCursorScrollRef.current = null;
    if (pendingCursor === cursor) {
      setCursorPosition(cursor, 'start');
    }
  }, [cursor, diffData, ensureFilesRenderedUpTo, renderedFilePaths, setCursorPosition]);

  const handleLineClick = useCallback(
    (fileIndex: number, chunkIndex: number, lineIndex: number, side: 'left' | 'right') => {
      setCursorPosition({
        fileIndex,
        chunkIndex,
        lineIndex,
        side,
      });
    },
    [setCursorPosition],
  );

  const handleCommentTriggerHandled = useCallback(() => {
    setCommentTrigger(null);
  }, [setCommentTrigger]);

  const handleGenerateThreadPrompt = useCallback(
    (thread: CommentThread) => generateThreadPrompt(thread.id),
    [generateThreadPrompt],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)),
      );
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const fetchDiffData = useCallback(
    async (selection?: DiffSelection) => {
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      activeDiffAbortControllerRef.current?.abort();
      const controller = new AbortController();
      activeDiffAbortControllerRef.current = controller;
      try {
        const requestedSelection =
          selection ??
          (hasUserSelectedRevisionRef.current ? selectedRevisionRef.current : undefined);
        const params = new URLSearchParams({
          ignoreWhitespace: String(ignoreWhitespace),
        });
        if (requestedSelection?.baseCommitish) params.set('base', requestedSelection.baseCommitish);
        if (requestedSelection?.targetCommitish)
          params.set('target', requestedSelection.targetCommitish);
        if (requestedSelection?.includeUntracked) params.set('includeUntracked', 'true');
        if (requestedSelection?.baseMode === 'merge-base')
          params.set('baseMode', requestedSelection.baseMode);

        const response = await reviewFetch(`/api/diff?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Failed to fetch diff data');
        const data = (await response.json()) as DiffResponse;
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        const next = reconcileDiffResponse(diffDataRef.current, data);
        if (next !== diffDataRef.current) {
          diffDataRef.current = next;
          setDiffData(next);
          setDiffDataVersion((prev) => prev + 1);
        }
        setError(null);
        setRefreshError(null);

        // Update resolved revision state from server response
        setResolvedBaseRevision(
          data.baseCommitish && data.requestedBaseMode !== 'merge-base' ? data.baseCommitish : '',
        );
        if (data.targetCommitish) setResolvedTargetRevision(data.targetCommitish);

        if (!hasUserSelectedRevisionRef.current) {
          const requestedBase = data.requestedBaseCommitish ?? data.baseCommitish;
          const requestedTarget = data.requestedTargetCommitish ?? data.targetCommitish;
          if (requestedBase && requestedTarget) {
            setSelectedRevision({
              ...createDiffSelection(requestedBase, requestedTarget, data.requestedBaseMode),
              ...(data.requestedIncludeUntracked ? { includeUntracked: true } : {}),
            });
          }
        }

        // Lock files are now automatically marked as viewed by useViewedFiles hook
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') {
          return;
        }
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (diffDataRef.current) setRefreshError(message);
        else setError(message);
      } finally {
        if (activeDiffAbortControllerRef.current === controller) {
          activeDiffAbortControllerRef.current = null;
        }
        if (diffRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [ignoreWhitespace],
  );
  fetchDiffDataRef.current = fetchDiffData;

  useEffect(() => {
    void fetchDiffData();
  }, [fetchDiffData]);

  useEffect(() => {
    return () => {
      activeDiffAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isMobile && diffMode !== 'unified') {
      setDiffMode('unified');
    }
  }, [diffMode, isMobile]);

  // Hydrate UI settings from the server-persisted config so they survive
  // across ports (localStorage is origin-scoped and resets on a new port).
  // Settings the server doesn't know yet are seeded from localStorage.
  useEffect(() => {
    let cancelled = false;

    void fetchClientSettings().then((client) => {
      if (cancelled || !client) {
        return;
      }

      const seed: Record<string, unknown> = {};

      const remoteDiffViewMode = parseDiffViewMode(client.diffViewMode);
      if (remoteDiffViewMode) {
        setDiffMode(remoteDiffViewMode);
      } else {
        const localDiffViewMode = getStoredDiffViewMode();
        if (localDiffViewMode) {
          seed.diffViewMode = localDiffViewMode;
        }
      }

      if (typeof client.sidebarWidth === 'number' && Number.isFinite(client.sidebarWidth)) {
        setSidebarWidth(clampSidebarWidth(client.sidebarWidth));
      } else {
        const localSidebarWidth = getStoredSidebarWidth();
        if (localSidebarWidth !== null) {
          seed.sidebarWidth = localSidebarWidth;
        }
      }

      if (typeof client.sidebarOpen === 'boolean') {
        setIsFileTreeOpen(client.sidebarOpen);
      } else {
        const localSidebarOpen = getStoredSidebarOpen();
        if (localSidebarOpen !== null) {
          seed.sidebarOpen = localSidebarOpen;
        }
      }

      if (Object.keys(seed).length > 0) {
        saveClientSettings(seed);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const skipInitialSidebarWidthSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    // Skip the mount run so simply opening difit doesn't write the config file.
    if (skipInitialSidebarWidthSaveRef.current) {
      skipInitialSidebarWidthSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarWidth });
  }, [sidebarWidth]);

  const skipInitialSidebarOpenSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(isFileTreeOpen));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    if (skipInitialSidebarOpenSaveRef.current) {
      skipInitialSidebarOpenSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarOpen: isFileTreeOpen });
  }, [isFileTreeOpen]);

  // Fetch revision options on mount
  useEffect(() => {
    fetch('/api/revisions')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: RevisionsResponse | null) => {
        setRevisionOptions(data);
        if (
          data?.resolvedBase &&
          normalizeBaseMode(currentRequestedBaseModeRef.current) !== 'merge-base'
        ) {
          setResolvedBaseRevision((prev) => prev || data.resolvedBase || '');
        }
        if (data?.resolvedTarget) {
          setResolvedTargetRevision((prev) => prev || data.resolvedTarget || '');
        }
      })
      .catch(() => setRevisionOptions(null));
  }, []);

  // Handle revision change
  const handleRevisionChange = useCallback(
    async (nextSelection: DiffSelection, background = false) => {
      // Skip if no actual change
      if (diffSelectionsEqual(nextSelection, selectedRevisionRef.current)) return;

      hasUserSelectedRevisionRef.current = true;
      selectedRevisionRef.current = nextSelection;
      setSelectedRevision(nextSelection);
      if (!background) setLoading(true);
      setError(null);
      await fetchDiffData(nextSelection);
    },
    [fetchDiffData],
  );

  const review = useReviewInventory(
    async (selection, inventory, background) => {
      const next = selection ?? getEmptyReviewSelection(inventory.head);
      if (diffSelectionsEqual(next, selectedRevisionRef.current)) await fetchDiffData(next);
      else await handleRevisionChange(next, background);
    },
    diffData?.reviewAvailable === true,
    ignoreWhitespace,
    reviewSettings.autoRefresh,
  );
  refreshReviewRef.current = review.refresh;

  useEffect(() => {
    if (
      review.inventory &&
      reviewSettings.autoRefresh &&
      shouldReload &&
      !watchState.isReloading &&
      !watchError
    )
      reload();
  }, [
    review.inventory,
    reviewSettings.autoRefresh,
    shouldReload,
    watchState.isReloading,
    watchError,
    reload,
  ]);

  // Clear comments and viewed files on initial load if requested via CLI flag
  const hasCleanedRef = useRef(false);
  useEffect(() => {
    if (diffData?.clearComments && !hasCleanedRef.current) {
      hasCleanedRef.current = true;
      pendingBootstrapAfterLocalResetRef.current = true;
      clearAllComments({ resetAppliedCommentImportIds: true });
      void clearViewedFiles();
      console.log(
        '✅ All existing comments and viewed files cleared as requested via --clean flag',
      );
    }
  }, [diffData?.clearComments, clearAllComments, clearViewedFiles]);

  useEffect(() => {
    if (!commentsContextKey || !hasLoadedComments) {
      return;
    }

    if (bootstrappedCommentsKey === commentsContextKey) {
      return;
    }

    if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
      return;
    }

    const resetGeneration = reviewReset.generationRef.current;

    pendingBootstrapAfterLocalResetRef.current = false;

    bootstrappingCommentsKeyRef.current = commentsContextKey;
    let cancelled = false;

    const bootstrapComments = async () => {
      try {
        // Repository-wide legacy comments have no trustworthy branch attribution.
        // Import them intact into the explicit unassigned collection first.
        if (diffData?.repositoryId) {
          const { loadReviewComments } = await import('./services/reviewComments');
          const historical = loadReviewComments(diffData.repositoryId);
          if (historical.threads.length) {
            const imported = await reviewFetch('/api/reviews/unassigned', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ threads: historical.threads }),
            });
            if (!imported.ok)
              throw new Error('Historical comments could not be preserved on the host');
            const verified = (await imported.json()) as { count: number; messageCount: number };
            if (
              verified.count !== historical.threads.length ||
              verified.messageCount !==
                historical.threads.reduce((count, thread) => count + thread.messages.length, 0)
            )
              throw new Error('Historical comment verification failed');
          }
        }
        const pendingPrefix = `difit-pending-comments/${commentsContextKey}/`;
        const pendingKeys = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).filter((key): key is string => !!key?.startsWith(pendingPrefix));
        for (const key of pendingKeys) {
          const response = await fetch(getCommentApiUrl('/api/comments'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: localStorage.getItem(key),
          });
          if (!response.ok)
            throw new Error(
              'Pending comment saves could not be recovered. Your comments remain on this device.',
            );
          localStorage.removeItem(key);
        }
        const snapshot = await fetchServerThreads();
        if (
          cancelled ||
          commentsContextRef.current !== commentsContextKey ||
          resetGeneration !== reviewReset.generationRef.current
        ) {
          return;
        }

        if (!adoptServerThreads(snapshot)) return;
        setBootstrappedCommentsKey(commentsContextKey);
        setCommentSaveError(null);
      } catch (commentsError) {
        if (!cancelled) {
          console.error('Failed to bootstrap comments from server:', commentsError);
          setCommentSaveError(String(commentsError));
        }
      } finally {
        if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
          bootstrappingCommentsKeyRef.current = null;
        }
      }
    };

    void bootstrapComments();

    return () => {
      cancelled = true;
      if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
        bootstrappingCommentsKeyRef.current = null;
      }
    };
  }, [
    bootstrappedCommentsKey,
    commentsContextKey,
    fetchServerThreads,
    adoptServerThreads,
    hasLoadedComments,
    getCommentApiUrl,
    diffData?.repositoryId,
    replaceThreads,
    syncThreadsToServer,
    threads,
    reviewReset.generationRef,
  ]);

  // Trigger sparkle animation when all files are viewed
  useEffect(() => {
    if (diffData && diffData.files.length > 0) {
      // Reset the trigger flag when not all files are viewed
      if (viewedFiles.size < diffData.files.length) {
        setHasTriggeredSparkles(false);
      }
      // Show sparkles when all files are viewed and not already triggered
      else if (viewedFiles.size === diffData.files.length && !hasTriggeredSparkles) {
        setShowSparkles(true);
        setHasTriggeredSparkles(true);
        // Hide sparkles after animation completes
        setTimeout(() => {
          setShowSparkles(false);
        }, 1000);
      }
    }
  }, [viewedFiles.size, diffData, hasTriggeredSparkles]);

  // Send comments to server whenever they change and before page unload
  useEffect(() => {
    if (!hasBootstrappedComments) {
      return;
    }

    if (skipNextCommentSyncRef.current) {
      skipNextCommentSyncRef.current = false;
      return;
    }

    syncThreadsToServer(threads).catch((syncError) => {
      console.error('Failed to sync comments:', syncError);
    });
  }, [getCommentApiUrl, hasBootstrappedComments, syncThreadsToServer, threads]);

  // Establish SSE connection for tab close detection
  useEffect(() => {
    const eventSource = new EventSource(resolveEventSourceUrl('/api/heartbeat'));

    eventSource.onopen = () => {
      console.log('Connected to server heartbeat');
    };

    eventSource.onerror = () => {
      console.log('Server connection lost');
      eventSource.close();
    };

    // Cleanup on unmount
    return () => {
      eventSource.close();
    };
  }, []);

  const handleAddComment = useCallback(
    (
      file: string,
      line: LineNumber,
      body: string,
      codeContent?: string,
      side?: DiffSide,
    ): Promise<void> => {
      addThread({
        filePath: file,
        body,
        side: side || 'new',
        line: typeof line === 'number' ? line : { start: line[0], end: line[1] },
        codeSnapshot:
          codeContent !== undefined
            ? {
                content: codeContent,
                language: undefined,
              }
            : undefined,
      });
      return Promise.resolve();
    },
    [addThread],
  );

  const handleReplyToThread = useCallback(
    (threadId: string, body: string): Promise<void> => {
      replyToThread({ threadId, body });
      return Promise.resolve();
    },
    [replyToThread],
  );

  const handleNavigateToComment = (thread: CommentThread) => {
    if (!diffData) return;

    const position = findCommentPosition(thread, diffData.files);
    if (position) {
      setCursorPosition(position);
    }
  };

  const handleOpenInEditor = useCallback(
    async (filePath: string, lineNumber: number) => {
      try {
        const response = await fetch('/api/open-in-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePath,
            line: lineNumber,
            editor: settings.editor,
          }),
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          let message = response.statusText;
          if (
            payload &&
            typeof payload === 'object' &&
            'error' in payload &&
            typeof (payload as { error?: unknown }).error === 'string'
          ) {
            message = (payload as { error: string }).error;
          }
          console.error('Failed to open file in editor:', message);
        }
      } catch (error) {
        console.error('Failed to open file in editor:', error);
      }
    },
    [settings.editor],
  );

  const handleGlobalClick = (e: React.MouseEvent) => {
    // Clear cursor position
    setCursorPosition(null);

    // Check if clicking on a comment button
    const target = e.target as HTMLElement;
    const isCommentButton = target.closest('[data-comment-button="true"]');
    const isOpenInEditorButton = target.closest('[data-open-in-editor-button="true"]');
    const isShiftRangeClick = e.shiftKey && target.closest('[data-diff-line-row="true"]');

    // Close empty comment forms (unless clicking on a comment button)
    if (!isCommentButton && !isOpenInEditorButton && !isShiftRangeClick) {
      closeEmptyCommentForms(e);
    }
  };

  const closeEmptyCommentForms = (e: React.MouseEvent) => {
    const emptyForms = document.querySelectorAll('form[data-empty="true"]');
    emptyForms.forEach((form) => {
      // Don't close if clicking inside the form itself
      if (!form.contains(e.target as Node)) {
        const cancelButton = form.querySelector<HTMLButtonElement>('[data-comment-cancel="true"]');
        cancelButton?.click();
      }
    });
  };

  if (loading && !diffData) {
    return (
      <div className="flex items-center justify-center h-screen bg-github-bg-primary">
        <div className="text-github-text-secondary text-base">Loading diff...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-github-bg-primary text-center gap-2">
        <h2 className="text-github-danger text-2xl mb-2">Error</h2>
        <p className="text-github-text-secondary text-base">{error}</p>
      </div>
    );
  }

  if (!diffData) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-github-bg-primary text-center gap-2">
        <h2 className="text-github-danger text-2xl mb-2">No data</h2>
        <p className="text-github-text-secondary text-base">No diff data available</p>
      </div>
    );
  }

  const canOpenInEditor =
    diffData.openInEditorAvailable !== false &&
    settings.editor.id !== 'none' &&
    settings.editor.command.trim() !== '' &&
    settings.editor.argsTemplate.trim() !== '';

  const minimalUI = settings.minimalUI === true;
  const minimalDesktop = minimalUI && !isMobile;
  const layoutControls = (
    <ReviewLayoutControls
      sidebarOpen={isFileTreeOpen}
      onToggleSidebar={() => setIsFileTreeOpen(!isFileTreeOpen)}
      onOpenSettings={() => setIsSettingsOpen(true)}
    />
  );

  return (
    <ReviewDrafts key={diffData?.reviewId} reviewId={diffData?.reviewId}>
      {commentSaveError && <div role="alert">{commentSaveError}</div>}
      <WordHighlightProvider>
        <div
          className="h-screen flex flex-col"
          onClickCapture={handleGlobalClick}
          data-minimal-ui={minimalUI}
          data-minimal-desktop={minimalDesktop}
          style={
            minimalDesktop
              ? {
                  gridTemplateColumns: `${isFileTreeOpen ? sidebarWidth : 0}px ${isFileTreeOpen ? 4 : 0}px minmax(0, 1fr)`,
                }
              : undefined
          }
        >
          <header
            className={`bg-github-bg-secondary border-b border-github-border flex ${
              isMobile ? 'flex-col' : 'flex-row items-center'
            }`}
          >
            <div
              data-review-brand
              className={`flex items-center justify-between w-full ${
                isMobile ? 'px-3 py-2 gap-3' : 'px-4 py-3 gap-4 w-auto'
              } ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isMobile ? '100%' : isFileTreeOpen ? `${sidebarWidth}px` : 'auto',
                minWidth: isMobile ? '0px' : isFileTreeOpen ? '200px' : 'auto',
                maxWidth: isMobile ? 'none' : isFileTreeOpen ? '600px' : 'none',
              }}
            >
              <h1>
                <Logo
                  style={{
                    height: '18px',
                    color: 'var(--color-github-text-secondary)',
                  }}
                />
              </h1>
              {layoutControls}
            </div>
            {!isMobile && (
              <div
                data-review-header-divider
                className={`border-r border-github-border ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
                style={{
                  width: isFileTreeOpen ? '4px' : '0px',
                  height: 'calc(100% - 16px)',
                  margin: '8px 0',
                  transform: 'translateX(-2px)',
                }}
              />
            )}
            <div
              className={`flex-1 flex flex-wrap items-center justify-between ${
                isMobile ? 'px-3 pb-2 gap-3' : 'px-4 py-3 gap-4'
              }`}
            >
              <div className={`flex flex-wrap items-center ${isMobile ? 'gap-2' : 'gap-3'}`}>
                {minimalUI && layoutControls}
                {!isMobile && (
                  <div className="flex bg-github-bg-tertiary border border-github-border rounded-md p-1">
                    <button
                      onClick={() => handleDiffModeChange('split')}
                      className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                        diffMode === 'split'
                          ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                          : 'text-github-text-secondary hover:text-github-text-primary'
                      }`}
                    >
                      <Columns size={14} />
                      Split
                    </button>
                    <button
                      onClick={() => handleDiffModeChange('unified')}
                      className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                        diffMode === 'unified'
                          ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                          : 'text-github-text-secondary hover:text-github-text-primary'
                      }`}
                    >
                      <AlignLeft size={14} />
                      Unified
                    </button>
                  </div>
                )}
                <Checkbox
                  checked={ignoreWhitespace}
                  onChange={setIgnoreWhitespace}
                  label="Ignore Whitespace"
                  title={ignoreWhitespace ? 'Show whitespace changes' : 'Ignore whitespace changes'}
                />
                {/* File Watch Reload Button */}
                {(!review.inventory ||
                  !reviewSettings.autoRefresh ||
                  watchError ||
                  refreshError) && (
                  <ReloadButton
                    shouldReload={shouldReload || refreshError !== null}
                    isReloading={watchState.isReloading}
                    onReload={reload}
                    changeType={watchState.lastChangeType}
                    compact={isMobile}
                  />
                )}
                {(watchError || refreshError) && (
                  <span role="alert" className="text-xs text-github-danger">
                    {watchError || refreshError}
                  </span>
                )}
              </div>
              <div
                className={`flex flex-wrap items-center text-sm text-github-text-secondary ${
                  isMobile ? 'gap-3' : 'gap-4'
                }`}
              >
                {!isMobile && (threads.length > 0 || diffData.agentHandoff) && (
                  <CommentsDropdown
                    commentsCount={threads.length}
                    isCopiedAll={isCopiedAll}
                    handoff={diffData.agentHandoff}
                    pending={diffData.agentHandoff ? reviewExport.pending : clipboardExport.pending}
                    copyPending={clipboardExport.pending}
                    isCopiedToClipboard={clipboardExport.succeeded}
                    onPassToAgent={handlePassToAgent}
                    disabled={
                      !hasBootstrappedComments || !reviewSettings.template.includes('{{review}}')
                    }
                    onCopyAll={handleCopyAllComments}
                    onDeleteAll={clearAllComments}
                    onViewAll={() => setIsCommentsListOpen(true)}
                  />
                )}
                {!isMobile && exportError && (
                  <span role="alert" className="text-xs text-github-danger max-w-64">
                    {exportError}
                  </span>
                )}
                <div className="flex flex-col gap-1 items-center">
                  <div className="text-xs relative">
                    {diffData.files.length > 0 && viewedFiles.size === diffData.files.length
                      ? 'All diffs difit-ed!'
                      : `${viewedFiles.size} / ${diffData.files.length} files viewed`}
                    <SparkleAnimation isActive={showSparkles} />
                    {viewedFiles.size > 0 && (
                      <ResetViewedButton
                        onReset={() => void resetViewedProgress()}
                        disabled={!hasLoadedInitialViewedFiles}
                      />
                    )}
                  </div>
                  <div
                    className="relative h-2 bg-github-bg-tertiary rounded-full overflow-hidden"
                    style={{
                      width: '90px',
                      border: '1px solid var(--color-github-border)',
                    }}
                  >
                    <div
                      className="absolute top-0 right-0 h-full transition-all duration-300 ease-out"
                      style={{
                        width: `${((diffData.files.length - viewedFiles.size) / Math.max(1, diffData.files.length)) * 100}%`,
                        backgroundColor: (() => {
                          const remainingPercent =
                            ((diffData.files.length - viewedFiles.size) /
                              Math.max(1, diffData.files.length)) *
                            100;
                          if (remainingPercent > 50) return 'var(--color-github-accent)'; // green
                          if (remainingPercent > 20) return 'var(--color-github-warning)'; // yellow
                          return 'var(--color-github-danger)'; // red
                        })(),
                      }}
                    />
                  </div>
                </div>
                {(loading || review.busy) && <DiffLoadingStatus />}
                {review.inventory ? (
                  <ReviewPicker
                    inventory={review.inventory}
                    range={review.range}
                    active={review.active}
                    notice={review.notice}
                    error={review.error}
                    busy={review.busy}
                    loading={loading}
                    ignoreWhitespace={ignoreWhitespace}
                    onSelect={review.select}
                    onTargetChange={(target) => void review.changeTarget(target)}
                    onAdvanced={() => {
                      review.useAdvanced();
                      setIsRevisionModalOpen(true);
                    }}
                  />
                ) : diffData.reviewAvailable ? (
                  review.error ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span role="alert" className="text-github-danger">
                        {review.error}
                      </span>
                      <button
                        type="button"
                        className="text-github-link hover:underline"
                        onClick={() => void review.refresh().catch(() => {})}
                      >
                        Retry change selection
                      </button>
                      {diffData.reviewSubject?.checkout && (
                        <button
                          type="button"
                          className="text-github-link hover:underline"
                          onClick={() => {
                            const checkout = diffData.reviewSubject?.checkout;
                            if (!checkout) return;
                            review.useAdvanced();
                            void handleRevisionChange({
                              baseCommitish: checkout.head,
                              targetCommitish: '.',
                              includeUntracked: true,
                            });
                          }}
                        >
                          Uncommitted changes
                        </button>
                      )}
                    </div>
                  ) : (
                    <span role="status" className="text-xs">
                      Loading change selection…
                    </span>
                  )
                ) : revisionOptions ? (
                  <DiffQuickMenu
                    options={revisionOptions}
                    selection={selectedRevision}
                    resolvedBaseRevision={resolvedBaseRevision}
                    resolvedTargetRevision={resolvedTargetRevision}
                    onSelectDiff={(selection) => void handleRevisionChange(selection)}
                    onOpenAdvanced={() => setIsRevisionModalOpen(true)}
                    compact={!isDesktop}
                  />
                ) : (
                  <span className="text-xs">
                    Reviewing:{' '}
                    <code className="bg-github-bg-tertiary px-1.5 py-0.5 rounded text-xs text-github-text-primary">
                      {diffData.commit.includes('...') ? (
                        <>
                          <span className="text-github-text-secondary font-medium">
                            {diffData.commit.split('...')[0]}...
                          </span>
                          <span className="font-medium">{diffData.commit.split('...')[1]}</span>
                        </>
                      ) : (
                        diffData.commit
                      )}
                    </code>
                  </span>
                )}
              </div>
            </div>
          </header>
          {revisionOptions && (
            <RevisionDetailModal
              key={isRevisionModalOpen ? getDiffSelectionKey(selectedRevision) : 'closed'}
              isOpen={isRevisionModalOpen}
              onClose={() => setIsRevisionModalOpen(false)}
              options={revisionOptions}
              selection={selectedRevision}
              resolvedBaseRevision={resolvedBaseRevision}
              resolvedTargetRevision={resolvedTargetRevision}
              onApply={(selection) => void handleRevisionChange(selection)}
            />
          )}

          {isMobile && isFileTreeOpen && (
            <button
              type="button"
              aria-label="Close file tree"
              className="fixed inset-0 bg-black/40 z-30"
              onClick={() => setIsFileTreeOpen(false)}
            />
          )}

          <div data-review-body className="flex flex-1 overflow-hidden relative">
            <div
              data-review-sidebar
              className={`relative overflow-hidden ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isMobile ? '0px' : isFileTreeOpen ? `${sidebarWidth}px` : '0px',
              }}
            >
              <aside
                id="file-tree-panel"
                className={`bg-github-bg-secondary overflow-y-auto flex flex-col ${
                  isMobile
                    ? 'fixed inset-y-0 right-0 z-40 w-[min(85vw,360px)] border-l border-github-border transition-transform duration-300 ease-out'
                    : 'relative border-r border-github-border'
                }`}
                style={{
                  width: isMobile ? 'min(85vw, 360px)' : `${sidebarWidth}px`,
                  minWidth: isMobile ? '0px' : '200px',
                  maxWidth: isMobile ? 'none' : '600px',
                  height: '100%',
                  transform: isMobile
                    ? isFileTreeOpen
                      ? 'translateX(0)'
                      : 'translateX(100%)'
                    : undefined,
                }}
              >
                <div className="flex-1 overflow-y-auto">
                  <FileList
                    files={diffData.files}
                    onScrollToFile={scrollFileIntoDiffContainer}
                    onFileSelected={isMobile ? handleMobileFileSelected : undefined}
                    comments={normalizedThreads}
                    reviewedFiles={viewedFiles}
                    onToggleReviewed={toggleFileReviewed}
                    onToggleFolderReviewed={toggleFolderReviewed}
                    selectedFileIndex={cursor?.fileIndex ?? null}
                  />
                </div>
                {!isMobile && !settings.minimalUI && (
                  <div className="p-4 border-t border-github-border flex justify-end items-center">
                    <a
                      href="https://github.com/yoshiko-pg/difit"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-github-text-secondary hover:text-github-text-primary transition-colors"
                      title="View on GitHub"
                    >
                      <span className="text-sm">Star on GitHub</span>
                      <GitHubIcon style={{ height: '18px', width: '18px' }} />
                    </a>
                  </div>
                )}
              </aside>
            </div>

            {!isMobile && (
              <div
                data-review-resizer
                className={`bg-github-border hover:bg-github-text-muted cursor-col-resize ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
                style={{
                  width: isFileTreeOpen ? '4px' : '0px',
                }}
                onMouseDown={handleMouseDown}
                title="Drag to resize file list"
              />
            )}

            <ReviewScrollContainer
              containerRef={diffScrollContainerRef}
              aria-busy={loading || review.busy}
              className={`flex-1 overflow-y-auto ${showMobileCommentsBar ? 'pb-16' : ''}`}
            >
              {diffData.files.length === 0 && (
                <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-sm text-github-text-secondary">
                    No changes in this comparison.
                  </p>
                  {review.error && (
                    <p role="alert" className="text-xs text-github-danger">
                      {review.error}
                    </p>
                  )}
                </div>
              )}
              {diffData.files.map((file, fileIndex) => {
                const fileThreads = threadsByFile.get(file.path) ?? EMPTY_COMMENT_THREADS;
                const mergedChunks =
                  getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path, file) ??
                  getInitialMergedChunks(file);
                const isRendered = renderedFilePaths.has(file.path);
                return (
                  <div
                    key={file.path}
                    id={getFileElementId(file.path)}
                    data-file-path={file.path}
                    data-rendered={isRendered ? 'true' : 'false'}
                    ref={(node) => registerLazyFileContainer(file.path, node)}
                    className="mb-6"
                    onMouseEnter={() => {
                      hoveredFileIndexRef.current = fileIndex;
                    }}
                    onMouseLeave={() => {
                      if (hoveredFileIndexRef.current === fileIndex) {
                        hoveredFileIndexRef.current = null;
                      }
                    }}
                  >
                    {isRendered ? (
                      <DiffViewer
                        file={file}
                        threads={fileThreads}
                        showAuthorBadges={showAuthorBadges}
                        diffMode={diffMode}
                        reviewedFiles={viewedFiles}
                        isChangedSinceViewed={changedSinceViewedFiles.has(file.path)}
                        onToggleReviewed={handleViewedButtonToggle}
                        collapsedFiles={collapsedFiles}
                        onToggleCollapsed={toggleFileCollapsed}
                        onToggleAllCollapsed={toggleAllFilesCollapsed}
                        onAddComment={handleAddComment}
                        onGenerateThreadPrompt={handleGenerateThreadPrompt}
                        onRemoveThread={removeThread}
                        onReplyToThread={handleReplyToThread}
                        onRemoveMessage={removeMessage}
                        onUpdateMessage={updateMessage}
                        onOpenInEditor={canOpenInEditor ? handleOpenInEditor : undefined}
                        syntaxTheme={settings.syntaxTheme}
                        baseCommitish={diffData.baseCommitish}
                        targetCommitish={diffData.targetCommitish}
                        cursor={cursor?.fileIndex === fileIndex ? cursor : null}
                        isFocused={cursor?.fileIndex === fileIndex}
                        fileIndex={fileIndex}
                        onLineClick={handleLineClick}
                        commentTrigger={
                          commentTrigger?.fileIndex === fileIndex ? commentTrigger : null
                        }
                        onCommentTriggerHandled={handleCommentTriggerHandled}
                        mergedChunks={mergedChunks}
                        expandLines={expandLines}
                        expandAllBetweenChunks={expandAllBetweenChunks}
                        prefetchFileContent={prefetchFileContent}
                        isExpandLoading={isExpandLoading}
                        diffVersion={diffDataVersion}
                      />
                    ) : (
                      <div className="bg-github-bg-secondary border border-github-border rounded-md px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-wide text-github-text-muted">
                              Deferred Rendering
                            </div>
                            <div className="text-sm font-mono text-github-text-primary truncate">
                              {file.path}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => ensureFileRendered(file.path)}
                            className="px-3 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary"
                          >
                            Load now
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </ReviewScrollContainer>
          </div>

          {showMobileCommentsBar && (
            <div className="fixed bottom-0 left-0 right-0 z-20 bg-github-bg-secondary border-t border-github-border px-4 py-2 flex justify-end">
              {exportError && (
                <span role="alert" className="text-xs text-github-danger mr-3">
                  {exportError}
                </span>
              )}
              <CommentsDropdown
                commentsCount={threads.length}
                isCopiedAll={isCopiedAll}
                handoff={diffData.agentHandoff}
                pending={diffData.agentHandoff ? reviewExport.pending : clipboardExport.pending}
                copyPending={clipboardExport.pending}
                isCopiedToClipboard={clipboardExport.succeeded}
                onPassToAgent={handlePassToAgent}
                disabled={
                  !hasBootstrappedComments || !reviewSettings.template.includes('{{review}}')
                }
                onCopyAll={handleCopyAllComments}
                onDeleteAll={clearAllComments}
                onViewAll={() => setIsCommentsListOpen(true)}
                direction="up"
                compact
              />
            </div>
          )}

          {isSettingsOpen && (
            <SettingsModal
              isOpen={isSettingsOpen}
              onClose={() => setIsSettingsOpen(false)}
              settings={settings}
              onSettingsChange={updateSettings}
              reviewSection={
                <ReviewSettingsSection
                  settings={reviewSettings}
                  onChange={updateReviewSettings}
                  review={reviewExport.prompt}
                />
              }
            />
          )}

          <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

          <CommentsListModal
            isOpen={isCommentsListOpen}
            onClose={() => setIsCommentsListOpen(false)}
            onNavigate={handleNavigateToComment}
            comments={normalizedThreads}
            showAuthorBadges={showAuthorBadges}
            onRemoveThread={removeThread}
            onGenerateThreadPrompt={handleGenerateThreadPrompt}
            onReplyToThread={handleReplyToThread}
            onRemoveMessage={removeMessage}
            onUpdateMessage={updateMessage}
            syntaxTheme={settings.syntaxTheme}
          />
        </div>
      </WordHighlightProvider>
    </ReviewDrafts>
  );
}

export default App;
