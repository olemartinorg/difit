import { useCallback, useRef } from 'react';

export function useReviewReset() {
  const generationRef = useRef(0);
  const invalidate = useCallback(() => {
    generationRef.current++;
  }, []);

  return { generationRef, invalidate };
}
