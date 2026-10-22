import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
