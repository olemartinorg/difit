// Every request keeps the subject captured when this view opened. Comparison
// navigation may change its range without changing the logical review.
export function installReviewContext() {
  const context = new URLSearchParams(window.location.search);
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      const url = new URL(input, window.location.origin);
      for (const key of ['reviewBranch', 'reviewSubject', 'reviewId']) {
        const value = context.get(key);
        if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
      }
      if (url.pathname === '/api/diff' && !url.searchParams.has('target'))
        for (const key of ['target', 'base', 'baseMode', 'includeUntracked']) {
          const value = context.get(key);
          if (value) url.searchParams.set(key, value);
        }
      input = `${url.pathname}${url.search}`;
    }
    return original(input, init);
  };
}
