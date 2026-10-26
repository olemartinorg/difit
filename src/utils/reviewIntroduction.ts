import type { ReviewSubject } from '../types/reviewSubmission.js';
export function reviewIntroduction(subject: ReviewSubject) {
  return `Review for ${subject.repository}, branch ${subject.branch}${subject.pullRequest ? `, PR #${subject.pullRequest.number}` : ''}\n\n`;
}
