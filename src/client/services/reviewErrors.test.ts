import { describe, expect, it, vi } from 'vitest';
import { reportReviewError } from './reviewErrors';

describe('safe browser review diagnostics', () => {
  it('retains native fetch and HTTP details without arbitrary content, URLs or stacks', () => {
    vi.mocked(console.error).mockClear();
    reportReviewError('comment refresh', new TypeError('Failed to fetch'));
    reportReviewError('comment bootstrap', new Error('Review request failed (HTTP 503)'));
    const secret = 'private-draft https://review.invalid/?token=private-token';
    reportReviewError('draft save', new SyntaxError(secret));
    reportReviewError('historical comments', { draft: secret });
    const output = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).toContain('Failed to fetch');
    expect(output).toContain('HTTP 503');
    expect(output).toContain('SyntaxError');
    expect(output).not.toContain('private-draft');
    expect(output).not.toContain('private-token');
    expect(output).not.toContain('stack');
  });
});
