import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  speakerLabel,
  type MeetingDetail,
  type SpeakerNames,
} from "../../../shared/api/api";
import { api } from "../../../shared/api/api";
import { groupTurns } from "../../../shared/lib/turns";
import {
  findInSegments,
  formatClock,
  formatTranscript,
  type TextMatch,
} from "../../../shared/lib/transcript-text";
import {
  fileDriftMs,
  sessionFromFile,
  SYNC_DRIFT_MS,
} from "../../../shared/lib/playback-sync";
import { formatBytes } from "../../../entities/meeting";
import { SpeakerNamesForm } from "../../../features/speaker-names";
import { LiveTranscript, liveSeen } from "../../../features/live-transcript";
import type { OpenSettings } from "../../../shared/ui/settings-link";
import "../../../shared/ui/transcript-turns.css";

const PAGE = 200;

const trackLabels: Record<string, string> = {
  mic: "You (microphone)",
  system: "Others (system audio)",
};

type Draft = {
  meetingId: string;
  segmentId: number;
  baseText: string;
  text: string;
};

type Anchor = {
  sessionMs: number;
  files: Record<string, number>;
  leader: string;
};

type Popover = { kind: "speakers" | "more"; top: number; left: number };

export type TranscriptModel = {
  hidden: boolean;
  tab: "notes" | "summary" | "transcript";
  selected: MeetingDetail;
  disabled: boolean;
  job: string | null;
  speechReady: boolean;
  speechReason: string;
  sttMode: "local" | "cloud";
  transcribeProgress: Record<string, number>;
  segmentDraft: Draft | null;
  highlighted: number[];
  shownCount: number;
  onShowThrough: (count: number) => void;
  playersRef: MutableRefObject<Record<string, HTMLAudioElement | null>>;
  playbackError: string;
  setPlaybackError: (message: string) => void;
  onSeek: (kind: string, sessionMs: number) => Promise<number | null>;
  onSegmentDraft: (draft: Draft | null) => void;
  onSaveSegment: (draft: Draft) => Promise<boolean>;
  onTranscribe: () => void;
  onCancelTranscribe: () => void;
  onOpenHistory: (opener: HTMLElement) => void;
  onSpeakerNames: (meetingId: string, names: SpeakerNames) => void;
  onOpenSettings: OpenSettings;
};

type Playable = MeetingDetail["tracks"][number];

type Ctx = TranscriptModel & {
  playable: Playable[];
  liveNow: boolean;
  hasTranscript: boolean;
  sessionMs: number;
  playing: boolean;
  rate: number;
  muted: Record<string, boolean>;
  options: boolean;
  setOptions: (value: boolean | ((value: boolean) => boolean)) => void;
  away: boolean;
  backToPlaying: () => void;
  seekTo: (sessionMs: number, shouldPlay: boolean) => Promise<void>;
  togglePlay: () => void;
  setRate: (rate: number) => void;
  toggleMute: (kind: string) => void;
  query: string;
  setQuery: (value: string) => void;
  matchAt: number;
  matches: TextMatch[];
  stepMatch: (dir: number) => void;
  clearQuery: () => void;
  findRef: MutableRefObject<HTMLInputElement | null>;
  copyLabel: string;
  copyTranscript: () => void;
  pop: Popover | null;
  popRef: MutableRefObject<HTMLDivElement | null>;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  togglePop: (kind: Popover["kind"], anchor: HTMLElement) => void;
  closePop: () => void;
  retranscribing: boolean;
  setRetranscribing: (value: boolean) => void;
  retranscribeButton: MutableRefObject<HTMLButtonElement | null>;
  retranscribeCancel: MutableRefObject<HTMLButtonElement | null>;
  hoverId: number | null;
  setHoverId: (id: number | null) => void;
  playingIndex: number | null;
  liveFind: boolean;
  setLiveCount: (count: number) => void;
  onPlainText: (text: string) => void;
};

const TranscriptContext = createContext<Ctx | null>(null);

function useTranscript() {
  const value = useContext(TranscriptContext);
  if (!value) throw new Error("Transcript tab is outside its provider");
  return value;
}

function playableTracks(selected: MeetingDetail): Playable[] {
  const { meeting } = selected;
  return meeting.source === "desktop" &&
    meeting.status !== "recording" &&
    meeting.status !== "paused"
    ? selected.tracks.filter((track) => track.finalized && track.frames > 0)
    : [];
}

function meetingDuration(selected: MeetingDetail, playable: Playable[]) {
  const { started_at, ended_at } = selected.meeting;
  if (ended_at) {
    const span = new Date(ended_at).getTime() - new Date(started_at).getTime();
    if (span > 0) return span;
  }
  return playable.reduce((max, track) => {
    const ms =
      track.sample_rate > 0 ? (track.frames / track.sample_rate) * 1000 : 0;
    return Math.max(max, ms);
  }, 0);
}

// play() on an element that has ended, or sits at its duration, restarts it from zero.
function exhausted(element: HTMLMediaElement | null | undefined) {
  return (
    !!element &&
    (element.ended ||
      (element.duration > 0 && element.currentTime >= element.duration))
  );
}

function timeLabel(segment: MeetingDetail["segments"][number]) {
  return segment.timing.kind === "timed"
    ? formatClock(segment.timing.start_ms)
    : "Untimed";
}

