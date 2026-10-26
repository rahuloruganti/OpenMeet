import type { LocalAiFit } from "../../shared/api/api";

/** The fit as three words, matching the estimate the backend makes. */
export const FIT: Record<LocalAiFit, string> = {
  gpu: "Fits your GPU",
  ram: "Uses system RAM",
  too_big: "Too big",
};
