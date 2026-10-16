import { useRef } from 'react';

export function useReviewReset() {
  const generationRef = useRef(0);
  return { generationRef };
}
