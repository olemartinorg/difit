import type { DiffCommentThread } from '../../types/diff';
export type CommentOperation = {
  kind: 'thread' | 'message' | 'form';
  id: string;
  threadId?: string;
  value: unknown;
};
export function commentOperations(
  previous: DiffCommentThread[],
  next: DiffCommentThread[],
): CommentOperation[] {
  const operations: CommentOperation[] = [];
  for (const thread of previous)
    if (!next.some((value) => value.id === thread.id))
      operations.push({ kind: 'thread', id: thread.id, value: null });
  for (const thread of next) {
    const old = previous.find((value) => value.id === thread.id);
    if (!old) {
      operations.push({ kind: 'thread', id: thread.id, value: thread });
      continue;
    }
    for (const message of old.messages)
      if (!thread.messages.some((value) => value.id === message.id))
        operations.push({ kind: 'message', id: message.id, threadId: thread.id, value: null });
    for (const message of thread.messages)
      if (
        JSON.stringify(message) !==
        JSON.stringify(old.messages.find((value) => value.id === message.id))
      )
        operations.push({ kind: 'message', id: message.id, threadId: thread.id, value: message });
  }
  return operations;
}
