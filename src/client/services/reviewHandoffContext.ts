/** Embedders freeze their destination here, before export performs asynchronous work. */
export function captureReviewHandoffContext(): unknown {
  return window.difitHost?.captureReviewHandoffContext();
}

declare global {
  interface Window {
    difitHost?: { captureReviewHandoffContext: () => unknown };
  }
}
