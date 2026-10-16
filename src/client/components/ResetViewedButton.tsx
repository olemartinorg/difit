import { RotateCcw } from 'lucide-react';

export function ResetViewedButton({
  onReset,
  disabled,
}: {
  onReset: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onReset}
      disabled={disabled}
      title="Reset viewed files"
      aria-label="Reset viewed files"
      className="inline-flex align-middle ml-1 p-1 rounded text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary disabled:opacity-50"
    >
      <RotateCcw size={13} />
    </button>
  );
}
