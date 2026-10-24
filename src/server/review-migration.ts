import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One-time offline conversion. Every record needs an explicit disposition.
 * null preserves a historical record, retrievable by UUID, without live matching.
 * Submitted snapshots and all comment/import identities remain byte-equivalent.
 */
export function migrateBranchReviews(
  directory: string,
  owner: string,
  assignments: Record<string, { sourceRepository: string; branch?: string } | null>,
) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments))
    throw new Error('Review assignments must be an object');
  for (const assigned of Object.values(assignments)) {
    if (assigned === null) continue;
    if (
      !assigned ||
      typeof assigned !== 'object' ||
      Array.isArray(assigned) ||
      Object.keys(assigned).some((key) => !['sourceRepository', 'branch'].includes(key)) ||
      typeof assigned.sourceRepository !== 'string' ||
      !assigned.sourceRepository.trim() ||
      (assigned.branch !== undefined &&
        (typeof assigned.branch !== 'string' || !assigned.branch.trim()))
    )
      throw new Error('Each review needs a source repository assignment or null');
  }
  const path = join(directory, 'reviews.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    owner: string;
    reviews: Array<{ id: string; subject: { branch: string; sourceRepository?: string } }>;
  };
  if (state.version !== 1 || state.owner !== owner || !Array.isArray(state.reviews))
    throw new Error('Migration requires the exact version 1 review owner');
  if (
    Object.keys(assignments).length !== state.reviews.length ||
    state.reviews.some((record) => !Object.hasOwn(assignments, record.id))
  )
    throw new Error('Every review needs an explicit source assignment or unresolved disposition');
  const keys = new Set<string>();
  for (const record of state.reviews) {
    const assigned = assignments[record.id];
    if (!assigned) continue;
    const branch = assigned.branch ?? record.subject.branch;
    if (!assigned.sourceRepository || !branch)
      throw new Error('A resolved review needs its source repository and branch');
    const key = JSON.stringify([assigned.sourceRepository, branch]);
    if (keys.has(key))
      throw new Error(
        'Conflicting old reviews require explicit reconciliation; no records were written',
      );
    keys.add(key);
    record.subject = { ...record.subject, branch, sourceRepository: assigned.sourceRepository };
  }
  state.version = 2;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(state)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return { converted: keys.size, unresolved: state.reviews.length - keys.size };
}
