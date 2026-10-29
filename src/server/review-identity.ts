import { simpleGit } from 'simple-git';
import type { ReviewSubject } from '../types/reviewSubmission.js';

/** Source identity is independent of checkout paths and optional PR metadata. */
export async function branchSource(repoPath: string, repository: string): Promise<string> {
  const git = simpleGit(repoPath);
  const branch = (
    await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  ).trim();
  const configured = async (key: string) =>
    (await git.raw(['config', '--get', key]).catch(() => '')).trim();
  const name =
    (branch && (await configured(`branch.${branch}.pushRemote`))) ||
    (await configured('remote.pushDefault')) ||
    (branch && (await configured(`branch.${branch}.remote`))) ||
    'origin';
  const remote = await git.raw(['remote', 'get-url', '--push', name]).catch(() => '');
  try {
    const url = new URL(remote.trim().replace(/^([^/@:]+@)?([^/:]+):([^/].*)$/, 'ssh://$1$2/$3'));
    const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    if (!url.hostname || !path || path === '/') return `local:${repository}`;
    return url.hostname.toLowerCase() === 'github.com'
      ? path.slice(1).toLowerCase()
      : `git:${url.host.toLowerCase()}${path}`;
  } catch {
    return `local:${repository}`;
  }
}

export class ReviewReadChangedError extends Error {
  readonly code = 'REVIEW_READ_CHANGED';
}

/** Admit a new read of the same logical branch at its current revision. */
export async function admitReviewCheckout(
  repoPath: string,
  subject?: ReviewSubject,
): Promise<ReviewSubject | undefined> {
  if (!subject?.checkout) return subject;
  const git = simpleGit(repoPath);
  const branch = (
    await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  ).trim();
  if (branch !== subject.checkout.branch)
    throw new Error(
      'The checkout changed to another branch. Your captured review and notes have been kept.',
    );
  const head = (await git.revparse(['HEAD'])).trim();
  const admitted = { ...subject, head, checkout: { branch, head } };
  await assertReviewCheckout(repoPath, admitted);
  return admitted;
}

/** Verify the revision admitted for this read, or the displayed submission. */
export async function assertReviewCheckout(
  repoPath: string,
  subject?: ReviewSubject,
): Promise<void> {
  if (!subject?.checkout) return;
  const git = simpleGit(repoPath);
  const [branch, head] = await Promise.all([
    git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git.revparse(['HEAD']),
  ]);
  if (branch.trim() !== subject.checkout.branch)
    throw new Error(
      'The checkout changed to another branch. Your captured review and notes have been kept.',
    );
  if (head.trim() !== subject.checkout.head)
    throw new ReviewReadChangedError(
      'The checkout changed during this read. Refresh to read the current branch.',
    );
}
