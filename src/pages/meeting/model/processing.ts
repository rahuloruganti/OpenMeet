import type { SessionProcessingSnapshot } from "../../../shared/api/api";

/** Final summary processing waits for this session's saved notes to be acknowledged. */
export const awaitingNotes = (snapshot: SessionProcessingSnapshot) =>
  snapshot.plan.scope.kind === "final" &&
  snapshot.plan.scope.summary !== null &&
  !!snapshot.workflow?.notes_barrier &&
  snapshot.workflow.notes_revision === null &&
  ["finalizing_audio", "transcribing", "awaiting_notes"].includes(
    snapshot.workflow.stage,
  );

/** Stages after which a run can no longer be cancelled. */
export const endedStages = [
  "completed",
  "cancelled",
  "interrupted",
  "failed",
  "needs_attention",
];

/** Stages that can be retried. */
export const retryStages = [
  "failed",
  "cancelled",
  "interrupted",
  "needs_attention",
];
