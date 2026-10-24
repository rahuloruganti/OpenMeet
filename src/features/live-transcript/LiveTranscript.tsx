import { useLayoutEffect, useRef, useState } from "react";
import type { LiveLine, SpeakerNames } from "../../shared/api/api";
import { speakerLabel } from "../../shared/api/api";
import { formatTimestamp } from "../../shared/lib/timestamps";
import {
  OpenSettingsButton,
  type OpenSettings,
} from "../../shared/ui/settings-link";
import { paragraphs, partialSlots, type Paragraph } from "./lines";
import { useLiveTranscript } from "./use-live-transcript";
import "./live-transcript.css";

type Props = {
  meetingId: string;
  /** The recording is paused: no new text arrives while it stays paused. */
  paused: boolean;
  /** The recording ended and the final transcript is not ready yet. */
  provisional: boolean;
  names: SpeakerNames;
  onOpenSettings: OpenSettings;
};

/** Shown until the backend reports a state, and while it is coming up. */
const STARTING = "Starting live transcript.";

/** `[mm:ss]` reads better without the brackets above a paragraph. */
const stamp = (ms: number) => formatTimestamp(ms).replace(/^\[|\]$/g, "");

/** What the status line says about the engine and its state. */
function statusOf(state: string) {
  if (state === "off") return "Off";
  if (state === "starting") return "Starting";
  if (state === "running") return "Live";
  return "Stopped";
}

/**
 * The live transcript of the meeting being recorded, in Otter's shape: one paragraph per speaker
 * run, the muted partials after every final in start order, and a status line that names the engine.
 */
export function LiveTranscript(props: Props) {
  const { transcript, lines, partials, error } = useLiveTranscript(
    props.meetingId,
    props.paused,
  );
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const state = transcript?.state ?? "starting";
  const notice = error ?? transcript?.notice ?? null;
  const blocks = paragraphs(lines);
  const slots = partialSlots(blocks, partials);
  const quiet = blocks.length === 0 && partials.length === 0;
  const off = state === "off";
  const said = notice !== null || off;

  // Follow the newest line only while the reader is already at the bottom.
  useLayoutEffect(() => {
    if (!following) return;
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [following, lines, partials]);

  const follow = () => {
    setFollowing(true);
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // Nothing to say: live never ran for this finished recording.
  if (quiet && !said && state !== "starting" && state !== "running")
    return null;

  const renderPartial = (partial: LiveLine) => (
    <p className="lt-line lt-partial" key={`partial-${partial.id}`}>
      <span className="lt-time">{stamp(partial.start_ms)}</span>{" "}
      <strong>{speakerLabel(props.names, partial.speaker)}</strong>{" "}
      <span className="lt-muted">{partial.text}</span>
      <span className="lt-caret" aria-hidden="true" />
    </p>
  );

  return (
    <section className="lt" aria-label="Live transcript">
      <p className="lt-head">
        <strong className="lt-engine">
          {transcript?.engine ?? "Live transcript"}
        </strong>
        <span className="lt-tag">{statusOf(state)}</span>
        {transcript?.leaves_device && (
          <span className="lt-tag lt-leaves">Leaves this device</span>
        )}
        {props.paused && <span className="lt-tag">Paused</span>}
        {props.provisional && <span className="lt-tag">Provisional</span>}
      </p>

      {said && (
        <p className="lt-notice" role="status">
          {notice ?? "Live transcript is off."}
          {off && (
            <>
              {" "}
              <OpenSettingsButton
                section="recording"
                onOpenSettings={props.onOpenSettings}
              />
            </>
          )}
        </p>
      )}

      {quiet ? (
        !said && (
          <p className="lt-hint">
            {state === "starting" ? STARTING : "Listening."}
          </p>
        )
      ) : (
        <div
          className="lt-scroll"
          role="group"
          aria-label="Live transcript lines"
          ref={box}
          onScroll={() => {
            const element = box.current;
            if (!element) return;
            setFollowing(
              element.scrollHeight - element.scrollTop - element.clientHeight <=
                8,
            );
          }}
        >
          {/* With no final yet, the partials are all there is. */}
          {(slots.get(0) ?? []).map(renderPartial)}
          {blocks.map((block: Paragraph, index) => (
            <div className="lt-block" key={block.key}>
              {/* Polite only on finals: a partial changing per word must stay silent. */}
              <p className="lt-line" aria-live="polite">
                <span className="lt-time">{stamp(block.start_ms)}</span>{" "}
                <strong>{speakerLabel(props.names, block.speaker)}</strong>{" "}
                <span>{block.text}</span>
              </p>
              {(slots.get(index + 1) ?? []).map(renderPartial)}
            </div>
          ))}
        </div>
      )}

      {!following && !quiet && (
        <button type="button" className="lt-jump" onClick={follow}>
          Jump to live
        </button>
      )}
    </section>
  );
}
