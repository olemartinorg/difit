import { useCallback, useRef, useState } from 'react';

export function useReviewReset() {
  const generationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(
    async (url: string, clearLocal: () => void, onVersion: (version: number) => void) => {
      const generation = ++generationRef.current;
      setError(null);
      clearLocal();
      try {
        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) throw new Error('Could not reset comments. Try again.');
        const payload = (await response.json()) as { version?: number };
        if (generation === generationRef.current && typeof payload.version === 'number') {
          onVersion(payload.version);
        }
      } catch (cause) {
        if (generation === generationRef.current) {
          setError(cause instanceof Error ? cause.message : 'Could not reset the review');
        }
      }
    },
    [],
  );

  return { reset, generationRef, error };
}
