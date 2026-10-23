export const settingsSections = [
  ["recording", "Recording"],
  ["transcription", "Transcription"],
  ["ai", "AI notes"],
  ["connections", "Connections"],
  ["models", "Models"],
  ["export", "Export & storage"],
  ["about", "Privacy & about"],
] as const;
export type SettingsSection = (typeof settingsSections)[number][0];
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
  const name = settingsSections.find(([id]) => id === props.section)?.[1];
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
