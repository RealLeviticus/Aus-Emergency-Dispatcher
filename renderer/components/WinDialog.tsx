import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/**
 * The shell every modal dialog sits in.
 *
 * Each dialog used to hand-roll its own overlay, title bar and footer. That
 * duplication is how they drifted apart and how two of them broke outright:
 *
 *  - the dialogs opened from `home.tsx` render as SIBLINGS of the `.y2k`
 *    desktop, not inside it. The Win9x palette used to be scoped to `.y2k`, so
 *    out there `var(--w-face)` resolved to nothing — transparent window, no
 *    bevels — and the text fell back to the dark theme's light grey on grey.
 *    The tokens now live on `:root` and `.win-chrome` re-applies the typography,
 *    so a dialog looks identical wherever it is mounted;
 *  - a fixed pixel width with no max-height pushed the title bar and the footer
 *    buttons off a short window, leaving a first-run dialog with no way to close.
 *    `.win-modal` caps the frame to the viewport and scrolls the body instead.
 *
 * It also adds what a modal is expected to do and none of them did: Escape
 * closes, focus moves into the dialog and returns to whatever opened it, and
 * a drag that starts inside the window and ends on the backdrop does not count
 * as a click-away.
 */
export function WinDialog({
  title,
  onClose,
  width = 520,
  children,
  footer,
  /** false for a dialog that must be answered (nothing important is behind it) */
  closeOnBackdrop = true,
}: {
  title: ReactNode;
  onClose: () => void;
  /** natural width in px; always capped to the viewport */
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);
  /** where the mouse went DOWN — a drag out of the window is not a click-away */
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    opener.current = document.activeElement;
    frame.current?.focus();
    const restore = opener.current;
    return () => {
      if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
    };
  }, []);

  // Escape closes. Bound to the document (not the frame) so it still works when
  // focus has moved into an iframe-free child that stops propagation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const backdropDown = useCallback((e: React.MouseEvent) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  }, []);

  const backdropUp = useCallback(
    (e: React.MouseEvent) => {
      const wasClickAway = downOnBackdrop.current && e.target === e.currentTarget;
      downOnBackdrop.current = false;
      if (wasClickAway && closeOnBackdrop) onClose();
    },
    [closeOnBackdrop, onClose],
  );

  return (
    <div className="win-modal win-chrome" onMouseDown={backdropDown} onMouseUp={backdropUp}>
      <div
        ref={frame}
        className="win-window"
        style={{ maxWidth: `min(${width}px, 100%)` }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
      >
        <div className="win-titlebar">
          <span className="flex-1 truncate font-bold">{title}</span>
          <button type="button" className="win-titlebar-btn" onClick={onClose} aria-label="Close">
            {'✕'}
          </button>
        </div>

        <div className="win-modal-body leading-snug">{children}</div>

        {footer && <div className="win-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
