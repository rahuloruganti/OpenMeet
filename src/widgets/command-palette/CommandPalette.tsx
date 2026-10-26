import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Meeting, Theme } from "../../shared/api/api";
import { foldText, formatShortDate } from "../../entities/meeting";
import "./command-palette.css";

/** Everything the palette can run. Nothing here starts a recording by itself. */
export type PaletteAction =
  | "new-recording"
  | "new-note"
  | "settings"
  | "export"
  | "rename"
  | "theme-system"
  | "theme-dark"
  | "theme-light";

type Row = {
  /** Stable DOM id fragment, also the React key. */
  key: string;
  label: string;
  glyph: string;
  /** Shortcut hints, drawn as kbd caps after the label. */
  keys?: string[];
  /** Shown right of the label instead of keys (the current theme). */
  tag?: string;
  disabled?: boolean;
  run: () => void;
};

type Group = { name: string; rows: Row[] };

type Props = {
  meetings: Meeting[];
  theme: Theme;
  /** The open meeting, or null: Export and Rename need one. */
  currentMeetingId: string | null;
  onClose: () => void;
  onAction: (action: PaletteAction) => void;
  onOpenMeeting: (id: string) => void;
  /** Where focus goes when the palette closes; null hands it to the app. */
  returnFocus?: HTMLElement | null;
};

type ActionRow = Omit<Row, "run"> & { action: PaletteAction };

const ACTIONS: ActionRow[] = [
  {
    key: "new-recording",
    action: "new-recording",
    label: "New recording",
    glyph: "＋",
    keys: ["Ctrl", "N"],
  },
  {
    key: "new-note",
    action: "new-note",
    label: "New note",
    glyph: "＋",
    keys: ["Ctrl", "⇧", "N"],
  },
  {
    key: "settings",
    action: "settings",
    label: "Open settings",
    glyph: "⚙",
    keys: ["Ctrl", ","],
  },
  {
    key: "export",
    action: "export",
    label: "Export meeting",
    glyph: "↓",
    keys: ["Ctrl", "E"],
  },
  {
    key: "rename",
    action: "rename",
    label: "Rename",
    glyph: "✎",
    keys: ["F2"],
  },
  {
    key: "theme-system",
    action: "theme-system",
    label: "Theme: System",
    glyph: "◐",
  },
  { key: "theme-dark", action: "theme-dark", label: "Theme: Dark", glyph: "◐" },
  {
    key: "theme-light",
    action: "theme-light",
    label: "Theme: Light",
    glyph: "◐",
  },
];

const themeOf = (action: PaletteAction): Theme | null =>
  action === "theme-system"
    ? "system"
    : action === "theme-dark"
      ? "dark"
      : action === "theme-light"
        ? "light"
        : null;

/**
 * Command palette (Ctrl+K): one searchable list of actions and open meetings.
 * Arrow keys move, Enter runs, Escape closes; nothing here starts a recording.
 */
export function CommandPalette(props: Props) {
  const { onClose, onAction, onOpenMeeting, currentMeetingId, theme } = props;
  const meetings = props.meetings;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Where focus was before the palette opened, so closing puts it back.
  const origin = useRef<HTMLElement | null>(props.returnFocus ?? null);

  const groups = useMemo<Group[]>(() => {
    const needle = foldText(query.trim());
    const match = (label: string) =>
      needle === "" || foldText(label).includes(needle);
    const actions: Row[] = ACTIONS.filter((row) => match(row.label)).map(
      (row) => {
        const wanted = themeOf(row.action);
        const needsMeeting = row.action === "export" || row.action === "rename";
        return {
          key: row.key,
          label: row.label,
          glyph: row.glyph,
          keys: row.keys,
          disabled: needsMeeting && currentMeetingId === null,
          tag: wanted && theme === wanted ? "Current" : undefined,
          run: () => {
            onClose();
            onAction(row.action);
          },
        };
      },
    );
    const shown = meetings.filter((meeting) => match(meeting.title));
    // Without a query the list stays short; a typed title searches the library.
    const found: Row[] = (
      needle === "" ? shown.slice(0, 6) : shown.slice(0, 20)
    ).map((meeting) => ({
      key: `meeting-${meeting.id}`,
      label: meeting.title,
      glyph: "•",
      tag: formatShortDate(meeting.started_at),
      run: () => {
        onClose();
        onOpenMeeting(meeting.id);
      },
    }));
    return [
      ...(actions.length > 0 ? [{ name: "Actions", rows: actions }] : []),
      ...(found.length > 0 ? [{ name: "Meetings", rows: found }] : []),
    ];
  }, [
    query,
    meetings,
    theme,
    currentMeetingId,
    onAction,
    onClose,
    onOpenMeeting,
  ]);

  const flat = groups.flatMap((group) => group.rows);
  const active = Math.min(cursor, Math.max(flat.length - 1, 0));
  const activeKey = flat[active]?.key;

  useEffect(() => {
    input.current?.focus();
    const element = origin.current;
    return () => {
      if (element?.isConnected) element.focus();
    };
  }, []);
  // The row set changes under the cursor as the query narrows.
  useEffect(() => setCursor(0), [query]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    setCursor(
      (Math.min(cursor, flat.length - 1) + delta + flat.length) % flat.length,
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setCursor(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setCursor(Math.max(flat.length - 1, 0));
      return;
    }
    if (event.key === "Tab") {
      // The dialog is modal and the search box is its only focusable field.
      event.preventDefault();
      input.current?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = flat[active];
      if (row && !row.disabled) row.run();
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette-search">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search commands and meetings"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={
              activeKey ? `palette-${activeKey}` : undefined
            }
            placeholder="Type a command or meeting…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div
          className="palette-list"
          id="palette-list"
          role="listbox"
          aria-label="Commands and meetings"
        >
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <div className="palette-group" aria-hidden="true">
                {group.name}
              </div>
              {group.rows.map((row) => {
                const selected = row.key === activeKey;
                return (
                  <div
                    key={row.key}
                    id={`palette-${row.key}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={row.disabled || undefined}
                    className="palette-row"
                    onMouseMove={() =>
                      setCursor(flat.findIndex((item) => item.key === row.key))
                    }
                    onClick={() => {
                      if (!row.disabled) row.run();
                    }}
                  >
                    <span className="glyph" aria-hidden="true">
                      {row.glyph}
                    </span>
                    <span className="label">{row.label}</span>
                    {row.keys && (
                      <span className="keys" aria-hidden="true">
                        {row.keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                    )}
                    {row.tag && <span className="tag">{row.tag}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <p className="palette-empty" role="status">
              No matches.
            </p>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
