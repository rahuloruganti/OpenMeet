import { useState } from "react";
import type { Meeting, SearchHit } from "../../shared/api/api";
import { groupMeetings } from "../../entities/meeting";
import {
  foldText,
  formatBytes,
  formatShortDate,
  formatTime,
  sourceWords,
  statusWords,
  tagChoices,
} from "../../entities/meeting";
import { BrandMark } from "../../shared/ui/brand-mark";
import "./meeting-sidebar.css";

const hitLabels: Record<SearchHit["kind"], string> = {
  title: "Title",
  notes: "Notes",
  transcript: "Transcript",
  summary: "Summary",
};

type Props = {
  open: boolean;
  meetings: Meeting[];
  search: string;
  selectedId: string | undefined;
  disabled: boolean;
  recordingActive: boolean;
  onSearch: (value: string) => void;
  onNewRecording: (trigger: HTMLButtonElement) => void;
  onSettings: (trigger: HTMLButtonElement) => void;
  /** Opens the Ask view: a page when the shell provides one, else the library panel. */
  onAsk: (trigger: HTMLButtonElement) => void;
  onOpenMeeting: (id: string) => void;
  onNewNote: () => void;
  /** Full-text matches in notes, transcripts and summaries for the current search. */
  hits: SearchHit[];
  onOpenHit: (hit: SearchHit) => void;
  /** Total audio stored on this device, or null while unknown. */
  audioBytes: number | null;
};

export function MeetingSidebar(props: Props) {
  const { meetings, search, selectedId, disabled } = props;
  const needle = foldText(search.trim());
  const [tag, setTag] = useState("");
  const tags = tagChoices(meetings);
  // A tag that no meeting has any more stops filtering instead of hiding everything.
  const active =
    tags.find((name) => name.toLocaleLowerCase() === tag.toLocaleLowerCase()) ??
    "";
  const tagged = (meeting: Meeting) =>
    active === "" ||
    meeting.tags.some(
      (name) => name.toLocaleLowerCase() === active.toLocaleLowerCase(),
    );
  const visible = meetings.filter(
    (meeting) => tagged(meeting) && foldText(meeting.title).includes(needle),
  );
  const titles = new Map(
    meetings.filter(tagged).map((meeting) => [meeting.id, meeting.title]),
  );
  // Title matches are already in the instant list above; skip hits for meetings not loaded or filtered out.
  const matches = props.hits.filter(
    (hit) => hit.kind !== "title" && titles.has(hit.meeting_id),
  );
  const storage =
    props.audioBytes !== null && props.audioBytes > 0
      ? `On this device · ${formatBytes(props.audioBytes)} audio`
      : "On this device";

  return (
    <aside
      id="meeting-sidebar"
      className="sidebar sb"
      aria-label="Meeting navigation"
      hidden={!props.open}
    >
      <div className="sb-top">
        <div className="brand">
          <BrandMark size={22} />
          <span className="brand-name">openmeet</span>
        </div>
        <button
          className="primary sb-new"
          disabled={disabled || props.recordingActive}
          onClick={(event) => props.onNewRecording(event.currentTarget)}
        >
          <span aria-hidden="true">＋</span> New recording
        </button>
        <button
          className="sb-new sb-new-alt"
          disabled={disabled}
          onClick={props.onNewNote}
        >
          <span aria-hidden="true">＋</span> New note
        </button>
        <div className="sb-search">
          <label>
            <span className="sr-only">Search meetings</span>
            <input
              type="search"
              value={search}
              onChange={(event) => props.onSearch(event.target.value)}
              placeholder="Search meetings…"
            />
          </label>
          <kbd>Ctrl K</kbd>
        </div>
        {tags.length > 0 && (
          <div className="sb-chips" role="group" aria-label="Filter by tag">
            <button
              className="sb-chip"
              aria-pressed={active === ""}
              onClick={() => setTag("")}
            >
              All
            </button>
            {tags.map((name) => (
              <button
                key={name}
                className="sb-chip"
                aria-pressed={
                  name.toLocaleLowerCase() === active.toLocaleLowerCase()
                }
                onClick={() => setTag(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sb-list">
        {meetings.length === 0 && <p className="sb-none">No meetings yet</p>}
        {groupMeetings(visible).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="sb-group">{group.label}</h3>
            <ul className="meeting-list">
              {group.meetings.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    className="sb-row"
                    disabled={disabled}
                    title={meeting.title}
                    aria-current={
                      selectedId === meeting.id ? "true" : undefined
                    }
                    onClick={() => props.onOpenMeeting(meeting.id)}
                  >
                    <i>{meeting.title}</i>
                    <time dateTime={meeting.started_at}>
                      {/* Same-day meetings differ by start time; older ones by date. */}
                      {group.label === "Earlier"
                        ? formatShortDate(meeting.started_at)
                        : formatTime(meeting.started_at)}
                    </time>
                    <em>
                      {sourceWords[meeting.source]}
                      {meeting.status === "stopped"
                        ? ""
                        : ` · ${statusWords[meeting.status]}`}
                      {meeting.tags.length > 0 && (
                        <span
                          className="meeting-tags"
                          title={meeting.tags.join(", ")}
                        >
                          {` · ${meeting.tags.slice(0, 3).join(", ")}${meeting.tags.length > 3 ? ` +${meeting.tags.length - 3}` : ""}`}
                        </span>
                      )}
                    </em>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {matches.length > 0 && (
          <section aria-label="Matches in notes and transcripts">
            <h3 className="sb-group">Matches</h3>
            <ul className="meeting-list">
              {matches.map((hit) => (
                <li key={`${hit.meeting_id}-${hit.kind}`}>
                  <button
                    className="sb-row sb-hit"
                    disabled={disabled}
                    onClick={() => props.onOpenHit(hit)}
                  >
                    <strong>{titles.get(hit.meeting_id)}</strong>
                    <span>
                      {hitLabels[hit.kind]} · {hit.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {meetings.length > 0 &&
          visible.length === 0 &&
          matches.length === 0 && (
            <p className="sb-none">No matching meetings.</p>
          )}
      </div>
      <div className="sb-foot">
        {/* Visible "Ask"; the full name stays the accessible one. */}
        <button
          className="sb-navrow"
          aria-label="Ask across meetings"
          disabled={disabled || meetings.length === 0}
          onClick={(event) => props.onAsk(event.currentTarget)}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M21 12a8 8 0 1 1-3.2-6.4" />
            <path d="M21 4v5h-5" />
          </svg>
          Ask
        </button>
        <button
          className="sb-navrow"
          onClick={(event) => props.onSettings(event.currentTarget)}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M4 12h2M18 12h2M12 4v2M12 18v2" />
          </svg>
          Settings
        </button>
        <p className="sb-storage">{storage}</p>
      </div>
    </aside>
  );
}
