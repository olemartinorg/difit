import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizeReviewSettings, type ReviewSettings } from '../../utils/reviewExport';
import { fetchClientSettings, saveClientSettings } from '../services/userSettings';

const STORAGE_KEY = 'difit.reviewSettings';

function readSettings(): ReviewSettings {
  try {
    return normalizeReviewSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return normalizeReviewSettings(null);
  }
}

export function useReviewSettings() {
  const [settings, setSettings] = useState(readSettings);
  const editedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchClientSettings().then((client) => {
      if (!cancelled && !editedRef.current && client?.review) {
        const remote = normalizeReviewSettings(client.review);
        setSettings(remote);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
        } catch {
          // The server remains the persistent store if browser storage is unavailable.
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const updateSettings = useCallback((next: ReviewSettings) => {
    editedRef.current = true;
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Settings still persist through the server.
    }
    saveClientSettings({ review: next });
  }, []);
  return { settings, updateSettings };
}
