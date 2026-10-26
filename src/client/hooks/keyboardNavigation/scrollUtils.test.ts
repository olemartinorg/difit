import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScrollToElement } from './scrollUtils';

function setup(targetTop: number, headerHeight = 64, scrollTop = 300) {
  const container = document.createElement('main');
  container.className = 'overflow-y-auto';
  container.innerHTML = `
    <div data-file-path="example.ts">
      <div data-diff-file-header></div>
      <div><div id="target"></div></div>
    </div>`;
  document.body.append(container);
  const target = container.querySelector<HTMLElement>('#target')!;
  const header = container.querySelector<HTMLElement>('[data-diff-file-header]')!;
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 800, 600));
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, targetTop, 800, 24));
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 800, headerHeight));
  Object.defineProperty(container, 'clientHeight', { value: 600 });
  container.scrollTop = scrollTop;
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('keyboard navigation scrolling', () => {
  it.each([500, 900, -100])(
    'aligns the target below its sticky header when it starts at %i',
    (targetTop) => {
      const container = setup(targetTop);
      createScrollToElement()('target');
      // The selected row ends at y=144, just below the 64px header at y=80.
      expect(targetTop - (container.scrollTop - 300)).toBe(144);
    },
  );

  it('uses the wrapped header height in a narrow view', () => {
    const container = setup(500, 112);
    createScrollToElement()('target');
    expect(500 - (container.scrollTop - 300)).toBe(192);
  });

  it('clamps scrolling at the beginning of the diff', () => {
    const container = setup(100, 64, 0);
    createScrollToElement()('target');
    expect(container.scrollTop).toBe(0);
  });

  it('keeps an already visible mouse selection stationary', () => {
    const container = setup(500);
    createScrollToElement()('target', 'nearest');
    expect(container.scrollTop).toBe(300);
  });

  it('reveals an offscreen mouse selection', () => {
    const container = setup(900);
    createScrollToElement()('target', 'nearest');
    expect(900 - (container.scrollTop - 300)).toBe(280);
  });

  it('waits for a deferred target to exist', () => {
    expect(() => createScrollToElement()('missing')).not.toThrow();
  });
});
