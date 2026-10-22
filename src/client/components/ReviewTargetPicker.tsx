import { ChevronDown, Check } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ReviewTarget } from '../../types/review';
import { useClickOutside } from '../hooks/useClickOutside';

interface ReviewTargetPickerProps {
  targets: ReviewTarget[];
  target?: string;
  disabled: boolean;
  onChange: (target: string) => void;
}

export function ReviewTargetPicker({
  targets,
  target,
  disabled,
  onChange,
}: ReviewTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReviewTarget['kind']>('remote');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(20);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useClickOutside(containerRef, () => setOpen(false), open);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const kinds = (['remote', 'local'] as const).filter((candidate) =>
    targets.some((option) => option.kind === candidate),
  );
  const matches = useMemo(
    () =>
      targets
        .filter(
          (option) =>
            option.kind === kind &&
            `${option.name} ${option.label ?? ''}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .sort(
          (left, right) =>
            Number(right.name === target) - Number(left.name === target) ||
            left.name.localeCompare(right.name),
        ),
    [targets, kind, query, target],
  );

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const choose = (name: string) => {
    onChange(name);
    close();
  };

  return (
    <div ref={containerRef} className="contents">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Target branch"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        title={target}
        className="flex min-w-0 max-w-[min(260px,50vw)] items-center gap-2 justify-self-end rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary disabled:opacity-50"
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setKind(targets.find((option) => option.name === target)?.kind ?? kinds[0] ?? 'remote');
          setQuery('');
          setVisible(20);
          setOpen(true);
        }}
      >
        <span className="text-github-text-muted">Target</span>
        <span className="truncate">
          {targets.find((option) => option.name === target)?.label ?? target ?? 'Choose branch'}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div
          id={id}
          className="col-span-2 rounded border border-github-border bg-github-bg-primary p-2"
          aria-label="Target branches"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="search"
              aria-label="Search target branches"
              placeholder="Find branch…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisible(20);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && matches[0]) {
                  event.preventDefault();
                  choose(matches[0].name);
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  containerRef.current
                    ?.querySelector<HTMLButtonElement>('[data-target-option]')
                    ?.focus();
                }
              }}
              className="min-w-0 flex-1 rounded border border-github-border bg-github-bg-secondary px-2 py-1.5 text-xs text-github-text-primary"
            />
            {kinds.length > 1 && (
              <div className="flex gap-1" aria-label="Branch location">
                {kinds.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={kind === candidate}
                    className={`rounded px-2 py-1.5 text-xs ${kind === candidate ? 'bg-github-bg-tertiary text-github-text-primary' : 'text-github-text-muted'}`}
                    onClick={() => {
                      setKind(candidate);
                      setVisible(20);
                      inputRef.current?.focus();
                    }}
                  >
                    {candidate === 'remote' ? 'Remote' : 'Local'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ul className="mt-2 max-h-48 overflow-y-auto">
            {matches.slice(0, visible).map((option) => (
              <li key={option.name}>
                <button
                  type="button"
                  data-target-option={option.name}
                  aria-pressed={option.name === target}
                  title={option.name}
                  onClick={() => choose(option.name)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-github-text-primary hover:bg-github-bg-tertiary"
                >
                  <span className="min-w-0 flex-1 truncate">{option.label ?? option.name}</span>
                  {option.name === target && <Check size={12} className="shrink-0" />}
                </button>
              </li>
            ))}
          </ul>
          {!matches.length && (
            <p className="px-2 py-1.5 text-xs text-github-text-muted">No branches</p>
          )}
          {matches.length > visible && (
            <button
              type="button"
              className="px-2 py-1.5 text-xs text-github-text-secondary"
              onClick={() => setVisible((count) => count + 20)}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
