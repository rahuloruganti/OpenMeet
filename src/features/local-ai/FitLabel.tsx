import type { LocalAiFit } from "../../shared/api/api";
import { IconAlert, IconCheck, IconInfo } from "../../shared/ui/icons";
import { FIT } from "./labels";

/** The fit as a sentence first, an icon second: the colour is never the only signal. */
const FIT_ICON: Record<LocalAiFit, typeof IconCheck> = {
  gpu: IconCheck,
  ram: IconInfo,
  too_big: IconAlert,
};

export function FitLabel({ fit }: { fit: LocalAiFit }) {
  const Glyph = FIT_ICON[fit];
  return (
    <span className={`lai-fit lai-fit-${fit}`}>
      <Glyph size={14} />
      {FIT[fit]}
    </span>
  );
}
