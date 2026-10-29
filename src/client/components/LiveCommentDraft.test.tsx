import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommentThread, DiffFile } from '../../types/diff';
import {
  InlineCommentThreadCard,
  LineCommentForm,
  LiveCommentDraftProvider,
  useCommentingLine,
} from './LiveCommentDraft';
import { ReviewScrollContainer } from './ReviewScrollContainer';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const thread: CommentThread = {
    id: 'thread',
    file: 'long.txt',
    line: 80,
    side: 'new',
    createdAt: '2026-10-29T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z',
    messages: [
      {
        id: 'root',
        body: 'Saved root',
        author: 'User',
        createdAt: '2026-10-29T12:00:00Z',
        updatedAt: '2026-10-29T12:00:00Z',
      },
    ],
  };
  const file: DiffFile = {
    path: 'long.txt',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [],
  };
  const handlers = {
    onGenerateThreadPrompt: vi.fn(),
    onRemoveThread: vi.fn(),
    onReplyToThread: vi.fn(async () => {}),
    onRemoveMessage: vi.fn(),
    onUpdateMessage: vi.fn(),
  };
  const card = {
    thread,
    onGeneratePrompt: handlers.onGenerateThreadPrompt,
    onRemoveThread: handlers.onRemoveThread,
    onReplyToThread: handlers.onReplyToThread,
    onRemoveMessage: handlers.onRemoveMessage,
    onUpdateMessage: handlers.onUpdateMessage,
  };
  return { thread, file, handlers, card };
}

it('keeps the exact reply editor and keyboard state when its row moves to another hunk', () => {
  const { thread, file, handlers, card } = fixture();
  const view = (moved: boolean) => (
    <LiveCommentDraftProvider
      file={file}
      chunks={[]}
      onAddComment={vi.fn()}
      syntaxTheme="github-dark"
      diffMode="split"
      threads={[thread]}
      {...handlers}
    >
      <div key={moved ? 'new-hunk' : 'original-hunk'}>
        <InlineCommentThreadCard {...card} />
      </div>
    </LiveCommentDraftProvider>
  );
  const rendered = render(view(false));
  fireEvent.click(screen.getByText('Write a reply...'));
  const editor = screen.getByPlaceholderText<HTMLTextAreaElement>('Write a reply...');
  fireEvent.change(editor, { target: { value: 'unfinished reply' } });
  editor.focus();
  editor.setSelectionRange(3, 8);
  rendered.rerender(view(true));
  expect(screen.getByPlaceholderText('Write a reply...')).toBe(editor);
  expect(editor).toHaveValue('unfinished reply');
  expect(editor).toHaveFocus();
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 8]);
});

it.each([false, true])(
  'retains the reply viewport through an inert overflow ancestor (native layout owner: %s)',
  (nativeLayoutOwner) => {
    const { thread, file, handlers, card } = fixture();
    const containerRef = createRef<HTMLElement>();
    const view = (moved: boolean, expanded = false, unrelated = 0) => {
      const children = (
        <div data-inert-overflow style={{ overflowY: 'auto' }}>
          <LiveCommentDraftProvider
            file={file}
            chunks={[]}
            onAddComment={vi.fn()}
            syntaxTheme="github-dark"
            diffMode="split"
            threads={[thread]}
            {...handlers}
          >
            <section data-layout-offset={expanded ? 250 : 0} title={String(unrelated)}>
              <div key={moved ? 'new-hunk' : 'original-hunk'} data-slot-top={moved ? 800 : 500}>
                <InlineCommentThreadCard {...card} />
              </div>
            </section>
          </LiveCommentDraftProvider>
        </div>
      );
      return nativeLayoutOwner ? (
        <ReviewScrollContainer
          containerRef={containerRef}
          className="overflow-y-auto"
          aria-busy={false}
        >
          {children}
        </ReviewScrollContainer>
      ) : (
        <main ref={containerRef} style={{ overflowY: 'auto' }}>
          {children}
        </main>
      );
    };
    const rendered = render(view(false));
    const container = containerRef.current;
    const inert = rendered.container.querySelector('[data-inert-overflow]');
    if (!container || !inert) throw new Error('Missing native scroll fixture');
    Object.defineProperties(container, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2000 },
    });
    Object.defineProperties(inert, {
      clientHeight: { value: 1000 },
      scrollHeight: { value: 1000 },
    });
    // The shared test setup supplies only getPropertyValue; model the actual
    // native scroll styles for this geometry regression.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = document.createElement('div').style;
      style.overflowY = element === container || element === inert ? 'auto' : 'visible';
      return style;
    });
    container.scrollTop = 300;
    fireEvent.click(screen.getByText('Write a reply...'));
    const editor = screen.getByPlaceholderText<HTMLTextAreaElement>('Write a reply...');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const slot = this.closest<HTMLElement>('[data-slot-top]');
        const layout = this.closest<HTMLElement>('[data-layout-offset]');
        if (!slot || !layout) return new DOMRect();
        return new DOMRect(
          0,
          Number(slot?.dataset.slotTop) +
            Number(layout?.dataset.layoutOffset) -
            container.scrollTop,
          200,
          80,
        );
      },
    );
    fireEvent.change(editor, { target: { value: 'unfinished reply' } });
    editor.focus();
    editor.setSelectionRange(3, 8);
    const top = () => editor.getBoundingClientRect().top;
    expect(top()).toBe(200);
    rendered.rerender(view(true));
    expect(top()).toBe(200);
    expect(inert.scrollTop).toBe(0);
    expect(container.scrollTop).toBe(600);
    if (nativeLayoutOwner) {
      // Expanded context arrives in a later commit, with the same thread slot.
      rendered.rerender(view(true, true));
      expect(top()).toBe(200);
      expect(container.scrollTop).toBe(850);
      // Sample the user's current reading position instead of snapping back to
      // the old portal position on an unrelated update.
      container.scrollTop = 900;
      rendered.rerender(view(true, true, 1));
      expect(top()).toBe(150);
      expect(container.scrollTop).toBe(900);
    }
    expect(screen.getByPlaceholderText('Write a reply...')).toBe(editor);
    expect(editor).toHaveValue('unfinished reply');
    expect(editor).toHaveFocus();
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 8]);
  },
);

