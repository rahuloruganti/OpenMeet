import type { Meeting } from "../lib/api";
import { groupMeetings } from "../lib/group-meetings";
import { sourceLabels } from "../lib/meeting-labels";

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
  onLoadSample: () => void;
};

export function MeetingSidebar(props: Props) {
  const { meetings, search, selectedId, disabled } = props;
  const needle = search.trim().toLocaleLowerCase();
  const visible = meetings.filter((meeting) =>
    meeting.title.toLocaleLowerCase().includes(needle),
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
            O
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
        <label className="search-label">
          <span className="sr-only">Search meetings</span>
          <input
            type="search"
            value={search}
            onChange={(event) => props.onSearch(event.target.value)}
            placeholder="Search meetings…"
          />
        </label>
      </div>
      <h2 className="sidebar-section-title">Recent meetings</h2>
      <div className="meeting-scroll">
        {meetings.length === 0 && (
          <p className="muted">
            No meetings yet. Load the fictional sample or start a simulation.
          </p>
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
                    <span>
                      {sourceLabels[meeting.source]} · {meeting.status}
                    </span>
                    <time dateTime={meeting.started_at}>
                      {new Date(meeting.started_at).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric", year: "numeric" },
                      )}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {meetings.length > 0 && visible.length === 0 && (
          <p className="muted">No matching meetings.</p>
        )}
      </div>
      <div className="sidebar-bottom">
        <button onClick={(event) => props.onSettings(event.currentTarget)}>
          Settings
        </button>
        <button disabled={disabled} onClick={props.onLoadSample}>
          Load fictional sample
        </button>
        <p className="local-storage-note">Notes stored on this device</p>
      </div>
    </aside>
  );
}
