import { useEffect, useRef, useState } from "react";
import { IconCheck } from "./icons";

/** Settings sections in page order: the left list, one visible at a time. */
export const settingsSections = [
  ["general", "General"],
  ["recording", "Recording"],
  ["transcription", "Transcription"],
  ["ai", "AI notes"],
  ["export", "Export & storage"],
  ["about", "Privacy & about"],
] as const;
export type SettingsSectionId = (typeof settingsSections)[number][0];
/** Ids kept working for callers written before the sections were merged. */
const aliases = { connections: "ai", models: "transcription" } as const;
export type SettingsSection = SettingsSectionId | keyof typeof aliases;
/** The visible section an id opens: `connections` is AI notes, `models` is Transcription. */
export const resolveSettingsSection = (
  id: SettingsSection,
): SettingsSectionId =>
  (aliases as Record<string, SettingsSectionId>)[id] ?? id;
/** An AI action that cannot run yet: why, and the Settings section that fixes it. */
export type AiBlock = { message: string; section: SettingsSection };
/** Opens Settings on a section; `trigger` gets focus back when Settings closes. */
export type OpenSettings = (
  section: SettingsSection,
  trigger: HTMLButtonElement,
) => void;

/** Opens Settings where a blocked AI action is fixed. */
export function OpenSettingsButton(props: {
  section: SettingsSection;
  onOpenSettings: OpenSettings;
}) {
  const id = resolveSettingsSection(props.section);
  const name = settingsSections.find(([section]) => section === id)?.[1];
  return (
    <button
      type="button"
      aria-label={`Open Settings for ${name}`}
      onClick={(event) =>
        props.onOpenSettings(props.section, event.currentTarget)
      }
    >
      Open Settings
    </button>
  );
}

/** A brief "Saved" tick after an autosaved change. */
export function useSaved() {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const mark = () => {
    setShown(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), 1600);
  };
  return { shown, mark };
}

/** The tick itself; polite, so a screen reader hears it without losing focus. */
export function Saved(props: { show: boolean }) {
  if (!props.show) return null;
  return (
    <span className="om-saved" aria-live="polite">
      <IconCheck size={12} />
      Saved
    </span>
  );
}
