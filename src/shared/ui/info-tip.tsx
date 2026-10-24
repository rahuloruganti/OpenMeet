import { useId, useState } from "react";
import "./info-tip.css";

/**
 * The small ⓘ that holds an explanation too long for the page (TEXT RULES: one helper line,
 * then a tip). It is a real button: reachable with Tab, opened with Enter, Space, a click or
 * focus, and closed with Escape or by leaving it.
 *
 * `label` is the name of the thing explained, so the button reads "More about Appearance".
 * `text` is the explanation itself.
 */
export function Tip(props: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = props.label ?? "this setting";
  return (
    <span className="om-tip">
      <button
        type="button"
        className="om-info"
        aria-label={`More about ${name}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        // Focus opens it, so a keyboard user sees the text without pressing anything else.
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        // Escape closes the tip and goes no further: it must not close the page behind it.
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.stopPropagation();
          event.preventDefault();
          setOpen(false);
        }}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open && (
        <span className="om-tip-pop" id={id} role="tooltip">
          {props.text}
        </span>
      )}
    </span>
  );
}
