import type { ComponentProps, ReactNode, RefObject } from "react";
import { LibraryQuestion } from "../../../widgets/library-question";
import { MeetingSidebar } from "../../../widgets/meeting-sidebar";
import { MeetingWorkspace } from "../../../widgets/meeting-workspace";
import { RecordingControls } from "../../../widgets/recording-controls";
import { FeedbackStack, type FeedbackProps } from "./FeedbackStack";

export type Panel = "setup" | "settings" | "library" | null;

export type MeetingPageProps = {
  sidebarOpen: boolean;
  panel: Panel;
  workspaceRef: RefObject<HTMLElement | null>;
  sidebar: ComponentProps<typeof MeetingSidebar>;
  feedback: FeedbackProps;
  workspace: ComponentProps<typeof MeetingWorkspace>;
  controls: ComponentProps<typeof RecordingControls>;
  library: ComponentProps<typeof LibraryQuestion> | null;
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

/** The meeting view: navigation, workspace, recording controls, and the overlaid panels. */
export function MeetingPage(props: MeetingPageProps) {
  const { panel, close } = props;
  return (
    <div className={`app${props.sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <MeetingSidebar {...props.sidebar} />
      <main className="workspace" ref={props.workspaceRef} tabIndex={-1}>
        <header className="workspace-toolbar">
          <div className="toolbar-context">
            <button
              aria-label="Toggle meetings"
              aria-controls="meeting-sidebar"
              aria-expanded={props.sidebarOpen}
              onClick={props.onToggleSidebar}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                aria-hidden="true"
              >
                <rect x="2.5" y="3" width="15" height="14" rx="2" />
                <path d="M7.5 3v14" />
              </svg>
              <span>Meetings</span>
            </button>
            {!props.sidebarOpen && (
              <div className="collapsed-actions">
                <button
                  disabled={props.feedback.disabled || props.feedback.active}
                  onClick={(event) => props.onNewRecording(event.currentTarget)}
                >
                  New recording
                </button>
                <button
                  disabled={props.feedback.disabled}
                  onClick={props.onNewNote}
                >
                  New note
                </button>
                <button
                  onClick={(event) => props.onOpenSettings(event.currentTarget)}
                >
                  Settings
                </button>
              </div>
            )}
            <span className="toolbar-location">
              {panel === "settings"
                ? "Settings"
                : panel === "setup"
                  ? "New recording"
                  : panel === "library"
                    ? "Ask across meetings"
                    : "Workspace"}
            </span>
          </div>
          <details className="privacy-details">
            <summary>
              <span className="status-dot" aria-hidden="true" /> Local workspace
            </summary>
            <div className="privacy-popover">
              <strong>Your workspace is stored on this device.</strong>
              <p>
                Local transcription stays on this computer. Online transcription
                uploads audio and AI notes send text to the connection you
                chose, only when you use them.
              </p>
            </div>
          </details>
        </header>
        <FeedbackStack {...props.feedback} />
        {props.library && <LibraryQuestion {...props.library} />}
        {props.children}
        <MeetingWorkspace {...props.workspace} />
        <RecordingControls {...props.controls} />
        {close.requested && (
          <section
            className="close-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">Save and quit?</h2>
            <p>
              Your notes will be saved first. Any active recording will stop.
              Background processing will be cancelled.
            </p>
            {close.unsavedEdits && (
              <p role="alert">
                You have an unsaved summary or transcript edit. Keep working to
                save it, or quit to discard it.
              </p>
            )}
            {close.notesStatus === "error" && (
              <p role="alert">
                Your notes could not be saved: {close.notesErrorReason}.
                OpenMeet will not quit until they are saved. Copy your text, or
                keep working and retry.
              </p>
            )}
            <button
              autoFocus={!close.unsavedEdits && close.notesStatus !== "error"}
              disabled={close.busy || close.controlBusy}
              onClick={close.onQuit}
            >
              {close.unsavedEdits
                ? "Discard unsaved edits and quit"
                : "Save and quit"}
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
