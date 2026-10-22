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

export function LiveCommentDraftProvider({
  children,
  file,
  chunks,
  onAddComment,
  syntaxTheme,
  diffMode,
}: {
  children: ReactNode;
  file: DiffFile;
  chunks: DiffChunk[];
  onAddComment: DiffViewerBodyProps['onAddComment'];
  syntaxTheme: DiffViewerBodyProps['syntaxTheme'];
  diffMode: DiffViewerBodyProps['diffMode'];
}) {
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
