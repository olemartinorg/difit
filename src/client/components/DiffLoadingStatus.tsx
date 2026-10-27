import { LoaderCircle } from 'lucide-react';

export function DiffLoadingStatus() {
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 text-xs text-github-text-secondary"
    >
      <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />
      Updating diff…
    </span>
  );
}
