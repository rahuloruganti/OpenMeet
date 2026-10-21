import type { Meeting } from "./api";

export const sourceLabels: Record<Meeting["source"], string> = {
  fixture: "Fictional sample",
  simulation: "Simulation",
  desktop: "Desktop capture",
  note: "Note",
};

/** Each tag once, ignoring case, sorted; tags match case-insensitively. */
export const tagChoices = (meetings: Meeting[]) =>
  [
    ...new Map(
      meetings.flatMap((meeting) =>
        meeting.tags.map((name) => [name.toLocaleLowerCase(), name] as const),
      ),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
