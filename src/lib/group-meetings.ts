import type { Meeting } from "./api";

export type MeetingGroup = {
  label: "Today" | "Yesterday" | "Earlier";
  meetings: Meeting[];
};

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Buckets meetings by local calendar day; preserves input order. */
export function groupMeetings(
  meetings: Meeting[],
  now = new Date(),
): MeetingGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  const groups: MeetingGroup[] = [
    { label: "Today", meetings: [] },
    { label: "Yesterday", meetings: [] },
    { label: "Earlier", meetings: [] },
  ];
  for (const meeting of meetings) {
    const day = dayStart(new Date(meeting.started_at));
    // NaN (unparseable) fails both comparisons and lands in Earlier.
    const index = day >= today ? 0 : day === yesterday ? 1 : 2;
    groups[index].meetings.push(meeting);
  }
  return groups.filter((group) => group.meetings.length > 0);
}
