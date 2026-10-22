import type { ReviewSubject } from '../server/review-store.js';
export function reviewIntroduction(subject: ReviewSubject, base: string, head: string) {
  return `Review for ${subject.repository}\nBranch: ${subject.branch}\n${subject.pullRequest ? `Pull request: #${subject.pullRequest.number} ${subject.pullRequest.url}\nGitHub target: ${subject.pullRequest.base}\nPublished PR head: ${subject.pullRequest.head}` : 'No pull request yet'}\nComparison base: ${subject.base ?? 'Selected comparison'} ${subject.baseHead ?? base}\nReviewed head: ${subject.head}\nComparison target: ${head}\nUnpublished commits: ${subject.unpublished ? 'yes' : 'no'}\nUncommitted work: ${subject.working ? 'yes' : 'no'}\n\n`;
}
