import { useEffect } from 'react';
import { useReviewDraft } from './ReviewDrafts';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';

import type { DiffChunk, DiffFile } from '../../types/diff';
import { CommentThreadCard } from './CommentThreadCard';
import {
  createDraftAnchor,
  resolveDraftAnchor,
  type DraftAnchor,
  type DraftSelection,
} from '../utils/draftAnchor';
import type { DiffViewerBodyProps } from '../viewers/types';
import { CommentForm } from './CommentForm';

const DraftContext = createContext<{
  selection: DraftSelection | null;
  setSelection: Dispatch<SetStateAction<DraftSelection | null>>;
  host: HTMLDivElement;
} | null>(null);

type ThreadHost = { node: HTMLDivElement; focused?: HTMLElement; top?: number; placed?: boolean };
const ThreadContext = createContext<{
  hosts: Map<string, ThreadHost>;
  slots: Map<string, HTMLDivElement>;
} | null>(null);
const emptyThreads: NonNullable<DiffViewerBodyProps['threads']> = [];

function rememberThread(entry: ThreadHost) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && entry.node.contains(active)) {
    entry.focused = active;
    entry.top = active.getBoundingClientRect().top;
  }
}

function placeThread(entry: ThreadHost, slot: HTMLElement) {
  if (entry.node.parentNode === slot) return;
  rememberThread(entry);
  slot.append(entry.node);
  entry.placed = true;
  if (entry.focused) {
    entry.focused.focus({ preventScroll: true });
    if (entry.top !== undefined) {
      for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          parent.scrollTop += entry.focused.getBoundingClientRect().top - entry.top;
          break;
        }
      }
    }
    entry.focused = undefined;
    entry.top = undefined;
  }
}

function StableThreadCard(props: ComponentProps<typeof CommentThreadCard>) {
  const context = useContext(ThreadContext);
  if (!context) throw new Error('A stable thread requires its live comment owner');
  const fallback = useRef<HTMLDivElement>(null);
  const [entry] = useState<ThreadHost>(() => ({ node: document.createElement('div') }));
  useLayoutEffect(() => {
    context.hosts.set(props.thread.id, entry);
    const slot = context.slots.get(props.thread.id) ?? (entry.placed ? fallback.current : null);
    if (slot) placeThread(entry, slot);
    return () => {
      rememberThread(entry);
    };
  });
  useEffect(
    () => () => {
      context.hosts.delete(props.thread.id);
      entry.node.remove();
    },
    [context, entry, props.thread.id],
  );
  return (
    <>
      <div ref={fallback} />
      {createPortal(<CommentThreadCard {...props} />, entry.node)}
    </>
  );
}

// Row slots may move between hunks. The file's live-comment owner keeps the
// actual thread/editor portal keyed by logical thread identity.
export function InlineCommentThreadCard(props: ComponentProps<typeof CommentThreadCard>) {
  const context = useContext(ThreadContext);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!context || !slot.current) return;
    const node = slot.current;
    context.slots.set(props.thread.id, node);
    const entry = context.hosts.get(props.thread.id);
    if (entry) placeThread(entry, node);
    return () => {
      const current = context.hosts.get(props.thread.id);
      if (current) rememberThread(current);
      if (context.slots.get(props.thread.id) === node) context.slots.delete(props.thread.id);
    };
  }, [context, props.thread.id]);
  return context ? <div ref={slot} /> : <CommentThreadCard {...props} />;
}

