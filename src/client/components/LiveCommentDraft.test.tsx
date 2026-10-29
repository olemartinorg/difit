import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { CommentThread, DiffFile } from '../../types/diff';
import { InlineCommentThreadCard, LiveCommentDraftProvider } from './LiveCommentDraft';

it('keeps the exact reply editor and keyboard state when its row moves to another hunk', () => {
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
