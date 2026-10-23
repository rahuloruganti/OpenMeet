import type { Meeting } from "../../shared/api/api";

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

/** "Oct 23, 2026" */
export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));

/** "Oct 23, 2026, 10:15 AM" */
export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** "Oct 23", plus the year when it is not the current year. */
export const formatShortDate = (iso: string, now = new Date()) => {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
};

/** A path without the Windows `\\?\` long-path prefix the backend may add when it canonicalizes. */
export const displayPath = (path: string) => path.replace(/^\\\\\?\\/, "");

/** "9:30 AM", the start time without a date. */
export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** Lowercase with accents removed, so "cafe" finds "Café" and "angstrom" finds "Ångström". */
export const foldText = (text: string) =>
  text.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