export function LiveCommentDraftProvider({
  children,
  file,
  chunks,
  onAddComment,
  syntaxTheme,
  diffMode,
  threads = emptyThreads,
  showAuthorBadges,
  onGenerateThreadPrompt,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
}: {
  children: ReactNode;
  file: DiffFile;
  chunks: DiffChunk[];
  onAddComment: DiffViewerBodyProps['onAddComment'];
  syntaxTheme: DiffViewerBodyProps['syntaxTheme'];
  diffMode: DiffViewerBodyProps['diffMode'];
  threads?: DiffViewerBodyProps['threads'];
  showAuthorBadges?: boolean;
  onGenerateThreadPrompt?: DiffViewerBodyProps['onGenerateThreadPrompt'];
  onRemoveThread?: DiffViewerBodyProps['onRemoveThread'];
  onReplyToThread?: DiffViewerBodyProps['onReplyToThread'];
  onRemoveMessage?: DiffViewerBodyProps['onRemoveMessage'];
  onUpdateMessage?: DiffViewerBodyProps['onUpdateMessage'];
}) {
  const [threadContext] = useState(() => ({
    hosts: new Map<string, ThreadHost>(),
    slots: new Map<string, HTMLDivElement>(),
  }));
  const anchorDraft = useReviewDraft(`anchor:${file.path}`);
  const [anchor, setLocalAnchor] = useState<(DraftAnchor & { id: string }) | null>(null);
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.dataset.liveCommentEditor = 'true';
    return node;
  });
  const setAnchor = (value: (DraftAnchor & { id: string }) | null) => {
    setLocalAnchor(value);
    anchorDraft.save(value ? { body: '', context: value } : null);
  };
  useEffect(() => {
    setLocalAnchor(
      anchorDraft.form?.context ? (anchorDraft.form.context as DraftAnchor & { id: string }) : null,
    );
  }, [anchorDraft.form]);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const draft = useMemo(
    () => (anchor ? resolveDraftAnchor(anchor, chunks) : null),
    [anchor, chunks],
  );
  const currentRef = useRef({ chunks, draft, setAnchor });
  currentRef.current = { chunks, draft, setAnchor };
  const setSelection = useCallback<Dispatch<SetStateAction<DraftSelection | null>>>((update) => {
    const current = currentRef.current;
    const next = typeof update === 'function' ? update(current.draft) : update;
    current.setAnchor(
      next ? { ...createDraftAnchor(next, current.chunks), id: crypto.randomUUID() } : null,
    );
  }, []);
  const value = useMemo(
    () => ({ selection: draft?.outdated ? null : draft, setSelection, host }),
    [draft, setSelection, host],
  );

  useLayoutEffect(() => {
    // If the commented code was removed or changed, keep the draft available
    // with its original snapshot instead of attaching it to unrelated code.
    if (!anchor) {
      host.remove();
      host.removeAttribute('style');
      host.removeAttribute('data-viewport-offset');
      return;
    }
    if (!host.isConnected) fallbackRef.current?.append(host);
  });

  return (
    <DraftContext.Provider value={value}>
      <ThreadContext.Provider value={threadContext}>
        {children}
        <div
          ref={fallbackRef}
          className={
            draft?.outdated && diffMode === 'split'
              ? `w-1/2 ${draft.side === 'new' ? 'ml-auto' : ''}`
              : undefined
          }
        />
        {anchor &&
          draft &&
          createPortal(
            <>
              {draft.outdated && (
                <div className="mx-3 mt-2 text-xs text-github-text-secondary">
                  Original code no longer matches this diff.
                  <pre className="mt-1 whitespace-pre-wrap">{anchor.code}</pre>
                </div>
              )}
              <CommentForm
                key={anchor.id}
                draftId={`new:${file.path}:${anchor.id}`}
                onSubmit={async (body) => {
                  await onAddComment(draft.lineNumber, body, anchor.code, draft.side);
                  setAnchor(null);
                }}
                onCancel={() => setAnchor(null)}
                selectedCode={anchor.code}
                syntaxTheme={syntaxTheme}
                filename={file.path}
              />
            </>,
            host,
          )}
        {threads.map(
          (thread) =>
            onGenerateThreadPrompt &&
            onRemoveThread &&
            onReplyToThread &&
            onRemoveMessage &&
            onUpdateMessage && (
              <StableThreadCard
                key={thread.id}
                thread={thread}
                syntaxTheme={syntaxTheme}
                showAuthorBadges={showAuthorBadges}
                onGeneratePrompt={onGenerateThreadPrompt}
                onRemoveThread={onRemoveThread}
                onReplyToThread={onReplyToThread}
                onRemoveMessage={onRemoveMessage}
                onUpdateMessage={onUpdateMessage}
              />
            ),
        )}
      </ThreadContext.Provider>
    </DraftContext.Provider>
  );
}

export function useCommentingLine() {
  const context = useContext(DraftContext);
  const local = useState<DraftSelection | null>(null);
  return context ? ([context.selection, context.setSelection] as const) : local;
}

export function LineCommentForm(props: ComponentProps<typeof CommentForm>) {
  const context = useContext(DraftContext);
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (context && slotRef.current && context.host.parentNode !== slotRef.current) {
      slotRef.current.append(context.host);
    }
  });
  return context ? <div ref={slotRef} /> : <CommentForm {...props} />;
}
