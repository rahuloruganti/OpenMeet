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
  close: {
    requested: boolean;
    unsavedEdits: boolean;
    notesStatus: string;
    notesErrorReason: string;
    busy: boolean;
    controlBusy: boolean;
    onQuit: () => void;
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
        {close.requested && (
          <section
            className="close-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">Save and quit?</h2>
            <p>
              Notes are saved first. The recording stops and background
              processing is cancelled.
            </p>
            {close.unsavedEdits && (
              <p role="alert">
                An unsaved summary or transcript edit will be discarded.
              </p>
            )}
            {close.notesStatus === "error" && (
              <p role="alert">
                Notes not saved: {close.notesErrorReason}. Quitting waits for
                them. Copy your text or retry.
              </p>
            )}
            <button
              autoFocus={!close.unsavedEdits && close.notesStatus !== "error"}
              disabled={close.busy || close.controlBusy}
              onClick={close.onQuit}
            >
              {close.unsavedEdits ? "Discard and quit" : "Save and quit"}
            </button>
            <button
              autoFocus={close.unsavedEdits || close.notesStatus === "error"}
              disabled={close.busy || close.controlBusy}
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
