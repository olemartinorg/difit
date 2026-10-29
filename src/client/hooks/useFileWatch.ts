import { useCallback, useEffect, useRef, useState } from 'react';

import { DiffMode, type ClientWatchState, type WatchEvent } from '../../types/watch.js';
import { resolveEventSourceUrl } from '../utils/eventSourceUrl';

interface FileWatchHook {
  shouldReload: boolean;
  isConnected: boolean;
  error: string | null;
  reload: () => Promise<void>;
  watchState: ClientWatchState;
}

export function useFileWatch(
  onReload?: () => Promise<void>,
  onCommentsChanged?: () => Promise<void>,
): FileWatchHook {
  const changeSequenceRef = useRef(0);
  const reloadingRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectDelay = 3000; // 3 seconds

  const [watchState, setWatchState] = useState<ClientWatchState>({
    isWatchEnabled: false,
    diffMode: DiffMode.DEFAULT,
    shouldReload: false,
    isReloading: false,
    lastChangeTime: null,
    lastChangeType: null,
    connectionStatus: 'disconnected',
  });

  const [watchError, setWatchError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const connectToWatch = useCallback(() => {
    if (eventSourceRef.current) {
      return; // Already connected
    }

    try {
      const eventSource = new EventSource(resolveEventSourceUrl('/api/watch'));
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('Connected to file watch service');
        if (reconnectAttemptsRef.current > 0) {
          // Changes made while disconnected may have no surviving SSE event.
          changeSequenceRef.current++;
          setReloadError(null);
          setWatchState((prev) => ({ ...prev, shouldReload: true }));
        }
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'connected',
        }));
        reconnectAttemptsRef.current = 0;
        setWatchError(null);
      };

      eventSource.onmessage = (event) => {
        try {
          // oxlint-disable-next-line typescript/no-unsafe-assignment
          const data: WatchEvent = JSON.parse(event.data as string);

          switch (data.type) {
            case 'connected':
              setWatchState((prev) => ({
                ...prev,
                isWatchEnabled: true,
                diffMode: data.diffMode,
                connectionStatus: 'connected',
              }));
              break;

            case 'reload':
              changeSequenceRef.current++;
              // A new change is new work, so an earlier failed read must not
              // permanently disable automatic refresh. Identical failures stay
              // idle until another event or an explicit refresh.
              setReloadError(null);
              setWatchError(null);
              console.log('File changes detected, showing reload button:', data.changeType);
              setWatchState((prev) => ({
                ...prev,
                shouldReload: true,
                lastChangeTime: new Date(),
                lastChangeType: data.changeType,
              }));
              break;

            case 'error':
              console.error('File watch error:', data.message);
              setWatchError(data.message || 'File watch error occurred');
              break;

            case 'commentsChanged':
              if (onCommentsChanged) {
                void onCommentsChanged();
              }
              break;
          }
        } catch (parseError) {
          console.error('Error parsing watch event:', parseError);
        }
      };

      eventSource.onerror = () => {
        console.log('File watch connection lost');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'disconnected',
        }));

        // Close the current connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        // Attempt to reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          setWatchState((prev) => ({
            ...prev,
            connectionStatus: 'reconnecting',
          }));

          reconnectAttemptsRef.current += 1;

          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(
              `Attempting to reconnect to file watch service (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
            );
            // oxlint-disable-next-line react-hooks-js/immutability -- connectToWatch is defined when setTimeout callback runs
            connectToWatch();
          }, reconnectDelay);
        } else {
          console.error('Max reconnection attempts reached');
          setWatchError('Lost connection to file watch service');
        }
      };
    } catch (connectionError) {
      console.error('Failed to connect to file watch service:', connectionError);
      setWatchError('Failed to connect to file watch service');
    }
  }, [maxReconnectAttempts, onCommentsChanged, reconnectDelay]);

  const handleReload = useCallback(async () => {
    if (reloadingRef.current) {
      return; // Already reloading
    }

    reloadingRef.current = true;
    const sequence = changeSequenceRef.current;
    setWatchError(null);
    setReloadError(null);
    setWatchState((prev) => ({
      ...prev,
      isReloading: true,
    }));

    try {
      if (onReload) {
        await onReload();
      }

      // Reset reload state after successful reload
      setWatchState((prev) => ({
        ...prev,
        shouldReload: changeSequenceRef.current !== sequence,
        isReloading: false,
        lastChangeTime: changeSequenceRef.current === sequence ? null : prev.lastChangeTime,
        lastChangeType: changeSequenceRef.current === sequence ? null : prev.lastChangeType,
      }));
    } catch (cause) {
      console.error('Reload failed:', cause);
      setReloadError(
        changeSequenceRef.current !== sequence
          ? null
          : cause instanceof Error && cause.message.trim()
            ? cause.message
            : 'Failed to reload diff data',
      );

      setWatchState((prev) => ({
        ...prev,
        shouldReload: true,
        isReloading: false,
      }));
    } finally {
      reloadingRef.current = false;
    }
  }, [onReload]);

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  // Initialize connection
  useEffect(() => {
    connectToWatch();

    return cleanup;
  }, [connectToWatch]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, []);

  return {
    shouldReload: watchState.shouldReload,
    isConnected: watchState.connectionStatus === 'connected',
    error: reloadError ?? watchError,
    reload: handleReload,
    watchState,
  };
}
