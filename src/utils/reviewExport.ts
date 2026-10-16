export interface ReviewSettings {
  autoRefresh: boolean;
}

export function normalizeReviewSettings(value: unknown): ReviewSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ReviewSettings>;
  return { autoRefresh: typeof raw.autoRefresh === 'boolean' ? raw.autoRefresh : true };
}
