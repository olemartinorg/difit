import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiffSelection } from '../../types/diff';
import type { ReviewInventory, ReviewRange } from '../../types/review';
import {
  getDefaultReviewRange,
  getReviewUnits,
  getSelectedReviewUnits,
  reconcileReviewRange,
  resolveReviewRange,
  toggleReviewRange,
} from '../../utils/reviewSelection';

export function useReviewInventory(
  onSelectionChange: (selection: DiffSelection | null, inventory: ReviewInventory) => void,
  enabled: boolean,
  ignoreWhitespace: boolean,
) {
  const [inventory, setInventory] = useState<ReviewInventory | null>(null);
  const [range, setRange] = useState<ReviewRange | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inventoryRef = useRef(inventory);
  const rangeRef = useRef(range);
  const activeRef = useRef(active);
  const customizedRef = useRef(false);
  const onChangeRef = useRef(onSelectionChange);
  const requestIdRef = useRef(0);
  const initialUrlRef = useRef(new URLSearchParams(window.location.hash.slice(1)));
  const targetRef = useRef(initialUrlRef.current.get('reviewTarget'));
  const writeUrl = useCallback((nextRange: ReviewRange | null, target?: string) => {
    const params = new URLSearchParams();
    params.set('review', nextRange ? 'range' : 'empty');
    if (nextRange) {
      params.set('oldest', nextRange.oldest);
      params.set('newest', nextRange.newest);
    }
    if (target) params.set('reviewTarget', target);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${params}`,
    );
  }, []);
  onChangeRef.current = onSelectionChange;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestIdRef.current;
    try {
      const urlTarget = targetRef.current;
      const params = new URLSearchParams({ ignoreWhitespace: String(ignoreWhitespace) });
      if (urlTarget) params.set('target', urlTarget);
      const response = await fetch(`/api/review?${params}`);
      const data = (await response.json()) as ReviewInventory & { error?: string };
      if (requestId !== requestIdRef.current) return;
      if (!response.ok) throw new Error(data.error || 'Could not load changes');
      if (!Array.isArray(data.commits) || !Array.isArray(data.targetOptions)) return;
      const previous = inventoryRef.current;
      const changedBranch =
        previous && (previous.branch !== data.branch || previous.target !== data.target);
      if (!previous) activeRef.current = data.reviewByDefault;
      if (changedBranch) customizedRef.current = false;
      let nextRange =
        !customizedRef.current || !previous
          ? getDefaultReviewRange(data)
          : reconcileReviewRange(previous, data, rangeRef.current);
      if (!previous && initialUrlRef.current.has('review')) {
        const oldest = initialUrlRef.current.get('oldest'),
          newest = initialUrlRef.current.get('newest');
        const saved = oldest && newest ? { oldest, newest } : null;
        nextRange =
          saved && getSelectedReviewUnits(getReviewUnits(data), saved).length ? saved : null;
        activeRef.current = true;
        customizedRef.current = true;
      }
      if (previous && customizedRef.current && rangeRef.current && !nextRange) {
        setNotice('The selected commits are no longer available. Choose a new range.');
      }
      inventoryRef.current = data;
      rangeRef.current = nextRange;
      setInventory(data);
      setRange(nextRange);
      setActive(activeRef.current);
      setError(null);
      if (activeRef.current && customizedRef.current) writeUrl(nextRange, data.target);
      if (activeRef.current) onChangeRef.current(resolveReviewRange(data, nextRange), data);
    } catch (cause) {
      if (requestId === requestIdRef.current)
        setError(cause instanceof Error ? cause.message : 'Could not load changes');
    }
  }, [enabled, ignoreWhitespace, writeUrl]);

  const cancelRequests = useCallback(() => {
    requestIdRef.current++;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelRequests();
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh, cancelRequests]);

  const select = useCallback(
    (ids: string[], only = false) => {
      const current = inventoryRef.current;
      if (!current) return;
      const units = getReviewUnits(current);
      const before = getSelectedReviewUnits(units, activeRef.current ? rangeRef.current : null);
      const nextRange = toggleReviewRange(
        units,
        activeRef.current ? rangeRef.current : null,
        ids,
        only,
      );
      const after = getSelectedReviewUnits(units, nextRange);
      const filled = after.filter((id) => !before.includes(id) && !ids.includes(id)).length;
      const trimmed = before.filter((id) => !after.includes(id) && !ids.includes(id)).length;
      setNotice(
        filled
          ? `Also selected ${filled} intervening ${filled === 1 ? 'commit' : 'commits'} to keep one range.`
          : trimmed
            ? `Also deselected ${trimmed} older ${trimmed === 1 ? 'commit' : 'commits'} to keep one range.`
            : '',
      );
      rangeRef.current = nextRange;
      activeRef.current = true;
      customizedRef.current = true;
      setRange(nextRange);
      setActive(true);
      writeUrl(nextRange, current.target);
      onChangeRef.current(resolveReviewRange(current, nextRange), current);
    },
    [writeUrl],
  );

  const changeTarget = useCallback(
    async (target: string) => {
      setBusy(true);
      try {
        const response = await fetch('/api/review/target', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        if (!response.ok) throw new Error('Could not save the target branch');
        customizedRef.current = false;
        targetRef.current = target;
        activeRef.current = true;
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not change target');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const useAdvanced = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  return {
    inventory,
    range: active ? range : null,
    active,
    select,
    refresh,
    changeTarget,
    useAdvanced,
    error,
    notice,
    busy,
  };
}
