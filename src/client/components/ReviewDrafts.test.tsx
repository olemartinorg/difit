import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentForm } from './CommentForm';
import { ReviewDrafts, useReviewDraft } from './ReviewDrafts';

function DraftInput() {
  const draft = useReviewDraft('new:file:1');
  return (
    <input
      aria-label="draft"
      value={draft.form?.body ?? ''}
      onChange={(event) => draft.save({ body: event.target.value, context: { line: 1 } })}
    />
  );
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('review-scoped unfinished forms', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('restores A/B/A text and sends only the affected form under its captured review identity', async () => {
    const forms = new Map<string, Record<string, { body: string; context: unknown }>>();
    const writes: Array<{ reviewId: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, options?: RequestInit) => {
        const url = new URL(input, 'http://localhost'),
          id = url.searchParams.get('reviewId') ?? '';
        if (url.pathname === '/api/reviews/unassigned') return response({});
        if (options?.method === 'POST') {
          const body = JSON.parse(String(options.body)) as {
            operations: Array<{ id: string; value: { body: string; context: unknown } }>;
          };
          writes.push({ reviewId: id, body });
          for (const operation of body.operations)
            forms.set(id, { ...forms.get(id), [operation.id]: operation.value });
          return response({ success: true });
        }
        return response({ version: 1, forms: forms.get(id) ?? {} });
      }),
    );
    const view = render(
      <ReviewDrafts key="A" reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unfinished A' } });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      reviewId: 'A',
      body: { operations: [{ kind: 'form', id: 'new:file:1', value: { body: 'unfinished A' } }] },
    });
    view.rerender(
      <ReviewDrafts key="B" reviewId="B">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unfinished B' } });
    await waitFor(() => expect(writes).toHaveLength(2));
    view.rerender(
      <ReviewDrafts key="A" reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('unfinished A'));
    expect(writes.map((value) => value.reviewId)).toEqual(['A', 'B']);
  });

  it('ignores a late response from the previously selected review', async () => {
    let releaseA!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/unassigned')) return response({});
        if (input.includes('reviewId=A'))
          return new Promise<Response>((resolve) => {
            releaseA = resolve;
          });
        return response({ version: 2, forms: { 'new:file:1': { body: 'B only', context: {} } } });
      }),
    );
    const view = render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    view.rerender(
      <ReviewDrafts reviewId="B">
        <DraftInput />
      </ReviewDrafts>,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('B only'));
    await act(async () => {
      releaseA(response({ version: 10, forms: { 'new:file:1': { body: 'late A', context: {} } } }));
    });
    expect(screen.getByRole('textbox')).toHaveValue('B only');
  });

  it('does not repaint an earlier revision and applies a remotely cleared form', async () => {
    vi.useFakeTimers();
    let current = {
      version: 2,
      forms: { 'new:file:1': { body: 'saved draft', context: {} } } as Record<
        string,
        { body: string; context: unknown }
      >,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('/unassigned') ? response({}) : response(current),
      ),
    );
    render(
      <ReviewDrafts reviewId="A">
        <CommentForm draftId="new:file:1" onSubmit={vi.fn()} onCancel={vi.fn()} />
      </ReviewDrafts>,
    );
    await act(async () => {});
    expect(screen.getByRole('textbox')).toHaveValue('saved draft');
    current = { version: 1, forms: { 'new:file:1': { body: 'older response', context: {} } } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('textbox')).toHaveValue('saved draft');
    current = { version: 3, forms: {} };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('keeps text after an actual save failure and retries it under the same review after reopening', async () => {
    let fail = true;
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, options?: RequestInit) => {
        if (input.includes('/unassigned')) return response({});
        if (options?.method === 'POST') {
          writes.push(JSON.parse(String(options.body)));
          return fail ? new Response('{}', { status: 500 }) : response({ success: true });
        }
        return response({ version: 0, forms: {} });
      }),
    );
    const view = render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'recoverable A' } });
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('recoverable A');
    const key = 'difit-pending-form/A/new:file:1';
    const pending = localStorage.getItem(key);
    expect(pending).toContain('recoverable A');
    view.unmount();
    fail = false;
    render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(screen.getByRole('textbox')).toHaveValue('recoverable A');
    expect(writes[1]).toEqual(writes[0]);
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  });
});

