import { Component, type ReactNode, type RefObject } from 'react';

interface Props {
  children: ReactNode;
  containerRef: RefObject<HTMLElement | null>;
  className: string;
  'aria-busy': boolean;
}

interface Snapshot {
  editor: HTMLElement;
  anchor: HTMLElement;
  top: number;
  focused: HTMLElement | null;
}

// Capture before React changes the rows and compensate after draft slots have
// moved their persistent editors, in the same commit and before the browser paints.
export class ReviewScrollContainer extends Component<Props, object, Snapshot | null> {
  override getSnapshotBeforeUpdate(): Snapshot | null {
    const container = this.props.containerRef.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const editors = [
      focused?.closest<HTMLElement>('[data-live-comment-editor]'),
      ...(container?.querySelectorAll<HTMLElement>('[data-live-comment-editor]') ?? []),
    ];
    for (const editor of editors) {
      // Closed saved threads share the portal marker but have no editor to
      // preserve. Keep looking when focus is on a toolbar or other control.
      const anchor = editor?.querySelector<HTMLElement>('textarea, form');
      if (editor && anchor)
        return { editor, anchor, top: anchor.getBoundingClientRect().top, focused };
    }
    return null;
  }

  override componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    const container = this.props.containerRef.current;
    if (!container || !snapshot?.anchor.isConnected) return;
    if (snapshot.focused?.isConnected && document.activeElement !== snapshot.focused) {
      snapshot.focused.focus({ preventScroll: true });
    }
    container.scrollTop += snapshot.anchor.getBoundingClientRect().top - snapshot.top;
    // scrollTop can round to a device pixel while table geometry uses subpixels.
    const remainder = snapshot.anchor.getBoundingClientRect().top - snapshot.top;
    if (remainder) {
      const offset = Number(snapshot.editor.dataset.viewportOffset ?? 0) - remainder;
      snapshot.editor.dataset.viewportOffset = String(offset);
      snapshot.editor.style.transform = `translateY(${offset}px)`;
    }
  }

  override render() {
    return (
      <main
        ref={this.props.containerRef}
        className={this.props.className}
        aria-busy={this.props['aria-busy']}
        style={{ scrollbarGutter: 'stable' }}
      >
        {this.props.children}
      </main>
    );
  }
}