function indexAt(segments: MeetingDetail["segments"], sessionMs: number) {
  let found: number | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const timing = segments[index]?.timing;
    if (!timing || timing.kind !== "timed") continue;
    if (timing.start_ms <= sessionMs) found = index;
    else if (found !== null) break;
  }
  return found;
}

function marked(
  text: string,
  ranges: { start: number; end: number; current: boolean }[],
) {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={index} className={range.current ? "tx-cur" : undefined}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

const IconSearch = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

const IconUp = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 10l4-4 4 4" />
  </svg>
);

const IconDown = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 6l4 4 4-4" />
  </svg>
);

const IconDots = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="3.5" cy="8" r="1.15" fill="currentColor" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.15" fill="currentColor" />
  </svg>
);

const IconPlay = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M5 3.2v9.6L13 8z" fill="currentColor" />
  </svg>
);

const IconPause = () => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4.5 3.5h2.2v9H4.5zM9.3 3.5h2.2v9H9.3z" fill="currentColor" />
  </svg>
);

const IconSpeaker = ({ off }: { off: boolean }) =>
  off ? (
    <svg
      className="tx-spk-off"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6.2h2.1L8 4v8L5.1 9.8H3z" />
      <path d="M10.4 6.2a2.3 2.3 0 0 1 0 3.6" />
      <path d="M3.2 13L12.8 3" />
    </svg>
  ) : (
    <svg
      className="tx-spk"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6.2h2.1L8 4v8L5.1 9.8H3z" />
      <path d="M10.4 6.2a2.3 2.3 0 0 1 0 3.6" />
      <path d="M12 4.8a4.2 4.2 0 0 1 0 6.4" />
    </svg>
  );

