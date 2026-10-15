export function ReviewResetSection({
  onReset,
  disabled,
  error,
}: {
  onReset: () => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onReset}
        disabled={disabled}
        title="Clear comments and viewed marks for this comparison"
        className="rounded border border-github-border px-3 py-2 text-sm text-github-danger hover:bg-github-bg-tertiary disabled:opacity-50"
      >
        Reset current review
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-github-danger">
          {error}
        </p>
      )}
    </div>
  );
}