it('skips closed saved threads for a blurred new draft and prefers the focused editor', () => {
  const { thread, file, handlers, card } = fixture();
  const secondThread = { ...thread, id: 'second-thread' };
  const chunks: DiffFile['chunks'] = [
    {
      header: '@@ -80 +80 @@',
      oldStart: 80,
      oldLines: 1,
      newStart: 80,
      newLines: 1,
      lines: [
        {
          type: 'context',
          content: 'review anchor eighty',
          oldLineNumber: 80,
          newLineNumber: 80,
        },
      ],
    },
  ];
  const containerRef = createRef<HTMLElement>();
  function NewDraftSlot() {
    const [selection, setSelection] = useCommentingLine();
    return (
      <>
        <button onClick={() => setSelection({ side: 'new', lineNumber: 80 })}>New comment</button>
        {selection && (
          <LineCommentForm onSubmit={async () => {}} onCancel={() => setSelection(null)} />
        )}
      </>
    );
  }
  const view = (expansion: number) => (
    <ReviewScrollContainer
      containerRef={containerRef}
      className="overflow-y-auto"
      aria-busy={false}
    >
      <button>Toolbar</button>
      <LiveCommentDraftProvider
        file={file}
        chunks={chunks}
        onAddComment={vi.fn(async () => {})}
        syntaxTheme="github-dark"
        diffMode="split"
        threads={[thread, secondThread]}
        {...handlers}
      >
        <div data-editor-top={100}>
          <InlineCommentThreadCard {...card} />
        </div>
        <div data-editor-top={200}>
          <InlineCommentThreadCard {...card} thread={secondThread} />
        </div>
        <div data-editor-top={500 + expansion}>
          <NewDraftSlot />
        </div>
      </LiveCommentDraftProvider>
    </ReviewScrollContainer>
  );
  const rendered = render(view(0));
  const container = containerRef.current;
  if (!container) throw new Error('Missing native scroll owner');
  container.scrollTop = 300;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const slot = this.closest<HTMLElement>('[data-editor-top]');
      return slot
        ? new DOMRect(0, Number(slot.dataset.editorTop) - container.scrollTop, 200, 80)
        : new DOMRect();
    },
  );
  fireEvent.click(screen.getByText('New comment'));
  const editor = screen.getByPlaceholderText<HTMLTextAreaElement>('Leave a comment...');
  fireEvent.change(editor, { target: { value: 'unfinished new comment' } });
  editor.focus();
  editor.setSelectionRange(3, 8);
  const toolbar = screen.getByText('Toolbar');
  toolbar.focus();
  const marked = container.querySelectorAll('[data-live-comment-editor]');
  expect(marked).toHaveLength(3);
  expect(marked[0]?.querySelector('textarea, form')).toBeNull();
  expect(marked[1]?.querySelector('textarea, form')).toBeNull();
  expect(editor.getBoundingClientRect().top).toBe(200);
  rendered.rerender(view(250));
  expect(editor.getBoundingClientRect().top).toBe(200);
  expect(container.scrollTop).toBe(550);
  expect(toolbar).toHaveFocus();
  expect(screen.getByPlaceholderText('Leave a comment...')).toBe(editor);
  expect(editor).toHaveValue('unfinished new comment');
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 8]);

  // An earlier saved thread can also have a reply editor. Preserve the active
  // new-comment editor rather than choosing the first available form.
  const firstReply = screen.getAllByText('Write a reply...')[0];
  if (!firstReply) throw new Error('Missing saved-thread reply control');
  fireEvent.click(firstReply);
  editor.focus();
  rendered.rerender(view(350));
  expect(editor.getBoundingClientRect().top).toBe(200);
  expect(container.scrollTop).toBe(650);
  expect(editor).toHaveFocus();
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 8]);
});
