import { useEffect, useMemo, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';

import { ReviewTargetPicker } from './ReviewTargetPicker';

import type { ReviewCommit, ReviewInventory, ReviewRange, ReviewStats } from '../../types/review';
import {
  getReviewUnits,
  getSelectedReviewUnits,
  WORKTREE_REVIEW_ID,
} from '../../utils/reviewSelection';

function Stats({ stats }: { stats?: ReviewStats }) {
  if (!stats) return <span className="text-github-text-muted text-xs">…</span>;
  return (
    <span className="inline-flex shrink-0 gap-2 font-mono text-xs">
      <span className="text-github-accent">+{stats.additions}</span>
      <span className="text-github-danger">−{stats.deletions}</span>
      {stats.binaryFiles > 0 && (
        <span className="text-github-text-muted">{stats.binaryFiles} binary</span>
      )}
    </span>
  );
}

function relativeTime(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function SelectionCheckbox({
  checked,
  mixed,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={onChange}
      className="size-4 shrink-0 cursor-pointer accent-[var(--color-github-accent)]"
    />
  );
}

function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: ReviewCommit;
  selected: boolean;
  onSelect: (ids: string[], only?: boolean) => void;
}) {
  const [stats, setStats] = useState<ReviewStats>();
  const lastPress = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ base: commit.parent, target: commit.hash });
    void fetch(`/api/review/stats?${params}`, { signal: controller.signal })
      .then(async (response) =>
        response.ok ? ((await response.json()) as ReviewStats) : undefined,
      )
      .then((data) => {
        if (!controller.signal.aborted) setStats(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [commit.hash, commit.parent]);
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-2 hover:bg-github-bg-tertiary"
      data-review-commit={commit.hash}
    >
      <SelectionCheckbox
        checked={selected}
        mixed={false}
        label={`Select ${commit.shortHash} ${commit.message}`}
        onChange={() => onSelect([commit.hash])}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left text-xs"
        title={commit.message}
        onClick={() => {
          const now = Date.now();
          const only = now - lastPress.current < 450;
          lastPress.current = only ? 0 : now;
          onSelect([commit.hash], only);
        }}
      >
        <code className="shrink-0 text-github-text-muted">{commit.shortHash}</code>
        <span className="truncate text-github-text-primary">
          {commit.isMerge ? 'Merge: ' : ''}
          {commit.message}
        </span>
      </button>
      <time
        dateTime={commit.timestamp}
        title={new Date(commit.timestamp).toLocaleString()}
        className="shrink-0 text-xs text-github-text-muted"
      >
        {relativeTime(commit.timestamp)}
      </time>
      <Stats stats={stats} />
      <button
        type="button"
        aria-label={`Show only ${commit.shortHash}`}
        onClick={() => onSelect([commit.hash], true)}
        className="rounded border border-github-border px-1.5 py-0.5 text-xs text-github-text-secondary hover:text-github-text-primary"
      >
        Only
      </button>
    </div>
  );
}

interface ReviewPickerProps {
  inventory: ReviewInventory;
  range: ReviewRange | null;
  active: boolean;
  notice: string;
  error: string | null;
  busy: boolean;
  onSelect: (ids: string[], only?: boolean) => void;
  onTargetChange: (target: string) => void;
  onAdvanced: () => void;
}

