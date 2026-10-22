import { reviewFetch } from '../services/reviewContext';
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
export function ReviewDrafts({ reviewId, children }: { reviewId?: string; children: ReactNode }) {
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [history, setHistory] = useState<
    Record<string, import('../../types/diff').DiffCommentThread[]>
  >({});
  const [error, setError] = useState<string | null>(null);
  const version = useRef(-1);
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const currentId = useRef(reviewId);
  currentId.current = reviewId;
  useEffect(() => {
    version.current = -1;
    failed.current = false;
    setError(null);
    setHistory({});
    setForms({});
    if (!reviewId) return;
    let live = true;
    const refresh = async () => {
      try {
        const response = await reviewFetch(
          `/api/review-state?reviewId=${encodeURIComponent(reviewId)}`,
        );
        if (!response.ok) throw new Error('Could not load saved review drafts');
        const data = (await response.json()) as { version: number; forms: Record<string, Form> };
        if (live && !pending.current && !failed.current && data.version >= version.current) {
          version.current = data.version;
          setForms(data.forms);
        }
      } catch (cause) {
        if (live) setError(String(cause));
      }
    };
    void refresh();
    void reviewFetch('/api/reviews/unassigned')
      .then((response) => response.json())
      .then((value) => {
        if (live) setHistory(value as typeof history);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    const timer = setInterval(() => {
      if (!pending.current) void refresh();
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [reviewId]);
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
            if (!response.ok)
              throw new Error(
                'Draft save failed. Your text is kept on this device; retry by editing it.',
              );
            if (localStorage.getItem(key) === pendingValue) localStorage.removeItem(key);
            if (currentId.current === reviewId) {
              failed.current = false;
              setError(null);
            }
          } catch (cause) {
            if (currentId.current === reviewId) {
              failed.current = true;
              setError(String(cause));
            }
          } finally {
            pending.current--;
          }
        });
    },
    [reviewId],
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
      {error && <div role="alert">{error}</div>}
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
                      if (!response.ok) throw new Error('Could not assign historical comments');
                      setHistory((previous) => {
                        const next = { ...previous };
                        delete next[id];
                        return next;
                      });
                    })
                    .catch((cause) => setError(String(cause)));
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
