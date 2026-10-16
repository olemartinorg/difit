export interface ReviewSettings {
  autoRefresh: boolean;
  resetViewedAfterExport: boolean;
  clearCommentsAfterExport: boolean;
  template: string;
  separator: string;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  autoRefresh: true,
  resetViewedAfterExport: false,
  clearCommentsAfterExport: false,
  template: '{{review}}',
  separator: '\n=====\n',
};

export function normalizeReviewSettings(value: unknown): ReviewSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ReviewSettings>;
  return {
    autoRefresh: typeof raw.autoRefresh === 'boolean' ? raw.autoRefresh : true,
    resetViewedAfterExport: raw.resetViewedAfterExport === true,
    clearCommentsAfterExport: raw.clearCommentsAfterExport === true,
    template: typeof raw.template === 'string' ? raw.template : DEFAULT_REVIEW_SETTINGS.template,
    separator:
      typeof raw.separator === 'string' ? raw.separator : DEFAULT_REVIEW_SETTINGS.separator,
  };
}

export function formatReviewExport(review: string, template: string): string {
  if (!template.includes('{{review}}'))
    throw new Error('The review template must contain {{review}}.');
  const lines = template.split('\n');
  // Keep a template's outer fence valid when comments contain their own code blocks.
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i]?.trim() !== '{{review}}') continue;
    const opening = /^(\s*)(`{3,}|~{3,})([^`~]*)$/.exec(lines[i - 1] ?? '');
    if (!opening || lines[i + 1]?.trim() !== opening[2]) continue;
    const originalFence = opening[2];
    if (!originalFence) continue;
    const marker = originalFence.startsWith('`') ? '`' : '~';
    const runs = review.match(marker === '`' ? /`+/g : /~+/g) ?? [];
    const length = Math.max(originalFence.length, ...runs.map((run) => run.length + 1));
    const fence = marker.repeat(length);
    lines[i - 1] = `${opening[1]}${fence}${opening[3]}`;
    lines[i + 1] = `${opening[1]}${fence}`;
  }
  return lines.join('\n').split('{{review}}').join(review);
}
