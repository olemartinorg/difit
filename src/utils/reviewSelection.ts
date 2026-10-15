import type { DiffSelection } from '../types/diff.js';
import type { ReviewInventory, ReviewRange } from '../types/review.js';

export const WORKTREE_REVIEW_ID = 'worktree';

export function getEmptyReviewSelection(head: string): DiffSelection {
  // Both expressions resolve to the same commit without changing upstream's
  // validation, which rejects identical input strings.
  return { baseCommitish: head, targetCommitish: `${head}^0` };
}

function rangeAt(units: string[], start: number, end: number): ReviewRange | null {
  const oldest = units[start],
    newest = units[end];
  return oldest && newest ? { oldest, newest } : null;
}

export function getReviewUnits(inventory: ReviewInventory): string[] {
  const units = inventory.commits.map((commit) => commit.hash).reverse();
  if (inventory.uncommitted) units.push(WORKTREE_REVIEW_ID);
  return units;
}

export function getSelectedReviewUnits(units: string[], range: ReviewRange | null): string[] {
  if (!range) return [];
  const start = units.indexOf(range.oldest);
  const end = units.indexOf(range.newest);
  return start < 0 || end < start ? [] : units.slice(start, end + 1);
}

export function getDefaultReviewRange(inventory: ReviewInventory): ReviewRange | null {
  const local = new Set(inventory.commits.filter((commit) => !commit.pushed).map((c) => c.hash));
  const selected = getReviewUnits(inventory).filter(
    (unit) => unit === WORKTREE_REVIEW_ID || local.has(unit),
  );
  return rangeAt(selected, 0, selected.length - 1);
}

export function toggleReviewRange(
  units: string[],
  range: ReviewRange | null,
  ids: string[],
  only = false,
): ReviewRange | null {
  const positions = ids.map((id) => units.indexOf(id)).filter((index) => index >= 0);
  if (!positions.length) return range;
  const first = Math.min(...positions);
  const last = Math.max(...positions);
  const start = range ? units.indexOf(range.oldest) : -1;
  const end = range ? units.indexOf(range.newest) : -1;
  if (only || start < 0 || end < start) {
    return rangeAt(units, first, last);
  }
  if (first >= start && last <= end) {
    if (first === start && last === end) return null;
    if (last === end) return rangeAt(units, start, first - 1);
    return rangeAt(units, last + 1, end);
  }
  return rangeAt(units, Math.min(first, start), Math.max(last, end));
}

export function resolveReviewRange(
  inventory: ReviewInventory,
  range: ReviewRange | null,
): DiffSelection | null {
  const selected = getSelectedReviewUnits(getReviewUnits(inventory), range);
  if (!selected.length) return null;
  const oldest = inventory.commits.find((commit) => commit.hash === selected[0]);
  const allCommitsSelected = inventory.commits.every((commit) => selected.includes(commit.hash));
  return {
    baseCommitish: oldest
      ? allCommitsSelected && inventory.target
        ? inventory.branchBase
        : oldest.parent
      : inventory.head,
    targetCommitish:
      selected[selected.length - 1] === WORKTREE_REVIEW_ID
        ? '.'
        : (selected[selected.length - 1] ?? inventory.head),
    ...(selected.includes(WORKTREE_REVIEW_ID) ? { includeUntracked: true } : {}),
  };
}

export function reconcileReviewRange(
  previous: ReviewInventory,
  next: ReviewInventory,
  range: ReviewRange | null,
): ReviewRange | null {
  if (!range) return null;
  const available = new Set(getReviewUnits(next));
  const remaining = getSelectedReviewUnits(getReviewUnits(previous), range).filter((unit) =>
    available.has(unit),
  );
  return rangeAt(remaining, 0, remaining.length - 1);
}