export function TranscriptProvider(
  props: TranscriptModel & { children: ReactNode },
) {
  const { selected, children } = props;
  const meeting = selected.meeting;
  const playable = playableTracks(selected);
  const liveNow = meeting.status === "recording" || meeting.status === "paused";
  const hasTranscript = selected.segments.length > 0;
  const playableRef = useRef(playable);
  playableRef.current = playable;
  const propsRef = useRef(props);
  propsRef.current = props;

  const [sessionMs, setSessionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState(false);
  const [away, setAway] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchAt, setMatchAt] = useState(0);
  const [copyLabel, setCopyLabel] = useState("");
  const [pop, setPop] = useState<Popover | null>(null);
  const [retranscribing, setRetranscribing] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [liveCount, setLiveCount] = useState(0);
  const [livePlain, setLivePlain] = useState("");

  const anchorRef = useRef<Anchor | null>(null);
  const playingRef = useRef(false);
  // Set once a playback run has audio audible; silence after that means every track ended.
  const heardRef = useRef(false);
  const rateRef = useRef(1);
  const mutedRef = useRef<Record<string, boolean>>({});
  const sessionRef = useRef(0);
  const followingRef = useRef(true);
  const programmatic = useRef(false);
  const findRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const retranscribeButton = useRef<HTMLButtonElement | null>(null);
  const retranscribeCancel = useRef<HTMLButtonElement | null>(null);
  const copyTimer = useRef<number | null>(null);
  // Bumped by each seek, pause and meeting switch; async work from an older generation is dropped.
  const seekGen = useRef(0);

  sessionRef.current = sessionMs;
  playingRef.current = playing;
  rateRef.current = rate;
  mutedRef.current = muted;

  const liveFind =
    !hasTranscript &&
    (liveNow ||
      (meeting.source === "desktop" &&
        meeting.status === "stopped" &&
        liveSeen(meeting.id)));

  const texts = useMemo(
    () =>
      selected.segments.map((segment, index) => {
        const meta = selected.segment_meta[index];
        if (
          meta &&
          props.segmentDraft?.meetingId === meeting.id &&
          props.segmentDraft.segmentId === meta.id
        )
          return props.segmentDraft.text;
        return segment.text;
      }),
    [selected.segments, selected.segment_meta, props.segmentDraft, meeting.id],
  );

  const finishedMatches = useMemo(
    () => (liveFind ? [] : findInSegments(texts, query)),
    [liveFind, texts, query],
  );
  const matches = liveFind
    ? Array.from({ length: liveCount }, (_, index) => ({
        segmentIndex: index,
        start: 0,
        end: 0,
      }))
    : finishedMatches;

  const totalMs = meetingDuration(selected, playable);
  const totalRef = useRef(totalMs);
  totalRef.current = totalMs;

  const playingIndex = playing ? indexAt(selected.segments, sessionMs) : null;

  // Plays every live track and waits for all of them. If any refuses, nothing stays audible.
  // A track that already reached its end is left out: play() would restart it from zero.
  const startPlayback = useCallback(async (tracks: Playable[], gen: number) => {
    const live = tracks.filter(
      (track) => !exhausted(propsRef.current.playersRef.current[track.kind]),
    );
    if (live.length === 0) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    heardRef.current = false;
    const results = await Promise.allSettled(
      live.map(
        (track) =>
          propsRef.current.playersRef.current[track.kind]?.play() ??
          Promise.resolve(),
      ),
    );
    if (gen !== seekGen.current) return;
    if (results.some((result) => result.status === "rejected")) {
      for (const track of live)
        propsRef.current.playersRef.current[track.kind]?.pause();
      playingRef.current = false;
      setPlaying(false);
      propsRef.current.setPlaybackError(
        "Audio could not play. Check your output device and try again.",
      );
      return;
    }
    // Audio is audible now, so a later silence means it ended rather than never started.
    heardRef.current = live.some((track) => {
      const element = propsRef.current.playersRef.current[track.kind];
      return !!element && !element.paused;
    });
    playingRef.current = true;
    setPlaying(true);
  }, []);

  const seekTo = useCallback(
    async (nextMs: number, shouldPlay: boolean) => {
      const gen = ++seekGen.current;
      const tracks = playableRef.current;
      // Do not clamp to the meeting length: a segment can start after pauses
      // that the wall clock does not include. The scrubber clamps on its own.
      const bounded = Math.max(0, nextMs);
      const files: Record<string, number> = {};
      for (const track of tracks) {
        const file = await propsRef.current.onSeek(track.kind, bounded);
        // A newer seek, a pause or another meeting superseded this one.
        if (gen !== seekGen.current) return;
        if (file === null) return;
        files[track.kind] = file;
      }
      const leader =
        tracks.find((track) => !mutedRef.current[track.kind])?.kind ??
        tracks[0]?.kind;
      if (!leader) return;
      // Approximate across pauses inside a recording. Re-anchor at each seek.
      anchorRef.current = { sessionMs: bounded, files, leader };
      setSessionMs(bounded);
      sessionRef.current = bounded;
      followingRef.current = true;
      setAway(false);
      for (const track of tracks) {
        const element = propsRef.current.playersRef.current[track.kind];
        if (!element) continue;
        element.currentTime = (files[track.kind] ?? 0) / 1000;
        element.playbackRate = rateRef.current;
        element.muted = !!mutedRef.current[track.kind];
      }
      if (!shouldPlay) return;
      propsRef.current.setPlaybackError("");
      await startPlayback(tracks, gen);
    },
    [startPlayback],
  );

  const pause = useCallback(() => {
    seekGen.current += 1;
    for (const track of playableRef.current)
      propsRef.current.playersRef.current[track.kind]?.pause();
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pause();
      return;
    }
    if (anchorRef.current) {
      propsRef.current.setPlaybackError("");
      // Every track has finished: Play starts the meeting again.
      if (
        playableRef.current.every((track) =>
          exhausted(propsRef.current.playersRef.current[track.kind]),
        )
      ) {
        void seekTo(0, true);
        return;
      }
      void startPlayback(playableRef.current, ++seekGen.current);
      return;
    }
    void seekTo(sessionRef.current, true);
  }, [pause, seekTo, startPlayback]);

  const setRate = useCallback((next: number) => {
    rateRef.current = next;
    setRateState(next);
    for (const track of playableRef.current) {
      const element = propsRef.current.playersRef.current[track.kind];
      if (element) element.playbackRate = next;
    }
  }, []);

  const toggleMute = useCallback((kind: string) => {
    const next = !mutedRef.current[kind];
    const map = { ...mutedRef.current, [kind]: next };
    mutedRef.current = map;
    setMuted(map);
    const element = propsRef.current.playersRef.current[kind];
    if (element) element.muted = next;
    const anchor = anchorRef.current;
    if (anchor && next && anchor.leader === kind) {
      const replacement = playableRef.current.find(
        (track) => track.kind !== kind && !map[track.kind],
      );
      if (replacement)
        anchorRef.current = { ...anchor, leader: replacement.kind };
    }
  }, []);

  useEffect(() => {
    setQueryState("");
    setMatchAt(0);
    setRetranscribing(false);
    setPop(null);
    setCopyLabel("");
    setHoverId(null);
    setLiveCount(0);
    setLivePlain("");
    setSessionMs(0);
    setPlaying(false);
    setRateState(1);
    setMuted({});
    setAway(false);
    setOptions(false);
    anchorRef.current = null;
    playingRef.current = false;
    rateRef.current = 1;
    mutedRef.current = {};
    followingRef.current = true;
    sessionRef.current = 0;
    seekGen.current += 1;
  }, [meeting.id]);

  useEffect(() => {
    if (props.tab === "transcript" && !props.hidden) return;
    playingRef.current = false;
    setPlaying(false);
  }, [props.tab, props.hidden]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let painted = 0;
    const audible = (kind: string) => {
      const element = propsRef.current.playersRef.current[kind];
      return element && !element.paused ? element : null;
    };
    const finish = (anchor: Anchor | null) => {
      // Show the furthest point any track reached, not a frozen position.
      let end = sessionRef.current;
      if (anchor) {
        for (const track of playableRef.current) {
          const element = propsRef.current.playersRef.current[track.kind];
          if (!element) continue;
          end = Math.max(
            end,
            sessionFromFile(
              anchor.sessionMs,
              anchor.files[track.kind] ?? 0,
              element.currentTime,
            ),
          );
        }
      }
      playingRef.current = false;
      sessionRef.current = end;
      setSessionMs(end);
      setPlaying(false);
    };
    const tick = (now: number) => {
      let anchor = anchorRef.current;
      // A shorter track that ends reports itself paused. Move the clock to a track still playing.
      if (anchor && !audible(anchor.leader)) {
        const next = playableRef.current.find((track) => audible(track.kind));
        if (next) {
          anchor = { ...anchor, leader: next.kind };
          anchorRef.current = anchor;
        }
      }
      if (playableRef.current.some((track) => audible(track.kind))) {
        heardRef.current = true;
      } else if (heardRef.current) {
        // Every track ended or paused on its own: leave the Pause state.
        finish(anchor);
        return;
      }
      const leader = anchor ? audible(anchor.leader) : null;
      if (anchor && leader) {
        const session = sessionFromFile(
          anchor.sessionMs,
          anchor.files[anchor.leader] ?? 0,
          leader.currentTime,
        );
        for (const track of playableRef.current) {
          if (track.kind === anchor.leader) continue;
          const other = propsRef.current.playersRef.current[track.kind];
          if (!other || other.paused) continue;
          const drift = fileDriftMs(
            anchor.files[track.kind] ?? 0,
            anchor.sessionMs,
            session,
            other.currentTime,
          );
          if (Math.abs(drift) > SYNC_DRIFT_MS) {
            const expected =
              (anchor.files[track.kind] ?? 0) + (session - anchor.sessionMs);
            other.currentTime = Math.max(0, expected / 1000);
          }
        }
        if (now - painted > 200) {
          painted = now;
          setSessionMs(session);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (playingIndex === null || playingIndex < props.shownCount) return;
    props.onShowThrough(playingIndex + 1);
  }, [playingIndex, props.shownCount, props.onShowThrough]);

  useEffect(() => {
    if (!playing || !followingRef.current || playingIndex === null) return;
    const meta = selected.segment_meta[playingIndex];
    const element = meta ? document.getElementById(`segment-${meta.id}`) : null;
    if (!element) return;
    programmatic.current = true;
    element.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => {
      programmatic.current = false;
    }, 80);
    return () => window.clearTimeout(timer);
  }, [playing, playingIndex, props.shownCount, selected.segment_meta]);

  useEffect(() => {
    const scroller = rootRef.current?.closest(".mw-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const onScroll = () => {
      if (programmatic.current || !playingRef.current) return;
      followingRef.current = false;
      setAway(true);
    };
    scroller.addEventListener("scroll", onScroll);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [meeting.id, props.tab]);

  useEffect(() => {
    if (props.tab !== "transcript" || props.hidden) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        findRef.current?.focus();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable ||
        tag === "BUTTON" ||
        tag === "SUMMARY"
      )
        return;
      // Arrows on the scrubber are handled there so a key is not applied twice.
      if (
        target?.getAttribute("role") === "slider" &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      )
        return;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step =
        (event.shiftKey ? 30_000 : 5_000) *
        (event.key === "ArrowLeft" ? -1 : 1);
      const next = Math.max(
        0,
        Math.min(totalRef.current, sessionRef.current + step),
      );
      void seekTo(next, playingRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.tab, props.hidden, seekTo, togglePlay]);

  useEffect(() => {
    if (!retranscribing) return;
    retranscribeCancel.current?.focus();
  }, [retranscribing]);

  useEffect(() => {
    if (!pop) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popRef.current?.contains(target)) return;
      if (target instanceof HTMLElement && target.closest("[data-tx-pop]"))
        return;
      setPop(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPop(null);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  const setQuery = (value: string) => {
    setQueryState(value);
    setMatchAt(0);
  };
  const clearQuery = () => setQuery("");
  const stepMatch = (dir: number) => {
    if (matches.length === 0) return;
    setMatchAt((current) => (current + dir + matches.length) % matches.length);
  };

  const copyTranscript = () => {
    const turns = groupTurns(
      selected.segments.map((segment, index) => ({
        speaker: segment.speaker,
        startMs:
          segment.timing.kind === "timed" ? segment.timing.start_ms : null,
        text: texts[index] ?? segment.text,
      })),
    ).map((turn) => ({
      label: speakerLabel(selected.speaker_names, turn.speaker),
      startMs: turn.startMs,
      text: turn.segments.map((segment) => segment.text).join(" "),
    }));
    const text = liveFind ? livePlain : formatTranscript(turns);
    const finish = (label: string) => {
      setCopyLabel(label);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyLabel(""), 1500);
    };
    void navigator.clipboard.writeText(text).then(
      () => finish("Copied"),
      () => finish("Could not copy"),
    );
  };

  const togglePop = (kind: Popover["kind"], anchor: HTMLElement) => {
    if (pop?.kind === kind) {
      setPop(null);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const width = kind === "more" ? 320 : 280;
    setPop({
      kind,
      top: box.bottom - bounds.top + 6,
      left: Math.max(0, Math.min(box.left - bounds.left, bounds.width - width)),
    });
  };
  const closePop = () => setPop(null);

  const backToPlaying = () => {
    followingRef.current = true;
    setAway(false);
    const meta =
      playingIndex === null ? undefined : selected.segment_meta[playingIndex];
    const element = meta ? document.getElementById(`segment-${meta.id}`) : null;
    programmatic.current = true;
    element?.scrollIntoView({ block: "center" });
    window.setTimeout(() => {
      programmatic.current = false;
    }, 80);
  };

  const onPlainText = useCallback((text: string) => {
    setLivePlain((current) => (current === text ? current : text));
  }, []);

  const value: Ctx = {
    ...props,
    playable,
    liveNow,
    hasTranscript,
    sessionMs,
    playing,
    rate,
    muted,
    options,
    setOptions,
    away,
    backToPlaying,
    seekTo,
    togglePlay,
    setRate,
    toggleMute,
    query,
    setQuery,
    matchAt: matches.length === 0 ? 0 : matchAt % matches.length,
    matches,
    stepMatch,
    clearQuery,
    findRef,
    copyLabel,
    copyTranscript,
    pop,
    popRef,
    rootRef,
    togglePop,
    closePop,
    retranscribing,
    setRetranscribing,
    retranscribeButton,
    retranscribeCancel,
    hoverId,
    setHoverId,
    playingIndex,
    liveFind,
    setLiveCount,
    onPlainText,
  };

  return (
    <TranscriptContext.Provider value={value}>
      {children}
      {playable.map((track) => (
        <audio
          className="tx-audio"
          key={track.kind}
          preload="metadata"
          aria-label={trackLabels[track.kind] ?? track.kind}
          src={api.audioSrc(track.path)}
          onError={() =>
            props.setPlaybackError(
              "An audio file could not be opened. It may have been moved.",
            )
          }
          ref={(element) => {
            props.playersRef.current[track.kind] = element;
          }}
        />
      ))}
    </TranscriptContext.Provider>
  );
}

function engineLine(selected: MeetingDetail) {
  if (selected.meeting.source !== "desktop" || selected.segments.length === 0)
    return "";
  if (selected.transcript_provider === "whisper")
    return "Transcribed locally with Whisper. Check names and numbers.";
  const provider = selected.transcript_provider ?? "an earlier engine";
  const model = selected.transcript_model
    ? ` / ${selected.transcript_model}`
    : "";
  return `Transcribed with ${provider}${model}. Check names and numbers.`;
}

export function TranscriptPanel() {
  const model = useTranscript();
  const { selected } = model;
  const meeting = selected.meeting;
  const sentinel = useRef<HTMLDivElement>(null);
  const showRef = useRef(model.onShowThrough);
  showRef.current = model.onShowThrough;
  const editLocked = model.disabled || model.job !== null || model.liveNow;
  const liveShown =
    model.liveNow ||
    (meeting.source === "desktop" &&
      meeting.status === "stopped" &&
      !model.hasTranscript &&
      liveSeen(meeting.id));
  const transcribable = model.playable.length > 0;
  const hints = !model.hasTranscript
    ? transcribable
      ? "No transcript yet."
      : meeting.source === "note"
        ? "Notes have no recorded audio."
        : meeting.source !== "desktop"
          ? "Samples and simulations have no audio."
          : meeting.status === "recording" || meeting.status === "paused"
            ? "Stop the recording first."
            : "No finalized audio tracks."
    : "";
  const warnings = [
    ...selected.tracks
      .filter((track) => track.finalized && track.frames === 0)
      .map((track) =>
        track.kind === "mic"
          ? "Microphone track is empty. Check the device and its mute."
          : "System track is empty: no other app played audio.",
      ),
    ...(transcribable && !model.speechReady ? [model.speechReason] : []),
  ];
  const rendered = selected.segments.slice(0, model.shownCount);
  const turns = groupTurns(
    rendered.map((segment, offset) => ({
      speaker: segment.speaker,
      startMs: segment.timing.kind === "timed" ? segment.timing.start_ms : null,
      index: offset,
    })),
  );
  const more = model.shownCount < selected.segments.length;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more) return;
    const root = node.closest(".mw-scroll");
    const grow = () =>
      showRef.current(
        Math.min(selected.segments.length, model.shownCount + PAGE),
      );
    if (typeof IntersectionObserver !== "function") {
      if (!(root instanceof HTMLElement)) return;
      const onScroll = () => {
        if (root.scrollHeight <= root.clientHeight + 1) return;
        if (root.scrollHeight - root.scrollTop - root.clientHeight < 320)
          grow();
      };
      root.addEventListener("scroll", onScroll);
      return () => root.removeEventListener("scroll", onScroll);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      {
        root: root instanceof HTMLElement ? root : undefined,
        rootMargin: "240px",
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, model.shownCount, selected.segments.length]);

  useLayoutEffect(() => {
    if (model.liveFind || !model.query.trim() || model.matches.length === 0)
      return;
    const match = model.matches[model.matchAt];
    if (!match) return;
    if (match.segmentIndex >= model.shownCount) {
      model.onShowThrough(match.segmentIndex + 1);
      return;
    }
    document
      .querySelector("#panel-transcript mark.tx-cur")
      ?.scrollIntoView({ block: "center" });
  }, [
    model.liveFind,
    model.query,
    model.matchAt,
    model.matches,
    model.shownCount,
    model.onShowThrough,
  ]);

  const transcribeLabel =
    model.job === "transcribe"
      ? "Transcribing"
      : model.hasTranscript
        ? "Re-transcribe audio"
        : "Transcribe audio";

  return (
    <div
      className={`tx${model.liveNow ? (meeting.status === "paused" ? " is-paused" : " is-live") : ""}`}
      ref={model.rootRef}
    >
      <div className="tx-toolbar" role="toolbar" aria-label="Transcript">
        <div className="tx-find">
          <div className="tx-find-field">
            <IconSearch />
            <input
              ref={model.findRef}
              type="search"
              placeholder="Find in transcript"
              aria-label="Find in transcript"
              autoComplete="off"
              spellCheck={false}
              value={model.query}
              onChange={(event) => model.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  model.stepMatch(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  model.clearQuery();
                }
              }}
            />
          </div>
          {model.query.trim() !== "" && (
            <>
              <span className="tx-find-count" aria-live="polite">
                {model.matches.length === 0
                  ? "0 of 0"
                  : `${model.matchAt + 1} of ${model.matches.length}`}
              </span>
              <button
                type="button"
                className="tx-iconbtn"
                aria-label="Previous match"
                onClick={() => model.stepMatch(-1)}
              >
                <IconUp />
              </button>
              <button
                type="button"
                className="tx-iconbtn"
                aria-label="Next match"
                onClick={() => model.stepMatch(1)}
              >
                <IconDown />
              </button>
            </>
          )}
        </div>
        <div className="tx-tools">
          {!model.liveNow && model.hasTranscript && (
            <button
              type="button"
              data-tx-pop="speakers"
              onClick={(event) =>
                model.togglePop("speakers", event.currentTarget)
              }
            >
              Speakers
            </button>
          )}
          <button type="button" onClick={model.copyTranscript}>
            {model.copyLabel || "Copy"}
          </button>
          {!model.liveNow && transcribable && (
            <button
              type="button"
              ref={model.retranscribeButton}
              className={model.hasTranscript ? undefined : "primary"}
              aria-label={transcribeLabel}
              disabled={
                model.disabled || model.job !== null || !model.speechReady
              }
              onClick={
                model.hasTranscript
                  ? () => model.setRetranscribing(true)
                  : model.onTranscribe
              }
            >
              {model.job === "transcribe"
                ? "Transcribing…"
                : model.hasTranscript
                  ? "Re-transcribe"
                  : "Transcribe audio"}
            </button>
          )}
          {!model.liveNow && (
            <button
              type="button"
              onClick={(event) => model.onOpenHistory(event.currentTarget)}
            >
              History
            </button>
          )}
          {!model.liveNow && (
            <button
              type="button"
              className="tx-iconbtn"
              aria-label="More"
              data-tx-pop="more"
              onClick={(event) => model.togglePop("more", event.currentTarget)}
            >
              <IconDots />
            </button>
          )}
        </div>
      </div>
      {model.playbackError && (
        <p className="error" role="alert">
          {model.playbackError}
        </p>
      )}
      {warnings.length > 0 && <p className="tx-warn">{warnings.join(" ")}</p>}
      {/* While the live view shows, it says what is happening; the hint would repeat it. */}
      {hints && !liveShown && <p className="mw-hint">{hints}</p>}
      {model.retranscribing && (
        <div
          className="mw-card"
          role="group"
          aria-label="Confirm re-transcription"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            model.setRetranscribing(false);
            model.retranscribeButton.current?.focus();
          }}
        >
          <p>
            <strong>Re-transcribe this audio?</strong> The current transcript,
            edits included, is kept in History.{" "}
            {model.sttMode === "cloud"
              ? "Audio is uploaded again and may be billed again."
              : "This runs on your computer and can take about as long as the recording."}
          </p>
          <div className="mw-card-row">
            <button
              type="button"
              aria-label="Re-transcribe audio"
              disabled={
                model.disabled || model.job !== null || !model.speechReady
              }
              onClick={() => {
                model.setRetranscribing(false);
                model.onTranscribe();
              }}
            >
              Re-transcribe
            </button>
            <button
              type="button"
              ref={model.retranscribeCancel}
              onClick={() => {
                model.setRetranscribing(false);
                model.retranscribeButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {model.job === "transcribe" && (
        <div className="mw-card-row">
          {Object.keys(model.transcribeProgress).length > 0 &&
            Object.entries(model.transcribeProgress).map(([kind, percent]) => (
              <label className="mw-player" key={kind}>
                {kind === "preparing"
                  ? "Preparing audio…"
                  : `${trackLabels[kind] ?? kind}: ${percent}%`}
                <progress max={100} value={percent} />
              </label>
            ))}
          <button
            type="button"
            disabled={Object.keys(model.transcribeProgress).length === 0}
            onClick={model.onCancelTranscribe}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="tx-list">
        {liveShown && (
          <LiveTranscript
            meetingId={meeting.id}
            paused={meeting.status === "paused"}
            provisional={!model.liveNow}
            names={selected.speaker_names}
            onOpenSettings={model.onOpenSettings}
            query={model.liveFind ? model.query : undefined}
            matchIndex={model.matchAt}
            onMatchCount={model.liveFind ? model.setLiveCount : undefined}
            onPlainText={model.liveFind ? model.onPlainText : undefined}
          />
        )}
        {turns.map((turn) => {
          const canPlay = turn.startMs !== null && model.playable.length > 0;
          const playingTurn =
            model.playingIndex !== null &&
            turn.segments.some(
              (segment) => segment.index === model.playingIndex,
            );
          return (
            <div
              className={`tx-turn${playingTurn ? " is-playing" : ""}`}
              key={`${turn.speaker}-${turn.segments[0]?.index ?? 0}`}
            >
              {turn.startMs === null ? (
                <span className="tx-time">Untimed</span>
              ) : canPlay ? (
                <button
                  type="button"
                  className="tx-time"
                  aria-label={`Play from ${formatClock(turn.startMs)}`}
                  onClick={() => void model.seekTo(turn.startMs ?? 0, true)}
                >
                  {formatClock(turn.startMs)}
                </button>
              ) : (
                <span className="tx-time">{formatClock(turn.startMs)}</span>
              )}
              {model.liveNow ? (
                <span className="tx-name">
                  <span
                    className={`tx-dot ${turn.speaker === "You" ? "you" : "others"}`}
                    aria-hidden="true"
                  />
                  {speakerLabel(selected.speaker_names, turn.speaker)}
                </span>
              ) : (
                <button
                  type="button"
                  className="tx-name"
                  data-tx-pop="speakers"
                  aria-haspopup="dialog"
                  onClick={(event) =>
                    model.togglePop("speakers", event.currentTarget)
                  }
                >
                  <span
                    className={`tx-dot ${turn.speaker === "You" ? "you" : "others"}`}
                    aria-hidden="true"
                  />
                  {speakerLabel(selected.speaker_names, turn.speaker)}
                </button>
              )}
              <p className="tx-p">
                {turn.segments.map((item, at) => (
                  <SegmentView
                    key={item.index}
                    index={item.index}
                    spaced={at > 0}
                    editLocked={editLocked}
                  />
                ))}
              </p>
            </div>
          );
        })}
        {more && <div data-testid="transcript-more" ref={sentinel} />}
      </div>
      {model.pop && (
        <div
          className="tx-pop"
          role="dialog"
          aria-label={model.pop.kind === "speakers" ? "Speakers" : "More"}
          ref={model.popRef}
          style={{
            top: model.pop.top,
            left: model.pop.left,
            width: model.pop.kind === "more" ? 320 : 280,
          }}
        >
          {model.pop.kind === "speakers" ? (
            <SpeakerNamesForm
              key={`${meeting.id}:${selected.speaker_names.you ?? ""}:${selected.speaker_names.others ?? ""}`}
              meetingId={meeting.id}
              names={selected.speaker_names}
              disabled={model.disabled}
              onNames={(names) => model.onSpeakerNames(meeting.id, names)}
            />
          ) : (
            <>
              {selected.tracks.length > 0 && (
                <details className="mw-tracks">
                  <summary>Audio track details</summary>
                  {selected.tracks.map((track) => (
                    <p key={track.kind}>
                      {trackLabels[track.kind] ?? track.kind}: {track.path}
                      {track.size_bytes === null
                        ? " (file missing)"
                        : ` (${formatBytes(track.size_bytes)})`}
                    </p>
                  ))}
                </details>
              )}
              {engineLine(selected) && (
                <p className="mw-hint">{engineLine(selected)}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SegmentView(props: {
  index: number;
  spaced: boolean;
  editLocked: boolean;
}) {
  const model = useTranscript();
  const segment = model.selected.segments[props.index];
  const meta = model.selected.segment_meta[props.index];
  if (!segment) return null;
  const time = timeLabel(segment);
  const draft =
    meta &&
    model.segmentDraft?.meetingId === model.selected.meeting.id &&
    model.segmentDraft.segmentId === meta.id
      ? model.segmentDraft
      : null;
  const ranges = model.liveFind
    ? []
    : model.matches
        .map((match, index) =>
          match.segmentIndex === props.index
            ? {
                start: match.start,
                end: match.end,
                current: index === model.matchAt,
              }
            : null,
        )
        .filter(
          (match): match is { start: number; end: number; current: boolean } =>
            match !== null,
        );
  const text = draft?.text ?? segment.text;
  const id = meta ? `segment-${meta.id}` : undefined;
  const highlighted = meta ? model.highlighted.includes(meta.id) : false;
  const playing = model.playingIndex === props.index;
  const active = meta !== undefined && model.hoverId === meta.id && !draft;
  const startEdit = () => {
    // Another segment's draft, such as one whose save failed, stays until it is saved or cancelled.
    const pending =
      model.segmentDraft !== null &&
      model.segmentDraft.meetingId === model.selected.meeting.id;
    if (props.editLocked || !meta || draft || pending) return;
    model.onSegmentDraft({
      meetingId: model.selected.meeting.id,
      segmentId: meta.id,
      baseText: segment.text,
      text: segment.text,
    });
  };
  const timed = segment.timing.kind === "timed";
  const canPlay = timed && model.playable.length > 0 && !model.liveNow;
  return (
    <>
      {props.spaced ? " " : null}
      <span
        className={[
          "tx-seg",
          "transcript-segment",
          highlighted ? "highlighted-segment" : "",
          playing ? "is-playing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        id={id}
        tabIndex={props.editLocked ? undefined : 0}
        onClick={startEdit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            startEdit();
          }
        }}
        onPointerEnter={() => meta && model.setHoverId(meta.id)}
        onPointerLeave={() => model.setHoverId(null)}
        onFocus={() => meta && model.setHoverId(meta.id)}
      >
        {draft ? (
          <SegmentEditor draft={draft} time={time} locked={props.editLocked} />
        ) : (
          <>
            {marked(text, ranges)}
            {meta?.original_text !== null &&
              meta?.original_text !== undefined && (
                <span
                  className="tx-edited"
                  title={`Original: ${meta.original_text}`}
                />
              )}
          </>
        )}
        {active && meta && !model.liveNow && (
          <span className="tx-mini" role="toolbar" aria-label="Segment">
            {canPlay && timed && (
              <button
                type="button"
                className="tx-mini-play"
                aria-label={`Play from ${time}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void model.seekTo(
                    segment.timing.kind === "timed"
                      ? segment.timing.start_ms
                      : 0,
                    true,
                  );
                }}
              >
                <IconPlay />
                <span className="tx-mini-time">{time}</span>
              </button>
            )}
            <button
              type="button"
              aria-label={`Edit segment at ${time}`}
              disabled={props.editLocked || model.segmentDraft !== null}
              onClick={(event) => {
                event.stopPropagation();
                startEdit();
              }}
            >
              Edit
            </button>
            {meta.original_text !== null && (
              <button
                type="button"
                aria-label={`Revert segment at ${time}`}
                disabled={props.editLocked || model.segmentDraft !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void model.onSaveSegment({
                    meetingId: model.selected.meeting.id,
                    segmentId: meta.id,
                    baseText: segment.text,
                    text: meta.original_text ?? segment.text,
                  });
                }}
              >
                Revert
              </button>
            )}
          </span>
        )}
      </span>
    </>
  );
}

function SegmentEditor(props: { draft: Draft; time: string; locked: boolean }) {
  const model = useTranscript();
  const area = useRef<HTMLTextAreaElement>(null);
  const skipBlur = useRef(false);
  const grow = () => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    grow();
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, []);
  const save = () => {
    if (props.locked || skipBlur.current || !props.draft.text.trim()) return;
    skipBlur.current = true;
    void model.onSaveSegment(props.draft).finally(() => {
      skipBlur.current = false;
    });
  };
  return (
    <>
      <textarea
        ref={area}
        className="tx-edit"
        aria-label={`Edit segment at ${props.time}`}
        maxLength={20000}
        value={props.draft.text}
        disabled={props.locked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          model.onSegmentDraft({ ...props.draft, text: event.target.value });
          grow();
        }}
        onBlur={() => {
          if (props.locked || skipBlur.current) return;
          if (props.draft.text.trim()) save();
          else model.onSegmentDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            model.onSegmentDraft(null);
          }
        }}
      />
      <span className="tx-edit-hint">Enter saves. Esc cancels.</span>
    </>
  );
}

export function TranscriptDock() {
  const model = useTranscript();
  const scrub = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  if (
    model.tab !== "transcript" ||
    model.liveNow ||
    model.playable.length === 0
  )
    return null;
  const total = meetingDuration(model.selected, model.playable);
  const shown = model.sessionMs;
  const ratio = total > 0 ? Math.min(1, Math.max(0, shown / total)) : 0;
  const seconds = Math.floor(shown / 1000);
  const totalSeconds = Math.max(0, Math.floor(total / 1000));
  const at = (clientX: number) => {
    const node = scrub.current;
    if (!node || total <= 0) return 0;
    const rect = node.getBoundingClientRect();
    const next = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
    return Math.min(total, Math.max(0, next * total));
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    void model.seekTo(at(event.clientX), model.playing);
  };
  const kinds = ["mic", "system"] as const;
  return (
    <div className="tx-dock">
      {model.away && model.playing && (
        <button type="button" className="tx-jump" onClick={model.backToPlaying}>
          Back to playing
        </button>
      )}
      <div
        className={`tx-player${model.options ? " is-options" : ""}`}
        role="group"
        aria-label="Player"
      >
        <button
          type="button"
          className="tx-play"
          aria-label={model.playing ? "Pause" : "Play"}
          onClick={model.togglePlay}
        >
          {model.playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="tx-clock">
          {formatClock(shown)} / {formatClock(total)}
        </span>
        <div
          className="tx-scrub"
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={totalSeconds}
          aria-valuenow={Math.min(seconds, totalSeconds)}
          aria-valuetext={`${formatClock(shown)} of ${formatClock(total)}`}
          ref={scrub}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            void model.seekTo(at(event.clientX), model.playing);
          }}
          onPointerMove={move}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            const step =
              (event.shiftKey ? 30_000 : 5_000) *
              (event.key === "ArrowLeft" ? -1 : 1);
            void model.seekTo(
              Math.max(0, Math.min(total, model.sessionMs + step)),
              model.playing,
            );
          }}
        >
          <div className="tx-scrub-track">
            <div
              className="tx-scrub-fill"
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <div className="tx-scrub-thumb" style={{ left: `${ratio * 100}%` }} />
        </div>
        <div className="tx-player-extra">
          <div className="tx-speed" role="group" aria-label="Playback speed">
            {[1, 1.5, 2].map((rate) => (
              <button
                type="button"
                key={rate}
                aria-pressed={model.rate === rate}
                onClick={() => model.setRate(rate)}
              >
                {rate}×
              </button>
            ))}
          </div>
          <div className="tx-mutes">
            {kinds.map((kind) => {
              const label = kind === "mic" ? "You" : "Others";
              const available = model.playable.some(
                (track) => track.kind === kind,
              );
              const pressed = !!model.muted[kind];
              return (
                <button
                  type="button"
                  key={kind}
                  className="tx-mute"
                  disabled={!available}
                  aria-pressed={available ? pressed : undefined}
                  aria-label={
                    available
                      ? `${pressed ? "Unmute" : "Mute"} ${label}`
                      : `${label}, no audio`
                  }
                  onClick={() => available && model.toggleMute(kind)}
                >
                  {available ? (
                    <>
                      <IconSpeaker off={pressed} />
                      {label}
                    </>
                  ) : (
                    <>{label} No audio</>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className="tx-options"
          aria-label="Playback options"
          aria-expanded={model.options}
          onClick={() => model.setOptions((value) => !value)}
        >
          <IconDots />
        </button>
      </div>
    </div>
  );
}
