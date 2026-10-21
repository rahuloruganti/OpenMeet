import type { ReactNode } from "react";
import { isLocalBase, type ProcessingPlan } from "../lib/api";

/** The list on a text consent card: model and destination first, where the text goes last. */
export function TextConsent(props: {
  plan: ProcessingPlan;
  /** Follows the destination sentence in the last item. */
  note: string;
  children: ReactNode;
}) {
  return (
    <ul>
      <li>
        Model: <code>{props.plan.model}</code> via{" "}
        <code>{props.plan.base_url}</code>
      </li>
      {props.children}
      <li>
        {isLocalBase(props.plan.base_url)
          ? "Text is sent to your local server. Its configuration determines whether it forwards requests."
          : "The text leaves this device and is handled under your provider's terms."}{" "}
        {props.note}
      </li>
    </ul>
  );
}
