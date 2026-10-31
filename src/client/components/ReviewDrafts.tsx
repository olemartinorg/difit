import { reviewFetch } from '../services/reviewContext';
import { reportReviewError } from '../services/reviewErrors';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
interface Form {
  body: string;
  context: unknown;
}
const Context = createContext<{
  forms: Record<string, Form>;
  save(id: string, value: Form | null): void;
} | null>(null);
export function ReviewDrafts({
  reviewId,
  refreshVersion,
  children,
}: {
  reviewId?: string;
  refreshVersion?: number;
  children: ReactNode;
}) {
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [history, setHistory] = useState<
    Record<string, import('../../types/diff').DiffCommentThread[]>
  >({});
  const [readError, setReadError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});
  const historyLoaded = useRef(false);
  const version = useRef(-1);
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const owner = useMemo(() => ({ reviewId }), [reviewId]);
  const historyRequest = useRef<typeof owner | null>(null);
  const currentOwner = useRef<typeof owner | null>(owner);
  currentOwner.current = owner;
  useEffect(() => {
    version.current = -1;
    historyLoaded.current = false;
    failed.current = false;
    setReadError(null);
    setHistoryError(null);
    setWriteErrors({});
    setHistory({});
    setForms({});
    if (!reviewId) return;
    let live = true;
    let nextRead = 0;
    let settledRead = 0;
    const refresh = async () => {
      const read = ++nextRead;
      try {
        const response = await reviewFetch(
          `/api/review-state?reviewId=${encodeURIComponent(reviewId)}`,
        );
        if (!response.ok) throw new Error(`Review request failed (HTTP ${response.status})`);
        const data = (await response.json()) as { version: number; forms: Record<string, Form> };
        if (!live) return;
        if (read >= settledRead) {
          settledRead = read;
          setReadError(null);
        }
        if (!pending.current && !failed.current && data.version >= version.current) {
          version.current = data.version;
          setForms(data.forms);
        }
      } catch (cause) {
        reportReviewError('draft refresh', cause);
        if (live && read >= settledRead) {
          settledRead = read;
          setReadError('Saved drafts are unavailable. Your local text is kept.');
        }
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!pending.current) void refresh();
    }, 1500);
    return () => {
      live = false;
      if (currentOwner.current === owner) currentOwner.current = null;
      clearInterval(timer);
    };
  }, [reviewId, owner]);
  useEffect(() => {
    // History is loaded once per review. An existing refresh may recover a failed
    // read, but healthy refreshes must not add history polling.
    if (!reviewId || historyLoaded.current || historyRequest.current === owner) return;
    historyRequest.current = owner;
    void reviewFetch('/api/reviews/unassigned')
      .then((response) => {
        if (!response.ok) throw new Error(`Review request failed (HTTP ${response.status})`);
        return response.json();
      })
      .then((value) => {
        if (currentOwner.current === owner) {
          historyLoaded.current = true;
          setHistory(value as typeof history);
          setHistoryError(null);
        }
      })
      .catch((cause) => {
        reportReviewError('historical comments', cause);
        if (currentOwner.current === owner) setHistoryError('Historical comments are unavailable.');
      })
      .finally(() => {
        if (historyRequest.current === owner) historyRequest.current = null;
      });
  }, [reviewId, refreshVersion, owner]);
  const save = useCallback(
    (id: string, value: Form | null, pendingId?: string) => {
      if (!reviewId) return;
      setForms((previous) => {
        const next = { ...previous };
        if (value) next[id] = value;
        else delete next[id];
        return next;
      });
      const key = `difit-pending-form/${reviewId}/${id}`;
      const writeId = pendingId ?? crypto.randomUUID();
      const pendingValue = JSON.stringify({ writeId, value });
      localStorage.setItem(key, pendingValue);
      pending.current++;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          try {
            const response = await reviewFetch(
              `/api/comments?reviewId=${encodeURIComponent(reviewId)}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ writeId, operations: [{ kind: 'form', id, value }] }),
              },
            );
            if (!response.ok) throw new Error(`Review request failed (HTTP ${response.status})`);
            if (localStorage.getItem(key) === pendingValue) localStorage.removeItem(key);
            if (currentOwner.current === owner) {
              failed.current = Object.keys(localStorage).some((key) =>
                key.startsWith(`difit-pending-form/${reviewId}/`),
              );
              setWriteErrors((previous) => {
                const next = { ...previous };
                delete next[`form/${id}`];
                return next;
              });
            }
          } catch (cause) {
            reportReviewError('draft save', cause);
            if (currentOwner.current === owner) {
              failed.current = true;
              setWriteErrors((previous) => ({
                ...previous,
                [`form/${id}`]: 'Draft save was not confirmed. Your text is kept on this device.',
              }));
            }
          } finally {
            pending.current--;
          }
        });
    },
    [reviewId, owner],
  );
  useEffect(() => {
    if (!reviewId) return;
    const prefix = `difit-pending-form/${reviewId}/`;
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key): key is string => !!key?.startsWith(prefix));
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw) as { writeId: string; value: Form | null };
      save(key.slice(prefix.length), saved.value, saved.writeId);
    }
  }, [reviewId, save]);
  const contextValue = useMemo(() => ({ forms, save }), [forms, save]);
  return (
    <Context.Provider value={contextValue}>
      {readError && (
        <div role="alert">
          {readError} <button onClick={() => setReadError(null)}>Dismiss</button>
        </div>
      )}
      {historyError && (
        <div role="alert">
          {historyError} <button onClick={() => setHistoryError(null)}>Dismiss</button>
        </div>
      )}
      {Object.entries(writeErrors).map(([key, message]) => (
        <div role="alert" key={key}>
          {message}{' '}
          <button
            onClick={() =>
              setWriteErrors((previous) => {
                const next = { ...previous };
                delete next[key];
                return next;
              })
            }
          >
            Dismiss
          </button>
        </div>
      ))}
      {Object.keys(history).length > 0 && (
        <details className="m-2 rounded border border-github-border p-2 text-sm">
          <summary>Unassigned historical comments</summary>
          {Object.entries(history).map(([id, threads]) => (
            <div key={id} className="mt-2">
              {threads.length} comments from earlier repository reviews. Original records stay
              preserved.
              <button
                className="ml-2 rounded border border-github-border px-2 py-1"
                onClick={() => {
                  void reviewFetch(
                    `/api/reviews/unassigned/${id}/assign?reviewId=${encodeURIComponent(reviewId ?? '')}`,
                    { method: 'POST' },
                  )
                    .then((response) => {
                      if (!response.ok)
                        throw new Error(`Review request failed (HTTP ${response.status})`);
                      if (currentOwner.current !== owner) return;
                      setWriteErrors((previous) => {
                        const next = { ...previous };
                        delete next[`assign/${id}`];
                        return next;
                      });
                      setHistory((previous) => {
                        const next = { ...previous };
                        delete next[id];
                        return next;
                      });
                    })
                    .catch((cause) => {
                      reportReviewError('assign historical comments', cause);
                      if (currentOwner.current === owner)
                        setWriteErrors((previous) => ({
                          ...previous,
                          [`assign/${id}`]: 'Comment assignment was not confirmed.',
                        }));
                    });
                }}
              >
                Assign to this review
              </button>
              <pre className="whitespace-pre-wrap">
                {threads
                  .map(
                    (thread) =>
                      `${thread.filePath}: ${thread.messages.map((message) => message.body).join('\n')}`,
                  )
                  .join('\n\n')}
              </pre>
            </div>
          ))}
        </details>
      )}
      {children}
    </Context.Provider>
  );
}
export function useReviewDraft(id?: string) {
  const context = useContext(Context);
  const form = id ? context?.forms[id] : undefined;
  return {
    form,
    save: (value: Form | null) => {
      if (id) context?.save(id, value);
    },
  };
}