export function ReviewPicker({
  inventory,
  range,
  active,
  notice,
  error,
  busy,
  onSelect,
  onTargetChange,
  onAdvanced,
}: ReviewPickerProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState({ local: true, pushed: false });
  const [visible, setVisible] = useState({ local: 20, pushed: 20 });
  const presses = useRef<Record<string, number>>({});
  const selected = useMemo(
    () => new Set(getSelectedReviewUnits(getReviewUnits(inventory), range)),
    [inventory, range],
  );
  const groups = useMemo(
    () =>
      [
        {
          id: 'local' as const,
          label: 'local',
          commits: inventory.commits.filter((c) => !c.pushed),
          stats: inventory.localStats,
        },
        {
          id: 'pushed' as const,
          label: 'pushed',
          commits: inventory.commits.filter((c) => c.pushed),
          stats: inventory.pushedStats,
        },
      ].filter((group) => group.commits.length > 0),
    [inventory],
  );
  useEffect(() => {
    setExpanded((previous) => ({
      local:
        previous.local ||
        groups.some(
          (group) => group.id === 'local' && group.commits.some((c) => selected.has(c.hash)),
        ),
      pushed:
        previous.pushed ||
        groups.some(
          (group) => group.id === 'pushed' && group.commits.some((c) => selected.has(c.hash)),
        ),
    }));
  }, [groups, selected]);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(8), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context),
    dismiss = useDismiss(context),
    role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const count = [...selected].filter((id) => id !== WORKTREE_REVIEW_ID).length;
  const summary = !active
    ? 'Advanced comparison'
    : !selected.size
      ? 'Choose changes to review'
      : [
          count ? `${count} ${count === 1 ? 'commit' : 'commits'}` : '',
          selected.has(WORKTREE_REVIEW_ID) ? 'uncommitted changes' : '',
        ]
          .filter(Boolean)
          .join(' + ');
  const press = (key: string, ids: string[]) => {
    const now = Date.now(),
      only = now - (presses.current[key] ?? 0) < 450;
    presses.current[key] = only ? 0 : now;
    onSelect(ids, only);
  };
  const openAdvanced = () => {
    setOpen(false);
    onAdvanced();
  };
  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps()}
        data-review-picker="true"
        aria-label="Choose changes to review"
        aria-expanded={open}
        className="flex max-w-full items-center gap-2 rounded-md border border-github-border bg-github-bg-tertiary px-3 py-2 text-xs text-github-text-primary hover:border-github-text-muted"
      >
        <GitBranch size={14} />
        <span className="max-w-[250px] truncate">{summary}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={{
                ...floatingStyles,
                width: 'min(620px, calc(100vw - 24px))',
                maxHeight: 'min(700px, calc(100dvh - 40px))',
              }}
              {...getFloatingProps()}
              aria-label="Changes to review"
              data-review-panel="true"
              className="z-50 overflow-y-auto rounded-lg border border-github-border bg-github-bg-secondary p-4 text-github-text-primary shadow-xl"
            >
              <div className="mb-3 grid grid-cols-[1fr_auto] items-center gap-3">
                <span className="text-sm font-semibold">Changes to review</span>
                <ReviewTargetPicker
                  targets={inventory.targetOptions}
                  target={inventory.target}
                  disabled={busy}
                  onChange={onTargetChange}
                />
              </div>
              {inventory.uncommitted && (
                <div
                  className="flex items-center gap-2 border-y border-github-border py-3"
                  data-review-group="uncommitted"
                >
                  <span aria-hidden="true" className="w-[14px] shrink-0" />
                  <SelectionCheckbox
                    checked={selected.has(WORKTREE_REVIEW_ID)}
                    mixed={false}
                    label="Select uncommitted changes"
                    onChange={() => onSelect([WORKTREE_REVIEW_ID])}
                  />
                  <button
                    type="button"
                    className="flex-1 text-left text-sm font-medium"
                    onClick={() => press('worktree', [WORKTREE_REVIEW_ID])}
                  >
                    Uncommitted changes
                  </button>
                  <Stats stats={inventory.uncommitted} />
                  <button
                    type="button"
                    aria-label="Show only uncommitted changes"
                    onClick={() => onSelect([WORKTREE_REVIEW_ID], true)}
                    className="rounded border border-github-border px-1.5 py-0.5 text-xs text-github-text-secondary"
                  >
                    Only
                  </button>
                </div>
              )}
              {groups.map((group) => {
                const ids = group.commits.map((commit) => commit.hash);
                const all = ids.every((id) => selected.has(id)),
                  some = ids.some((id) => selected.has(id));
                return (
                  <section
                    key={group.id}
                    data-review-group={group.id}
                    className="border-b border-github-border py-2"
                  >
                    <div className="flex items-center gap-2 py-2">
                      <button
                        type="button"
                        aria-label={`${expanded[group.id] ? 'Collapse' : 'Expand'} ${group.label} commits`}
                        aria-expanded={expanded[group.id]}
                        onClick={() =>
                          setExpanded((previous) => ({
                            ...previous,
                            [group.id]: !previous[group.id],
                          }))
                        }
                        className="text-github-text-muted"
                      >
                        {expanded[group.id] ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </button>
                      <SelectionCheckbox
                        checked={all}
                        mixed={!all && some}
                        label={`Select ${group.label} commits`}
                        onChange={() => onSelect(ids)}
                      />
                      <button
                        type="button"
                        className="flex-1 text-left text-sm font-medium"
                        onClick={() => press(group.id, ids)}
                      >
                        {ids.length} {group.label} {ids.length === 1 ? 'commit' : 'commits'}
                      </button>
                      <Stats stats={group.stats} />
                      <button
                        type="button"
                        aria-label={`Show only ${group.label} commits`}
                        onClick={() => onSelect(ids, true)}
                        className="rounded border border-github-border px-1.5 py-0.5 text-xs text-github-text-secondary"
                      >
                        Only
                      </button>
                    </div>
                    {expanded[group.id] ? (
                      <div className="pl-5">
                        {group.commits.slice(0, visible[group.id]).map((commit) => (
                          <CommitRow
                            key={commit.hash}
                            commit={commit}
                            selected={selected.has(commit.hash)}
                            onSelect={onSelect}
                          />
                        ))}
                        {visible[group.id] < ids.length && (
                          <button
                            type="button"
                            onClick={() =>
                              setVisible((previous) => ({
                                ...previous,
                                [group.id]: previous[group.id] + 20,
                              }))
                            }
                            className="p-2 text-xs text-github-text-secondary"
                          >
                            Show more commits
                          </button>
                        )}
                      </div>
                    ) : null}
                  </section>
                );
              })}
              {!inventory.uncommitted && groups.length === 0 && (
                <p className="py-5 text-sm text-github-text-secondary">
                  No local changes to review.
                </p>
              )}
              {inventory.stagedOnly && (
                <button
                  type="button"
                  onClick={openAdvanced}
                  className="mt-3 text-xs text-github-text-secondary"
                >
                  Staged changes
                </button>
              )}
              {notice && (
                <span role="status" className="sr-only">
                  {notice}
                </span>
              )}
              {error && (
                <p role="alert" className="mt-2 text-xs text-github-danger">
                  {error}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-github-border pt-3 text-xs text-github-text-secondary">
                <button
                  type="button"
                  onClick={openAdvanced}
                  className="hover:text-github-text-primary"
                >
                  Advanced comparison
                </button>
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
