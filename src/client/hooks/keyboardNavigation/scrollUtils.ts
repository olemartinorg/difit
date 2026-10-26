import { NAVIGATION_SELECTORS } from '../../constants/navigation';

import { SCROLL_CONSTANTS } from './types';

/** Align keyboard targets below the sticky file header. */
export function createScrollToElement() {
  return (elementId: string, alignment: 'start' | 'nearest' = 'start'): void => {
    const element = document.getElementById(elementId);
    if (!element) return;

    const scrollContainer = document.querySelector<HTMLElement>(
      NAVIGATION_SELECTORS.SCROLL_CONTAINER,
    );
    if (!scrollContainer) {
      throw new Error(`Scrollable container (${NAVIGATION_SELECTORS.SCROLL_CONTAINER}) not found`);
    }

    const rect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const header = element.closest('[data-file-path]')?.querySelector('[data-diff-file-header]');
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    const containerTop = containerRect.top + scrollContainer.clientTop;
    const visibleTop = Math.max(containerTop, 0) + headerHeight;
    const visibleBottom = Math.min(containerRect.bottom, window.innerHeight);
    const isVisible = rect.top >= visibleTop && rect.bottom <= visibleBottom;

    // Mouse selection keeps visible content stationary.
    if (alignment === 'nearest' && isVisible) return;

    const topInset =
      alignment === 'start'
        ? headerHeight
        : Math.max(
            headerHeight,
            scrollContainer.clientHeight * SCROLL_CONSTANTS.VIEWPORT_OFFSET_RATIO,
          );
    scrollContainer.scrollTop = Math.max(
      0,
      scrollContainer.scrollTop + rect.top - containerTop - topInset,
    );
  };
}