describe('review error ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const tick = async () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

  it('clears a recovered draft read at the same version without clearing history errors', async () => {
    let failed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/unassigned')) return new Response('{}', { status: 503 });
        if (failed) throw new TypeError('Failed to fetch');
        return response({ version: 4, forms: { 'new:file:1': { body: 'saved', context: {} } } });
      }),
    );
    render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    failed = true;
    await tick();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    failed = false;
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Historical comments are unavailable');
    expect(screen.getByRole('textbox')).toHaveValue('saved');
    expect(console.error).toHaveBeenCalledWith('Review request failed:', {
      operation: 'draft refresh',
      name: 'TypeError',
      message: 'Failed to fetch',
    });
  });

  it('recovers historical reads on existing refresh and dismisses only current feedback', async () => {
    let failed = true;
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes('/unassigned'))
        return failed ? new Response('{}', { status: 503 }) : response({});
      return response({ version: 1, forms: {} });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(
      <ReviewDrafts reviewId="A" refreshVersion={1}>
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
    await tick();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/unassigned'))).toHaveLength(1);
    view.rerender(
      <ReviewDrafts reviewId="A" refreshVersion={2}>
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Historical comments are unavailable');
    failed = false;
    view.rerender(
      <ReviewDrafts reviewId="A" refreshVersion={3}>
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(
      <ReviewDrafts reviewId="A" refreshVersion={4}>
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/unassigned'))).toHaveLength(3);
  });

  it('joins a pending historical read across existing refreshes and retries only after failure', async () => {
    let finishHistory!: (value: Response) => void;
    let historyReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (!input.includes('/unassigned')) return response({ version: 1, forms: {} });
        historyReads++;
        if (historyReads === 1) return new Response('{}', { status: 503 });
        return new Promise<Response>((resolve) => {
          finishHistory = resolve;
        });
      }),
    );
    const contents = (refreshVersion: number) => (
      <ReviewDrafts reviewId="A" refreshVersion={refreshVersion}>
        <DraftInput />
      </ReviewDrafts>
    );
    const view = render(contents(1));
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Historical comments are unavailable');
    view.rerender(contents(2));
    await act(async () => {});
    expect(historyReads).toBe(2);
    view.rerender(contents(3));
    view.rerender(contents(4));
    await act(async () => {});
    expect(historyReads).toBe(2);
    await act(async () => {
      finishHistory(response({}));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(contents(5));
    await act(async () => {});
    expect(historyReads).toBe(2);
  });

  it.each(['rejected', 'unknown'] as const)(
    'preserves %s saves through successful polling and dismissal without replay',
    async (outcome) => {
      let readFails = false;
      let reads = 0;
      const writes: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
          if (input.includes('/unassigned')) return response({});
          if (init?.method === 'POST') {
            writes.push(JSON.parse(String(init.body)));
            if (outcome === 'unknown') throw new TypeError('Failed to fetch');
            return new Response('{}', { status: 503 });
          }
          reads++;
          if (readFails) throw new TypeError('Failed to fetch');
          return response({ version: 1, forms: {} });
        }),
      );
      const view = render(
        <ReviewDrafts reviewId="A" refreshVersion={1}>
          <DraftInput />
        </ReviewDrafts>,
      );
      await act(async () => {});
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep local text' } });
      await act(async () => {});
      const key = 'difit-pending-form/A/new:file:1';
      const pending = localStorage.getItem(key);
      expect(pending).toContain('keep local text');
      readFails = true;
      await tick();
      expect(screen.getAllByRole('alert')).toHaveLength(2);
      readFails = false;
      await tick();
      expect(screen.getByRole('alert')).toHaveTextContent('Draft save was not confirmed');
      expect(reads).toBe(3);
      expect(screen.getByRole('textbox')).toHaveValue('keep local text');
      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
      view.rerender(
        <ReviewDrafts reviewId="A" refreshVersion={2}>
          <DraftInput />
        </ReviewDrafts>,
      );
      await tick();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue('keep local text');
      expect(localStorage.getItem(key)).toBe(pending);
      expect(writes).toHaveLength(1);
    },
  );

  it('does not let an old A write completion clear errors after an A/B/A owner switch', async () => {
    let failA!: (cause: Error) => void;
    let writeCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.includes('/unassigned')) return response({});
        if (init?.method === 'POST') {
          writeCount++;
          if (writeCount === 1)
            return new Promise<Response>((_resolve, reject) => {
              failA = reject;
            });
          return response({});
        }
        if (writeCount) throw new TypeError('Failed to fetch');
        return response({ version: 1, forms: {} });
      }),
    );
    const content = (id: string) => (
      <ReviewDrafts reviewId={id}>
        <DraftInput />
      </ReviewDrafts>
    );
    const view = render(content('A'));
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pending A' } });
    await act(async () => {});
    view.rerender(content('B'));
    await act(async () => {});
    view.rerender(content('A'));
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Saved drafts are unavailable');
    await act(async () => {
      failA(new TypeError('Failed to fetch'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Saved drafts are unavailable');
    expect(screen.queryByText(/Draft save was not confirmed/)).not.toBeInTheDocument();
    expect(writeCount).toBe(2); // Existing reopening recovery uses the original write ID.
  });

  it('ignores a late historical assignment callback after navigation', async () => {
    let rejectAssignment!: (cause: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'POST')
          return new Promise<Response>((_resolve, reject) => {
            rejectAssignment = reject;
          });
        if (input.includes('/unassigned')) return response({ old: [] });
        return response({ version: 1, forms: {} });
      }),
    );
    const view = render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Assign to this review' }));
    view.rerender(
      <ReviewDrafts reviewId="B">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {
      rejectAssignment(new TypeError('Failed to fetch'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

it('does not let a healthy save of another draft hide an unresolved draft failure', async () => {
  localStorage.clear();
  vi.useFakeTimers();
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.includes('/unassigned')) return response({});
        if (init?.method === 'POST') {
          const write = JSON.parse(String(init.body)) as { operations: { id: string }[] };
          return write.operations[0]?.id === 'first'
            ? new Response('{}', { status: 503 })
            : response({});
        }
        return response({ version: 0, forms: {} });
      }),
    );
    function Inputs() {
      const first = useReviewDraft('first');
      const second = useReviewDraft('second');
      return (
        <>
          <input
            aria-label="first"
            value={first.form?.body ?? ''}
            onChange={(e) => first.save({ body: e.target.value, context: {} })}
          />
          <input
            aria-label="second"
            value={second.form?.body ?? ''}
            onChange={(e) => second.save({ body: e.target.value, context: {} })}
          />
        </>
      );
    }
    render(
      <ReviewDrafts reviewId="A">
        <Inputs />
      </ReviewDrafts>,
    );
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'first' }), {
      target: { value: 'unconfirmed first' },
    });
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'second' }), {
      target: { value: 'saved second' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Draft save was not confirmed');
    expect(screen.getByRole('textbox', { name: 'first' })).toHaveValue('unconfirmed first');
    expect(localStorage.getItem('difit-pending-form/A/first')).toContain('unconfirmed first');
    expect(localStorage.getItem('difit-pending-form/A/second')).toBeNull();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('accepts a slow draft read while the next existing poll is still pending', async () => {
  localStorage.clear();
  vi.useFakeTimers();
  try {
    let releaseFirst!: (value: Response) => void;
    let releaseSecond!: (value: Response) => void;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/unassigned')) return response({});
        reads++;
        return new Promise<Response>((resolve) => {
          if (reads === 1) releaseFirst = resolve;
          else releaseSecond = resolve;
        });
      }),
    );
    const view = render(
      <ReviewDrafts reviewId="A">
        <DraftInput />
      </ReviewDrafts>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(reads).toBe(2);
    await act(async () => {
      releaseFirst(
        response({ version: 1, forms: { 'new:file:1': { body: 'slow result', context: {} } } }),
      );
    });
    expect(screen.getByRole('textbox')).toHaveValue('slow result');
    view.unmount();
    await act(async () => {
      releaseSecond(response({ version: 1, forms: {} }));
    });
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
