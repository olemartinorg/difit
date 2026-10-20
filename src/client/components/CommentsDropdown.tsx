import { Copy, Eraser, ChevronDown, Check, List, Send } from 'lucide-react';
import { useState, useRef } from 'react';

import { useClickOutside } from '../hooks/useClickOutside';

interface CommentsDropdownProps {
  commentsCount: number;
  isCopiedAll: boolean;
  onCopyAll: () => void;
  onPassToAgent?: () => void;
  copyPending?: boolean;
  isCopiedToClipboard?: boolean;
  onDeleteAll: () => void;
  onViewAll?: () => void;
  direction?: 'down' | 'up';
  compact?: boolean;
  handoff?: boolean;
  pending?: boolean;
  disabled?: boolean;
}

export function CommentsDropdown({
  commentsCount,
  isCopiedAll,
  onCopyAll,
  onPassToAgent,
  copyPending = false,
  isCopiedToClipboard = false,
  onDeleteAll,
  onViewAll,
  direction = 'down',
  compact = false,
  handoff = false,
  pending = false,
  disabled = false,
}: CommentsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isCompact = compact;
  const isUp = direction === 'up';

  useClickOutside(dropdownRef, () => setIsOpen(false));

  const handleExport = () => {
    if (handoff) onPassToAgent?.();
    else onCopyAll();
    setIsOpen(false);
  };

  const handleDeleteAll = () => {
    onDeleteAll();
    setIsOpen(false);
  };

  const handleViewAll = () => {
    onViewAll?.();
    setIsOpen(false);
  };

  const copyLabel = pending
    ? handoff
      ? 'Waiting for agent…'
      : 'Copying…'
    : handoff
      ? isCopiedAll
        ? 'Sent to agent'
        : 'Pass review to agent'
      : isCompact
        ? isCopiedAll
          ? 'Copied'
          : `Copy All (${commentsCount})`
        : isCopiedAll
          ? 'Copied All!'
          : `Copy All Prompt (${commentsCount})`;

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex">
        <button
          onClick={handleExport}
          disabled={disabled || pending}
          className={`text-xs px-3 py-1.5 pr-2 rounded-l transition-all flex items-center gap-1.5 ${
            isCompact ? 'whitespace-normal' : 'whitespace-nowrap'
          }`}
          style={{
            backgroundColor: 'var(--color-yellow-btn-bg)',
            color: 'var(--color-yellow-btn-text)',
            border: '1px solid var(--color-yellow-btn-border)',
            borderRight: 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-hover-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-hover-border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-border)';
          }}
          title={
            handoff
              ? 'Pass review to agent'
              : `Copy all ${commentsCount} comments to AI coding agent`
          }
        >
          {isCopiedAll ? <Check size={12} /> : handoff ? <Send size={12} /> : <Copy size={12} />}
          {copyLabel}
        </button>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="text-xs px-2 py-1.5 rounded-r transition-all flex items-center border-l"
          style={{
            backgroundColor: 'var(--color-yellow-btn-bg)',
            color: 'var(--color-yellow-btn-text)',
            borderTop: '1px solid var(--color-yellow-btn-border)',
            borderRight: '1px solid var(--color-yellow-btn-border)',
            borderBottom: '1px solid var(--color-yellow-btn-border)',
            borderLeft: '1px solid var(--color-yellow-btn-border)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-hover-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-hover-border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-border)';
          }}
          title="More options"
        >
          <ChevronDown
            size={12}
            className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {isOpen && (
        <div
          className={`absolute left-0 right-0 bg-github-bg-primary border border-github-border z-50 pb-px ${
            isUp ? 'bottom-full rounded-t' : 'top-full rounded-b'
          }`}
          style={{
            borderTop: isUp ? undefined : 'none',
            borderBottom: isUp ? 'none' : undefined,
          }}
        >
          {handoff && (
            <button
              onClick={() => {
                onCopyAll();
                setIsOpen(false);
              }}
              disabled={disabled || copyPending}
              className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-github-text-primary hover:bg-github-bg-tertiary transition-colors"
            >
              {isCopiedToClipboard ? <Check size={12} /> : <Copy size={12} />}
              {isCopiedToClipboard ? 'Copied All!' : `Copy All Prompt (${commentsCount})`}
            </button>
          )}
          {onViewAll && (
            <button
              onClick={handleViewAll}
              className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-github-text-primary hover:bg-github-bg-tertiary transition-colors"
              disabled={commentsCount === 0}
            >
              <List size={12} />
              View All Comments
            </button>
          )}
          <button
            onClick={handleDeleteAll}
            className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-github-text-primary hover:bg-github-bg-tertiary transition-colors"
          >
            <Eraser size={12} />
            Cleanup All Prompt
          </button>
        </div>
      )}
    </div>
  );
}
