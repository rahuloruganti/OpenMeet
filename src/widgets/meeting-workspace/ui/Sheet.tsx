import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconX } from "../../../shared/ui/icons";

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  /** Heading text, also the sheet's accessible name. */
  title: string;
  /** The element that opened the sheet; focus returns here when it closes. */
  opener: HTMLElement | null;
  onClose: () => void;
  /** A short line under the body, e.g. a read-only note. */
  footer?: string;
  /** A number shown after the heading, e.g. open tasks. */
  count?: number;
  children: ReactNode;
};

let sheetCount = 0;

/**
 * The right-hand sheet the narrow meeting page opens (Tasks, History): a modal
 * dialog that takes focus on open, traps Tab, closes on Escape and hands focus
 * back to whatever opened it. Both sheets are this one component.
 */
export function Sheet({
  title,
  opener,
  onClose,
  footer,
  count,
  children,
}: Props) {
  const sheet = useRef<HTMLElement>(null);
  const returnTo = useRef(opener);
  // A unique id keeps both sheets' headings valid when only one is mounted.
  const [headingId] = useState(() => `sheet-${++sheetCount}`);
  // Focus enters on open and goes back to the opener on close, wherever it still is.
  useEffect(() => {
    const node = sheet.current;
    (node?.querySelector<HTMLElement>(focusable) ?? node)?.focus();
    const back = returnTo.current;
    return () => {
      if (back?.isConnected) back.focus();
    };
  }, []);
  return (
    <aside
      className="mw-sheet"
      ref={sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const items = Array.from(
          sheet.current?.querySelectorAll<HTMLElement>(focusable) ?? [],
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="mw-sheet-head">
        <h2 id={headingId}>{title}</h2>
        {count !== undefined && <span className="mw-count">{count}</span>}
        <span className="mw-gap" />
        <button aria-label="Close" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>
      <div className="mw-sheet-body">{children}</div>
      {footer && <p className="mw-sheet-foot">{footer}</p>}
    </aside>
  );
}
