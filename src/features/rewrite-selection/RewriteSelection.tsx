import { useState, type RefObject } from "react";
import { api } from "../../shared/api/api";
import { useTask } from "../../shared/lib/use-task";
import {
  OpenSettingsButton,
  type OpenSettings,
  type SettingsSection,
} from "../../shared/ui/settings-link";

const presets = [
  "Make it shorter",
  "Make it clearer",
  "Turn it into bullet points",
  "Fix spelling and grammar",
  "Make it more formal",
];

type Selection = { start: number; end: number; text: string };

/** Rewrites selected note text with the chat provider. Only the selection and request are sent;
 * the result replaces the selection only when the user accepts it. */
export function RewriteSelection(props: {
  editor: RefObject<HTMLTextAreaElement | null>;
  notes: string;
  disabled: boolean;
  /** Why AI actions are unavailable, with the Settings section that fixes it when it is configuration; null when they can run. */
  blocked: { message: string; section: SettingsSection | null } | null;
  onOpenSettings: OpenSettings;
  onApply: (notes: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [request, setRequest] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { busy: working, error, notice, setError, setNotice, run } = useTask();

  const close = () => {
    setSelection(null);
    setRequest("");
    setResult(null);
    setNotice("");
    setError("");
  };
  const open = () => {
    const area = props.editor.current;
    const start = area?.selectionStart ?? 0;
    const end = area?.selectionEnd ?? 0;
    close();
    if (!area || start === end || !area.value.slice(start, end).trim()) {
      setNotice("Select text in your notes first.");
      return;
    }
    setSelection({ start, end, text: area.value.slice(start, end) });
  };

  return (
    <>
      <button
        disabled={props.disabled || props.blocked !== null || !!selection}
        title={props.blocked?.message ?? "Rewrite the selected text with AI"}
        // Keep the textarea selection when the button takes focus.
        onMouseDown={(event) => event.preventDefault()}
        onClick={open}
      >
        Rewrite with AI…
      </button>
      {props.blocked && <span className="muted">{props.blocked.message}</span>}
      {props.blocked?.section && (
        <OpenSettingsButton
          section={props.blocked.section}
          onOpenSettings={props.onOpenSettings}
        />
      )}
      {!selection && notice && (
        <span className="muted" role="status">
          {notice}
        </span>
      )}
      {selection && (
        <div
          className="rewrite-card"
          role="group"
          aria-label="Rewrite selection"
        >
          <p>
            <strong>Rewrite {selection.text.length} selected characters</strong>
          </p>
          <p className="muted">
            Sends the selected text to your AI notes connection.
          </p>
          <blockquote className="rewrite-source">
            {selection.text.length > 280
              ? `${selection.text.slice(0, 280)}…`
              : selection.text}
          </blockquote>
          {result === null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (request.trim())
                  void run(async () =>
                    setResult(await api.rewriteText(selection.text, request)),
                  );
              }}
            >
              <div
                className="recipe-picker"
                role="group"
                aria-label="Rewrite presets"
              >
                {presets.map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    className="recipe-chip"
                    aria-pressed={request === preset}
                    disabled={working}
                    onClick={() => setRequest(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <label>
                How should it change?
                <input
                  value={request}
                  maxLength={1000}
                  disabled={working}
                  onChange={(event) => setRequest(event.target.value)}
                />
              </label>
              <div className="panel-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={props.disabled || working || !request.trim()}
                >
                  Rewrite
                </button>
                <button type="button" onClick={close}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {working && <p role="status">Working…</p>}
          {result !== null && (
            <>
              <div className="rewrite-result" aria-label="Rewritten text">
                {result}
              </div>
              <p className="muted">AI-generated. Check it before using it.</p>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={props.disabled}
                  onClick={() => {
                    const { start, end, text } = selection;
                    // The selection must still hold the text that was rewritten.
                    if (props.notes.slice(start, end) !== text)
                      return setError(
                        "Your notes changed around the selection, so nothing was replaced. Copy the rewrite instead.",
                      );
                    props.onApply(
                      props.notes.slice(0, start) +
                        result +
                        props.notes.slice(end),
                    );
                    close();
                  }}
                >
                  Replace selection
                </button>
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(result).then(
                      () => setNotice("Copied the rewrite."),
                      () => setError("The clipboard is unavailable."),
                    )
                  }
                >
                  Copy
                </button>
                <button onClick={close}>Discard</button>
              </div>
            </>
          )}
          {notice && (
            <p role="status" className="muted">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
