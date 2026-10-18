import { useState } from "react";
import type { Meeting, SearchHit } from "../lib/api";
import { groupMeetings } from "../lib/group-meetings";
import { formatBytes, sourceLabels } from "../lib/meeting-labels";

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
  const needle = search.trim().toLocaleLowerCase();
  const [tag, setTag] = useState("");
  // Tags match case-insensitively, so list each spelling-insensitive tag once.
  const tagChoices = [
    ...new Map(
      meetings.flatMap((meeting) =>
        meeting.tags.map((name) => [name.toLocaleLowerCase(), name] as const),
      ),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  // A tag that no meeting has any more stops filtering instead of hiding everything.
  const active =
    tagChoices.find(
      (name) => name.toLocaleLowerCase() === tag.toLocaleLowerCase(),
    ) ?? "";
  const tagged = (meeting: Meeting) =>
    active === "" ||
    meeting.tags.some(
      (name) => name.toLocaleLowerCase() === active.toLocaleLowerCase(),
    );
  const visible = meetings.filter(
    (meeting) =>
      tagged(meeting) && meeting.title.toLocaleLowerCase().includes(needle),
  );
  const titles = new Map(
    meetings.filter(tagged).map((meeting) => [meeting.id, meeting.title]),
  );
  // Title matches are already in the instant list above; skip hits for meetings not loaded or filtered out.
  const matches = props.hits.filter(
    (hit) => hit.kind !== "title" && titles.has(hit.meeting_id),
  );

  return (
    <aside
      id="meeting-sidebar"
      className="sidebar"
      aria-label="Meeting navigation"
      hidden={!props.open}
    >
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M5 10v4M10 5v14M15 8v8M20 10v4" />
            </svg>
          </span>
          <span className="brand-name">OpenMeet</span>
        </div>
        <button
          className="primary sidebar-new"
          disabled={disabled || props.recordingActive}
          onClick={(event) => props.onNewRecording(event.currentTarget)}
        >
          <span aria-hidden="true">＋</span> New recording
        </button>
        <button
          className="sidebar-new secondary-new"
          disabled={disabled}
          onClick={props.onNewNote}
        >
          <span aria-hidden="true">＋</span> New note
        </button>
        <label className="search-label">
          <span className="sr-only">Search meetings</span>
          <input
            type="search"
            value={search}
            onChange={(event) => props.onSearch(event.target.value)}
            placeholder="Search notes & meetings…"
          />
        </label>
        {tagChoices.length > 0 && (
          <select
            aria-label="Filter by tag"
            value={active}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">All tags</option>
            {tagChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <h2 className="sidebar-section-title">Recent meetings</h2>
      <div className="meeting-scroll">
        {meetings.length === 0 && (
          <p className="muted">Your meetings and notes will appear here.</p>
        )}
        {groupMeetings(visible).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="meeting-group-title">{group.label}</h3>
            <ul className="meeting-list">
              {group.meetings.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    disabled={disabled}
                    aria-current={
                      selectedId === meeting.id ? "true" : undefined
                    }
                    onClick={() => props.onOpenMeeting(meeting.id)}
                  >
                    <strong>{meeting.title}</strong>
                    <span className="meeting-item-meta">
                      <span>
                        {sourceLabels[meeting.source]}
                        {meeting.status === "stopped"
                          ? ""
                          : ` · ${meeting.status}`}
                        {meeting.tags.length > 0 &&
                          ` · ${meeting.tags.join(", ")}`}
                      </span>
                      <time dateTime={meeting.started_at}>
                        {new Date(meeting.started_at).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {matches.length > 0 && (
          <section aria-label="Matches in notes and transcripts">
            <h3 className="meeting-group-title">
              Matches in notes/transcripts
            </h3>
            <ul className="meeting-list">
              {matches.map((hit) => (
                <li key={`${hit.meeting_id}-${hit.kind}`}>
                  <button
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
            <p className="muted">No matching meetings.</p>
          )}
      </div>
      <div className="sidebar-bottom">
        <button onClick={(event) => props.onSettings(event.currentTarget)}>
          Settings
        </button>
        <p className="local-storage-note">
          Notes stored on this device
          {props.audioBytes !== null &&
            ` · Audio uses ${formatBytes(props.audioBytes)}`}
        </p>
      </div>
    </aside>
  );
}
