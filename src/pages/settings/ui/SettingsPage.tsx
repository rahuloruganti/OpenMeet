import { SettingsPanel } from "../../../widgets/settings-panel";
import type { SettingsPageProps } from "../model/use-settings-page";

/** Settings screen: every section of the settings panel, opened on one of them. */
export function SettingsPage(props: SettingsPageProps) {
  return <SettingsPanel {...props} />;
}
