import { SetupPanel } from "../../../widgets/setup-panel";
import { FirstRunSetup } from "../../../widgets/first-run-setup";
import type {
  FirstRunPageProps,
  SetupPageProps,
} from "../model/use-setup-page";

/** New-recording screen: title, devices, and starting capture. */
export function SetupPage(props: SetupPageProps) {
  return <SetupPanel {...props} />;
}

/** First-run wizard shown until setup is finished or skipped. */
export function FirstRunPage(props: FirstRunPageProps) {
  return <FirstRunSetup {...props} />;
}
