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

/** Rechecked before and after live reads, and immediately before submission. */
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
  if (branch.trim() !== subject.checkout.branch || head.trim() !== subject.checkout.head)
    throw new Error('The checkout changed. The captured review and notes have been kept.');
}
