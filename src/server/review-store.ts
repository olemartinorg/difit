import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { DiffCommentThread } from '../types/diff.js';
import type {
  ReviewSubmission,
  ReviewSubject,
  ReviewDeliveryReceipt,
  SubmittedReview,
} from '../types/reviewSubmission.js';

export interface ReviewRecord {
  id: string;
  subject: ReviewSubject;
  anchor: string;
  version: number;
  threads: DiffCommentThread[];
  forms: Record<string, { body: string; context: unknown }>;
  submissions: ReviewSubmission[];
  appliedWriteIds: string[];
}
interface ReviewFile {
  version: 1;
  owner: string;
  reviews: ReviewRecord[];
  unassigned: Record<string, DiffCommentThread[]>;
  assignedImports: Record<string, string>;
  receipts: Record<string, ReviewDeliveryReceipt>;
}

/** One repository process owns writes. Every accepted write reaches disk before publication. */
export class ReviewStore {
  private state: ReviewFile;
  readonly path: string;
  constructor(directory: string, owner: string) {
    this.path = join(directory, 'reviews.json');
    this.state = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as ReviewFile)
      : { version: 1, owner, reviews: [], unassigned: {}, assignedImports: {}, receipts: {} };
    if (
      this.state.version !== 1 ||
      this.state.owner !== owner ||
      !Array.isArray(this.state.reviews)
    )
      throw new Error('Review storage owner or format does not match this repository');
  }
  private write(change: (state: ReviewFile) => void) {
    const next = structuredClone(this.state);
    change(next);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(next)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state = next;
  }
  get(id: string): ReviewRecord {
    const review = this.state.reviews.find((value) => value.id === id);
    if (!review) throw new Error('Unknown review');
    return structuredClone(review);
  }
  async resolve(repoPath: string, subject: ReviewSubject): Promise<ReviewRecord> {
    const git = simpleGit(repoPath);
    const head = (await git.revparse([`${subject.head}^{commit}`])).trim();
    const pullRequest = subject.pullRequest?.url;
    const authoritative = pullRequest
      ? this.state.reviews.find((review) => review.subject.pullRequest?.url === pullRequest)
      : undefined;
    const candidates = authoritative ? [authoritative] : this.state.reviews;
    for (const review of candidates) {
      // A PR remains the same change after a rebase or force-push. A branch name
      // cannot bridge two known PR identities, even when their commits descend.
      if (review !== authoritative) {
        if (review.subject.branch !== subject.branch) continue;
        if (pullRequest && review.subject.pullRequest?.url) continue;
        const common = await git.raw(['merge-base', review.anchor, head]).then(
          (value) => value.trim(),
          () => '',
        );
        const related = review.anchor === head || common === review.anchor || common === head;
        if (!related) continue;
      }
      this.write((state) => {
        const current = state.reviews.find((value) => value.id === review.id);
        if (!current) throw new Error('Unknown review');
        current.subject = { ...subject, head };
      });
      return this.get(review.id);
    }
    const review: ReviewRecord = {
      id: randomUUID(),
      subject: { ...subject, head },
      anchor: head,
      version: 0,
      threads: [],
      forms: {},
      submissions: [],
      appliedWriteIds: [],
    };
    this.write((state) => {
      state.reviews.push(review);
    });
    return this.get(review.id);
  }
  patch(
    id: string,
    operations: Array<{
      kind: 'thread' | 'message' | 'form';
      id: string;
      threadId?: string;
      value: unknown;
    }>,
    writeId: string = randomUUID(),
  ): ReviewRecord {
    if (this.get(id).appliedWriteIds.includes(writeId)) return this.get(id);
    this.write((state) => {
      const review = state.reviews.find((value) => value.id === id);
      if (!review) throw new Error('Unknown review');
      for (const operation of operations) {
        if (operation.kind === 'form') {
          if (operation.value === null) delete review.forms[operation.id];
          else review.forms[operation.id] = operation.value as ReviewRecord['forms'][string];
        } else if (operation.kind === 'thread') {
          const index = review.threads.findIndex((thread) => thread.id === operation.id);
          if (operation.value === null) {
            if (index >= 0) review.threads.splice(index, 1);
          } else if (index < 0) review.threads.push(operation.value as DiffCommentThread);
          // Existing thread context is immutable. Comment/reply edits address their message ID.
        } else {
          const thread = review.threads.find((value) => value.id === operation.threadId);
          if (!thread) throw new Error('Unknown comment thread');
          const index = thread.messages.findIndex((message) => message.id === operation.id);
          if (operation.value === null) {
            if (index >= 0) thread.messages.splice(index, 1);
          } else if (index < 0)
            thread.messages.push(operation.value as DiffCommentThread['messages'][number]);
          else thread.messages[index] = operation.value as DiffCommentThread['messages'][number];
        }
      }
      review.appliedWriteIds.push(writeId);
      review.version++;
    });
    return this.get(id);
  }
  imported(importId: string) {
    const retained = this.state.unassigned[importId];
    return retained
      ? {
          importId,
          count: retained.length,
          messageCount: retained.reduce((count, thread) => count + thread.messages.length, 0),
        }
      : null;
  }
  importUnassigned(threads: DiffCommentThread[], importId: string) {
    if (!this.state.unassigned[importId])
      this.write((state) => {
        state.unassigned[importId] = structuredClone(threads);
      });
    const retained = this.state.unassigned[importId];
    if (!retained) throw new Error('Historical import was not retained');
    if (JSON.stringify(retained) !== JSON.stringify(threads))
      throw new Error('Historical comment import changed');
    return {
      importId,
      count: retained.length,
      messageCount: retained.reduce((count, thread) => count + thread.messages.length, 0),
    };
  }
  unassigned() {
    return structuredClone(
      Object.fromEntries(
        Object.entries(this.state.unassigned).filter(([id]) => !this.state.assignedImports[id]),
      ),
    );
  }
  assign(importId: string, reviewId: string) {
    if (this.state.assignedImports[importId] && this.state.assignedImports[importId] !== reviewId)
      throw new Error('Historical import is already assigned to another review');
    const threads = this.state.unassigned[importId];
    if (!threads) throw new Error('Unknown historical import');
    const review = this.get(reviewId);
    const operations = threads
      .filter((thread) => !review.threads.some((existing) => existing.id === thread.id))
      .map((thread) => ({ kind: 'thread' as const, id: thread.id, value: thread }));
    this.patch(reviewId, operations);
    this.write((state) => {
      state.assignedImports[importId] = reviewId;
    });
    // Originals deliberately remain until the owner disposes of historical records.
  }
  submit(id: string, submission: ReviewSubmission) {
    this.write((state) => {
      const review = state.reviews.find((value) => value.id === id);
      if (!review) throw new Error('Unknown review');
      if (
        state.reviews.some((value) =>
          value.submissions.some((snapshot) => snapshot.id === submission.id),
        )
      )
        throw new Error('Submission ID already exists');
      review.submissions.push(structuredClone(submission));
      state.receipts[submission.id] = { outcome: 'submitted' };
    });
  }
  receipt(id: string, receipt: ReviewFile['receipts'][string]) {
    if (
      !this.state.reviews.some((review) =>
        review.submissions.some((submission) => submission.id === id),
      )
    )
      throw new Error('Unknown submission');
    this.write((state) => {
      state.receipts[id] = receipt;
    });
  }
  submitted(id?: string): SubmittedReview[] {
    return this.state.reviews.flatMap((review) =>
      review.submissions
        .filter((submission) => !id || submission.id === id)
        .map((submission) => {
          const receipt = this.state.receipts[submission.id];
          if (!receipt) throw new Error('Submitted review has no delivery receipt');
          return { ...structuredClone(submission), receipt: structuredClone(receipt) };
        }),
    );
  }
}
