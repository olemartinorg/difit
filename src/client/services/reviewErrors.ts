// The embedded Review bridge has no diagnostics IPC. Use browser diagnostics,
// allowing only known transport details; arbitrary causes may contain review text or URLs.
export function reportReviewError(operation: string, cause: unknown): void {
  const name =
    cause instanceof Error &&
    ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'NetworkError'].includes(cause.name)
      ? cause.name
      : 'UnknownError';
  const message =
    cause instanceof Error &&
    (['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(
      cause.message,
    ) ||
      /^Review request failed \(HTTP [1-5]\d{2}\)$/.test(cause.message))
      ? cause.message
      : 'Failure details omitted to protect review content.';
  console.error('Review request failed:', { operation, name, message });
}
