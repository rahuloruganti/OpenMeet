import type { Meeting } from "./api";

export const sourceLabels: Record<Meeting["source"], string> = {
  fixture: "Fictional sample",
  simulation: "Simulation",
  desktop: "Desktop capture",
};
