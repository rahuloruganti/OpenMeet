import type { ComponentProps, ReactNode, RefObject } from "react";
import { MeetingSidebar } from "../../../widgets/meeting-sidebar";
import { MeetingWorkspace } from "../../../widgets/meeting-workspace";
import { RecordingControls } from "../../../widgets/recording-controls";
import { FeedbackStack, type FeedbackProps } from "./FeedbackStack";
import { ProcessingStatus } from "./ProcessingStatus";

export type Panel = "setup" | "settings" | "library" | null;

export type MeetingPageProps = {
  sidebarOpen: boolean;
  panel: Panel;
  workspaceRef: RefObject<HTMLElement | null>;
  sidebar: ComponentProps<typeof MeetingSidebar>;
  feedback: FeedbackProps;
  workspace: ComponentProps<typeof MeetingWorkspace>;
  controls: ComponentProps<typeof RecordingControls>;
  /** Quitting saves everything by default; this dialog only lists what could not be saved. */
  close: {
    requested: boolean;
    /** One sentence per thing that is not saved; empty while saving or when nothing failed. */
    problems: string[];
    /** Notes failed: Quit anyway is not offered, so notes are never discarded. */
    notesFailed: boolean;
    /** A close save or Quit anyway is running; the editors are locked and the buttons wait. */
    saving: boolean;
    onRetry: () => void;
    onQuitAnyway: () => void;
    onKeepWorking: () => void;
  };
  onToggleSidebar: () => void;
  onNewRecording: (trigger: HTMLButtonElement) => void;
  onNewNote: () => void;
  onOpenSettings: (trigger: HTMLButtonElement) => void;
  /** Panels of the other pages (setup, first run, settings) that open over this one. */
  children?: ReactNode;
};

/**
 * The meeting view: sidebar, document with inspector, one status line for
 * processing, recording bar, and the overlays that open on top.
 */
export function MeetingPage(props: MeetingPageProps) {
  const { close, feedback } = props;
  const processing = feedback.processing;
  const banners = <FeedbackStack {...feedback} />;
  return (
    <div className={`app${props.sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <MeetingSidebar {...props.sidebar} />
      <main
        className="workspace meeting-main"
        ref={props.workspaceRef}
        tabIndex={-1}
      >
        {props.children}
        {/* The empty home has no meeting to hang the warnings on, so they stay here. */}
        {!props.workspace.selected && (
          <div className="home-banners">{banners}</div>
        )}
        <MeetingWorkspace
          {...props.workspace}
          sidebarOpen={props.sidebarOpen}
          onToggleSidebar={props.onToggleSidebar}
          banners={props.workspace.selected ? banners : null}
          status={
            processing ? (
              <ProcessingStatus
                processing={processing}
                busy={feedback.busy}
                active={feedback.active}
                ackError={feedback.ackError}
                onAcknowledgeNotes={feedback.onAcknowledgeNotes}
                onCancel={feedback.onCancelProcessing}
                onRetry={feedback.onRetryProcessing}
                onDismiss={feedback.onDismissProcessing}
              />
            ) : null
          }
        />
        <RecordingControls {...props.controls} />
        {close.requested && close.saving && (
          <p className="mw-hint" role="status">
            Saving before quit. Editing is locked until it finishes.
          </p>
        )}
        {close.requested && close.problems.length > 0 && (
          <section
            className="close-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">Not saved yet</h2>
            <p>OpenMeet saves everything when you quit. This did not save:</p>
            <ul role="alert">
              {close.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            <p>
              {close.notesFailed
                ? "Copy your notes or try again. Quitting waits for them."
                : "Quit anyway discards these edits."}
            </p>
            <button disabled={close.saving} onClick={close.onRetry}>
              Try again
            </button>
            {!close.notesFailed && (
              <button disabled={close.saving} onClick={close.onQuitAnyway}>
                Quit anyway
              </button>
            )}
            <button
              autoFocus
              disabled={close.saving}
              onClick={close.onKeepWorking}
            >
              Keep working
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
