import {
  convertFileSrc,
  invoke,
  isBackendConnected,
  listen,
} from "./transport";

export function isLocalBase(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return (
      host === "localhost" ||
      host === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

export type RecordingState = {
  revision: number;
  status: "idle" | "recording" | "paused" | "stopped";
  meeting_id: string | null;
  source: string | null;
  error: string | null;
  /** Audio written so far (paused time excluded); null without real capture. */
  recording_offset_ms: number | null;
  /** Why automatic processing was skipped for this recording, if it was. */
  processing_notice?: string | null;
};
export type SessionDestination =
  | { kind: "local_whisper"; model: string }
  | {
      kind: "compatible_api";
      base_url: string;
      model: string;
      connection_id: string;
      connection_revision: number;
      assignment_revision: number;
    };
export type SessionProcessingPlan = {
  id: string;
  meeting_id: string | null;
  configuration_revision: number;
  scope:
    | { kind: "live_only"; speech: SessionDestination }
    | {
        kind: "final";
        live: boolean;
        speech: SessionDestination;
        summary: {
          destination: SessionDestination;
          template: SummaryTemplate;
          /** Saved personal instructions frozen at recording start; omitted when empty. */
          instructions?: string;
        } | null;
      };
  language: string;
  tracks: [string, string];
  limits: {
    duration_seconds: number;
    post_stop_seconds: number;
    upload_bytes: number;
    requests: number;
    text_bytes: number;
  };
};
export type SessionProcessingSnapshot = {
  meeting_id: string;
  revision: number;
  state: "prepared" | "needs_attention" | "cancelled" | "interrupted";
  plan: SessionProcessingPlan;
  started_at: number;
  authorized_until: number;
  workflow: SessionWorkflow | null;
};
export type SessionWorkflow = {
  run_id: string;
  attempt: number;
  stage:
    | "live"
    | "finalizing_audio"
    | "transcribing"
    | "awaiting_notes"
    | "summarizing"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "needs_attention";
  error: string | null;
  live_incomplete: boolean;
  transcript_done: boolean;
  notes_revision: number | null;
  notes_barrier: string | null;
  requests_used: number;
  upload_bytes_used: number;
  text_bytes_used: number;
  provisional: { id: string; chunk_id: number; segment: Segment }[];
};
export type Meeting = {
  id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  status: "recording" | "paused" | "stopped" | "interrupted";
  source: "simulation" | "fixture" | "desktop" | "note";
  capture_error: string | null;
  tags: string[];
};
export type Segment = {
  speaker: "You" | "Others";
  timing:
    { kind: "timed"; start_ms: number; end_ms: number } | { kind: "untimed" };
  text: string;
};
export type QuestionTurn = {
  id: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
};
export type QuestionThread = { id: number; turns: QuestionTurn[] };
export type MeetingDetail = {
  meeting: Meeting;
  user_markdown: string;
  notes_revision: number;
  segments: Segment[];
  summary: string | null;
  summary_provider: string | null;
  summary_model: string | null;
  transcript_provider: string | null;
  transcript_model: string | null;
  action_items: ActionItem[];
  /** The latest summary is a user edit, not unedited model output. */
  summary_edited: boolean;
  /** The transcript or speaker names changed after the latest summary was made. */
  summary_stale: boolean;
  speaker_names: SpeakerNames;
  /** Aligned by index with `segments`. */
  segment_meta: SegmentMeta[];
  /** Earlier transcripts, newest first. */
  transcript_versions: TranscriptVersion[];
  /** Saved questions and answers, newest thread first, turns oldest first. */
  question_threads: QuestionThread[];
  tracks: Array<{
    kind: string;
    path: string;
    device_name: string;
    sample_rate: number;
    frames: number;
    dropped_frames: number;
    finalized: boolean;
    /** WAV size on disk; null if the file is missing. */
    size_bytes: number | null;
  }>;
  summary_template: string | null;
};
export type AudioDevice = { id: string; name: string };
export type AudioDevices = {
  capture_supported: boolean;
  microphones: AudioDevice[];
  outputs: AudioDevice[];
};
export type AudioHealth = {
  error: string | null;
  tracks: Array<{
    kind: string;
    frames: number;
    dropped_frames: number;
    gaps: number;
    peak: number;
    callback_age_ms: number;
  }>;
};
export type Settings = {
  vault_folder: string | null;
  pause_shortcut: string;
  microphone_id: string | null;
  output_id: string | null;
  saved_connections: SavedConnection[];
  provider_assignments: Record<ProviderRole, ProviderAssignment | null>;
  llm: ProviderConfig | null;
  cloud_stt: ProviderConfig | null;
  stt_mode: "local" | "cloud";
  stt_language: string;
  stt_prompt: string;
  stt_model: string;
  stop_shortcut: string | null;
  export: ExportOptions;
  summary_instructions: string;
  summary_templates: CustomTemplate[];
  recipes: Recipe[];
  /** "recording" or "final"; applied to every new recording. Old "live"/"both" rows read as "recording"/"final". */
  processing_mode: string;
  processing_summary: string | null;
  /** The template the Enhance picker starts at. */
  summary_default: string;
  /** Opt-in: prompt when another app starts using the microphone. Never starts recording. */
  detection_enabled: boolean;
  /** Apps never to prompt about; `name` is empty for ones ignored before names were kept. */
  detection_ignored: MicApp[];
  /** First-run setup was finished or skipped. */
  setup_done: boolean;
  /** Colour theme; "system" follows Windows. */
  theme: Theme;
  /** Whether the meeting page's right inspector is open. */
  inspector_open: boolean;
  /** Live transcript while recording (migration 032; on by default). It runs only when its model is ready. */
  live_transcript: boolean;
  /**
   * The live engine: "" uses the Transcription model (or the cloud connection when Transcription is
   * cloud), "stream:<id>" a pinned streaming ONNX model, "stream-dir:<folder>" a streaming model folder
   * found under stt/streaming, "cloud" the saved cloud transcription connection (leaves this device).
   */
  live_model: string;
};
/** One live transcript line. Final lines are kept; a partial line is replaced by the next update with the same id. */
export type LiveLine = {
  /** Stable per utterance: a partial and the final that replaces it share this id. */
  id: string;
  lane: "mic" | "system";
  /** "You" for the microphone, "Others" for system audio. */
  speaker: string;
  /** Session time (paused time excluded), like transcript segments. */
  start_ms: number;
  end_ms: number;
  text: string;
  final: boolean;
};
export type LiveState = "off" | "starting" | "running" | "stopped" | "failed";
export type LiveTranscript = {
  meeting_id: string;
  /** Final lines in time order. */
  lines: LiveLine[];
  /** The newest partial line per lane, if any. */
  partials: LiveLine[];
  state: LiveState;
  /** Engine label such as "Streaming English (NeMo)"; null when off. */
  engine: string | null;
  /** True when the live audio leaves this device (cloud). */
  leaves_device: boolean;
  /** One sentence: why live is off, failed or incomplete. */
  notice: string | null;
};
export type LiveTranscriptEvent = { meeting_id: string; line: LiveLine };
export type LiveStateEvent = {
  meeting_id: string;
  state: LiveState;
  engine: string | null;
  leaves_device: boolean;
  notice: string | null;
};
export type LiveModel = {
  /** Value for Settings.live_model. */
  id: string;
  label: string;
  kind: "same" | "streaming" | "custom" | "cloud";
  /** Ready to run now (downloaded, engine present, connection saved). */
  installed: boolean;
  /** Download size for a pinned streaming model that is not installed; null otherwise. */
  download_bytes: number | null;
  leaves_device: boolean;
  /** Languages the model can transcribe, as codes; empty when unknown. */
  languages: string[];
  /** Why it cannot run, in one sentence; null when it can. */
  reason: string | null;
};
export type LiveModels = {
  models: LiveModel[];
  /** The saved Settings.live_model. */
  selected: string;
  /** True when the selected model can run now. */
  ready: boolean;
  reason: string | null;
  /** A streaming model download in progress, if any. */
  installing: string | null;
};
export type LiveModelProgress = {
  model_id: string;
  done: number;
  total: number;
  /** "downloading" | "verifying" | "done" | "failed" | "cancelled" */
  stage: string;
  error: string | null;
};
export type Theme = "system" | "dark" | "light";
/** What the one-time import from the previous OpenMeet data folder would bring over. */
export type ImportStatus = {
  /** True only when the old folder exists and this data folder has no meetings or audio yet. */
  available: boolean;
  path: string | null;
  meetings: number;
  audio_files: number;
  bytes: number;
  /** Why import is not offered (no old folder, or this folder is already in use); null when available. */
  blocked_reason: string | null;
};
export type ImportResult = {
  meetings: number;
  transcript_lines: number;
  audio_files: number;
  /** Short notes from the import report (skipped items, kept backup). */
  notes: string[];
};
/** Local AI: OpenMeet's own llama.cpp server running a downloaded model on this PC. */
export type LocalAiBackend = "cuda" | "vulkan" | "cpu";
export type LocalAiHardware = {
  gpu_name: string | null;
  gpu_vendor: "nvidia" | "amd" | "intel" | null;
  /** Total dedicated GPU memory; null when no GPU could be read. */
  vram_bytes: number | null;
  ram_bytes: number;
  ram_available_bytes: number;
  /** The engine build this PC uses: CUDA for NVIDIA, Vulkan for AMD/Intel, else CPU. */
  backend: LocalAiBackend;
};
/** `gpu`: runs entirely in GPU memory; `ram`: part runs from system RAM (slower);
 * `too_big`: will not run here. */
export type LocalAiFit = "gpu" | "ram" | "too_big";
export type LocalAiModel = {
  /** Catalog id, or `file:<absolute path>` for a .gguf file found on this PC. */
  id: string;
  name: string;
  description: string;
  size_bytes: number;
  license: string | null;
  fit: LocalAiFit;
  recommended: boolean;
  downloaded: boolean;
  source: "catalog" | "file";
};
export type LocalAiJob = {
  kind: "engine" | "model" | "quickstart";
  /** The model id for a model download; the backend name for the engine. */
  target: string;
  phase: "download" | "verify" | "extract" | "start";
  downloaded: number;
  total: number;
};
export type LocalAiServer = "stopped" | "starting" | "running" | "failed";
export type LocalAiStatus = {
  hardware: LocalAiHardware;
  engine_installed: boolean;
  /** Pinned llama.cpp build, e.g. "b11671". */
  engine_tag: string;
  /** Bytes still to download for the engine on this PC's backend (0 once installed). */
  engine_download_bytes: number;
  server: LocalAiServer;
  /** One sentence with the fix, set when `server` is "failed". */
  server_error: string | null;
  /** The model the local server runs; null until one is chosen. */
  active_model: string | null;
  /** True while AI notes are assigned to the local server. */
  in_use: boolean;
  models: LocalAiModel[];
  /** The download or setup running now, if any. */
  job: LocalAiJob | null;
};
/** An app using the microphone: a Windows privacy-store key or a macOS bundle identifier. */
export type MicApp = { id: string; name: string };
/** A saved question prompt; `id` is `recipe-<uuid>`. */
export type Recipe = { id: string; name: string; prompt: string };
/** A saved answer over several meetings; `meeting_ids` are in the order sent (M1 first). */
export type LibraryAnswer = {
  id: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
  meeting_ids: string[];
};
/** `original_text` holds the engine's text once the user edited a segment. */
export type SegmentMeta = { id: number; original_text: string | null };
export type TranscriptVersion = {
  id: number;
  provider: string | null;
  model: string | null;
  edited: boolean;
  segment_count: number;
};
/** Display names for the "You" (microphone) and "Others" (system audio) labels. */
export type SpeakerNames = { you: string | null; others: string | null };
/** "Rahul (You)" when named, otherwise the stored label. */
export const speakerLabel = (names: SpeakerNames, speaker: string) => {
  const name =
    speaker === "You" ? names.you : speaker === "Others" ? names.others : null;
  return name ? `${name} (${speaker})` : speaker;
};
/** Editable meeting task; `owner` and `due_date` are null when not established. */
export type ActionItem = {
  id: number;
  text: string;
  owner: string | null;
  due_date: string | null;
  done: boolean;
  source: "manual" | "summary";
  summary_id: number | null;
};
/** User-defined summary structure; `id` is `custom-<uuid>`. */
export type CustomTemplate = {
  id: string;
  name: string;
  instructions: string;
};
export type TranscriptFormat = "txt" | "srt" | "vtt";
export type ExportOptions = {
  transcript: boolean;
  summary: boolean;
  filename: "title" | "date_title";
  /** Extra transcript files written beside the Markdown snapshot. */
  transcript_formats: TranscriptFormat[];
};
export type ProviderRole = "llm" | "cloud_stt";
export type ProviderConfig = {
  base_url: string;
  model: string | null;
  revision: number;
};
export type SavedConnection = {
  id: string;
  name: string;
  base_url: string;
  revision: number;
};
export type ProviderAssignment = {
  connection_id: string;
  model: string;
  revision: number;
};
/** A known AI or speech server answering on this machine. */
export type LocalServer = {
  name: string;
  base_url: string;
  kind: "chat" | "speech" | "both";
  /** It answered but wants an API key (Unsloth Studio does). */
  needs_key: boolean;
  models: ProviderModel[];
};
export type ProviderSelection =
  | { kind: "unassigned" }
  | { kind: "assigned"; connection_id: string; model: string };
export type LocalModel = {
  path: string;
  format: "whisper" | "gguf" | "unknown";
  size: number;
  model_id: string | null;
};
export type ModelScan = {
  models: LocalModel[];
  folders: { path: string; status: string }[];
  truncated: boolean;
};
/** What a repository's file names say it holds; `other` is not downloadable. */
export type HubKind = "whisper_ggml" | "sherpa_onnx" | "other";
export type HubModel = { id: string; license: string | null; kind: HubKind };
export type HubFile = {
  repo_id: string;
  revision: string;
  filename: string;
  size: number;
  sha256: string;
  license: string | null;
  model_id: string | null;
};
export type SherpaLayout = "transducer" | "moonshine" | "single_model";
/** One complete sherpa-onnx folder; every file carries its LFS size and SHA-256. */
export type HubFolder = {
  repo_id: string;
  revision: string;
  folder: string;
  layout: SherpaLayout;
  license: string | null;
  files: HubFile[];
};
export type HubListing = { files: HubFile[]; folders: HubFolder[] };
export type ModelLibraryProgress = { downloaded: number; total: number };
export type ProviderModel = { id: string };
export type KeyStatus = "present" | "missing" | "unavailable";
export type KeyChange =
  { kind: "keep" } | { kind: "replace"; key: string } | { kind: "remove" };
export type SttStatus = {
  engine: boolean;
  model: boolean;
  vad: boolean;
  installed: boolean;
  missing_bytes: number;
  supported: boolean;
  /** `reason` is set when a model cannot run on this PC (for example its engine is missing). */
  models: Array<{
    id: string;
    size: number;
    installed: boolean;
    reason?: string | null;
  }>;
  languages: string[];
};
export type SttDownloadProgress = {
  stage: "engine" | "model" | "vad";
  downloaded: number;
  total: number;
};
export type SttTranscribeProgress = {
  stage: "transcribing";
  track: string;
  percent: number;
};
export type SttProgress = SttDownloadProgress | SttTranscribeProgress;
export type ExportResult = {
  path: string;
  created_copy: boolean;
  transcript_paths: string[];
};
export type SearchHit = {
  meeting_id: string;
  kind: "title" | "notes" | "transcript" | "summary";
  snippet: string;
};
/** Versioned template ids. */
export type SummaryTemplate = "general-v1" | "standup-v1" | "one-to-one-v1";
export type SummaryVersion = {
  id: number;
  provider: string;
  model: string;
  /** Stored template id; older rows may hold "summary-v1" or "fixture". */
  template: string;
  markdown: string;
  /** Version the user edited this one from; null for generated output. */
  edited_from: number | null;
  /** The transcript or speaker names changed after this version was made. */
  stale: boolean;
};

export const api = {
  isDesktop: isBackendConnected,
  listMeetings: () => invoke<Meeting[]>("list_meetings"),
  getMeeting: (id: string) => invoke<MeetingDetail>("get_meeting", { id }),
  getRecordingState: () => invoke<RecordingState>("get_recording_state"),
  /** Starts capture; automatic processing follows the saved default. */
  startCapture: (
    title: string,
    devices: { microphoneId: string; outputId: string },
  ) => invoke<RecordingState>("start_recording", { title, devices }),
  getSessionProcessing: (id: string) =>
    invoke<SessionProcessingSnapshot | null>("get_session_processing", { id }),
  acknowledgeProcessingNotes: (
    id: string,
    runId: string,
    notesBarrier: string,
    expectedNotesRevision: number,
  ) =>
    invoke<SessionProcessingSnapshot>("acknowledge_processing_notes", {
      id,
      runId,
      notesBarrier,
      expectedNotesRevision,
    }),
  /** Retries failed or interrupted automatic processing with the current settings. */
  retrySessionProcessing: (id: string) =>
    invoke<SessionProcessingSnapshot>("retry_session_processing", { id }),
  cancelSessionProcessing: (id: string, expectedRevision: number) =>
    invoke<SessionProcessingSnapshot>("cancel_session_processing", {
      id,
      expectedRevision,
    }),
  onSessionProcessingChanged: (
    callback: (snapshot: SessionProcessingSnapshot) => void,
  ) =>
    listen<SessionProcessingSnapshot>("session_processing_changed", (event) =>
      callback(event.payload),
    ),
  listDevices: () => invoke<AudioDevices>("list_audio_devices"),
  pause: () => invoke<RecordingState>("pause_recording"),
  resume: () => invoke<RecordingState>("resume_recording"),
  stop: () => invoke<RecordingState>("stop_recording"),
  saveNotes: (id: string, markdown: string, expectedRevision: number) =>
    invoke<number>("save_notes", { id, markdown, expectedRevision }),
  getStartupWarning: () => invoke<string | null>("get_startup_warning"),
  getSettings: () => invoke<Settings>("get_settings"),
  providerKeyStatus: (role: ProviderRole) =>
    invoke<KeyStatus>("provider_key_status", { role }),
  saveApiConnection: (args: {
    id: string | null;
    name: string;
    baseUrl: string;
    keyChange: KeyChange;
    expectedRevision: number | null;
  }) => invoke<Settings>("save_api_connection", args),
  deleteApiConnection: (id: string, expectedRevision: number) =>
    invoke<Settings>("delete_api_connection", { id, expectedRevision }),
  apiConnectionKeyStatus: (id: string) =>
    invoke<KeyStatus>("api_connection_key_status", { id }),
  listApiConnectionModels: (id: string, expectedRevision: number) =>
    invoke<ProviderModel[]>("list_api_connection_models", {
      id,
      expectedRevision,
    }),
  /** Lists the models at a URL to prove it answers and the key works; no billable request.
   * A typed key is used once and never stored; without one, the saved connection's key is used,
   * and only for the URL it was saved with. */
  testApiConnection: (baseUrl: string, key: string | null, id: string | null) =>
    invoke<ProviderModel[]>("test_api_connection", { baseUrl, key, id }),
  saveProviderAssignment: (
    role: ProviderRole,
    selection: ProviderSelection,
    expectedRevision: number | null,
  ) =>
    invoke<Settings>("save_provider_assignment", {
      role,
      selection,
      expectedRevision,
    }),
  chooseModelFolder: () => invoke<string | null>("choose_model_folder"),
  scanLocalModels: (folder: string | null) =>
    invoke<ModelScan>("scan_local_models", { folder }),
  importLocalModel: (path: string) =>
    invoke<{ model_id: string }>("import_local_model", { path }),
  searchHfModels: (query: string) =>
    invoke<HubModel[]>("search_hf_models", { query }),
  listHfFiles: (repoId: string) =>
    invoke<HubListing>("list_hf_files", { repoId }),
  downloadHfModel: (file: HubFile) =>
    invoke<{ path: string; model_id: string | null }>("download_hf_model", {
      file,
    }),
  downloadHfFolder: (folder: HubFolder) =>
    invoke<{ path: string; files: number; model_id: string }>(
      "download_hf_folder",
      { folder },
    ),
  cancelModelDownload: () => invoke<void>("cancel_model_download"),
  /** Apps holding the microphone, reported when the stable list changes while detection is on. */
  onMicrophoneApps: (callback: (apps: MicApp[]) => void) =>
    listen<MicApp[]>("microphone_apps", (event) => callback(event.payload)),
  saveDetection: (enabled: boolean) =>
    invoke<Settings>("save_detection", { enabled }),
  setDetectionIgnored: (appId: string, name: string, ignored: boolean) =>
    invoke<Settings>("set_detection_ignored", { appId, name, ignored }),
  detectionSupported: () => invoke<boolean>("detection_supported"),
  /** Flashes the taskbar entry; never shows or focuses the window. */
  requestAttention: () => invoke<void>("request_attention"),
  onModelLibraryProgress: (
    callback: (progress: ModelLibraryProgress) => void,
  ) =>
    listen<ModelLibraryProgress>("model_library_progress", (event) =>
      callback(event.payload),
    ),
  /** Local AI (Settings > AI notes). Downloads only on these explicit calls; every file is
   * checked against a pinned SHA-256. Long calls report through `onLocalAiProgress`. */
  localAiStatus: () => invoke<LocalAiStatus>("local_ai_status"),
  localAiInstallEngine: () => invoke<LocalAiStatus>("local_ai_install_engine"),
  localAiDownloadModel: (modelId: string) =>
    invoke<LocalAiStatus>("local_ai_download_model", { modelId }),
  localAiRemoveModel: (modelId: string) =>
    invoke<LocalAiStatus>("local_ai_remove_model", { modelId }),
  localAiCancel: () => invoke<void>("local_ai_cancel"),
  /** Makes the model the local server's model and assigns AI notes to the local server. */
  localAiUse: (modelId: string) =>
    invoke<Settings>("local_ai_use", { modelId }),
  /** Engine + recommended model + use, in one call ("Set up for me"). */
  localAiQuickstart: () => invoke<Settings>("local_ai_quickstart"),
  localAiStart: () => invoke<LocalAiStatus>("local_ai_start"),
  localAiStop: () => invoke<LocalAiStatus>("local_ai_stop"),
  onLocalAiProgress: (callback: (job: LocalAiJob) => void) =>
    listen<LocalAiJob>("local_ai_progress", (event) => callback(event.payload)),
  /** Saved finals plus the current partials and state for one meeting. */
  liveTranscript: (meetingId: string) =>
    invoke<LiveTranscript>("live_transcript", { meetingId }),
  saveLiveSettings: (enabled: boolean, model: string) =>
    invoke<Settings>("save_live_settings", { enabled, model }),
  liveModels: () => invoke<LiveModels>("live_models"),
  /** Downloads a pinned streaming model; only ever called from a click. */
  liveModelInstall: (modelId: string) =>
    invoke<LiveModels>("live_model_install", { modelId }),
  liveModelCancel: () => invoke<LiveModels>("live_model_cancel"),
  onLiveTranscript: (callback: (event: LiveTranscriptEvent) => void) =>
    listen<LiveTranscriptEvent>("live_transcript", (event) =>
      callback(event.payload),
    ),
  onLiveState: (callback: (event: LiveStateEvent) => void) =>
    listen<LiveStateEvent>("live_state", (event) => callback(event.payload)),
  onLiveModelProgress: (callback: (event: LiveModelProgress) => void) =>
    listen<LiveModelProgress>("live_model_progress", (event) =>
      callback(event.payload),
    ),
  saveSttMode: (mode: Settings["stt_mode"]) =>
    invoke<Settings>("save_stt_mode", { mode }),
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttInstall: () => invoke<SttStatus>("stt_install"),
  transcribeMeeting: (id: string) => invoke<void>("transcribe_meeting", { id }),
  /** `template` is a built-in `SummaryTemplate` or a `CustomTemplate` id. */
  generateSummary: (id: string, template: string) =>
    invoke<void>("generate_summary", { id, template }),
  saveSummaryInstructions: (instructions: string) =>
    invoke<Settings>("save_summary_instructions", { instructions }),
  saveSummaryTemplate: (
    id: string | null,
    name: string,
    instructions: string,
  ) => invoke<Settings>("save_summary_template", { id, name, instructions }),
  deleteSummaryTemplate: (id: string) =>
    invoke<Settings>("delete_summary_template", { id }),
  /** Creates a task when `itemId` is null; otherwise edits it. Returns the meeting's tasks. */
  saveActionItem: (
    meetingId: string,
    itemId: number | null,
    text: string,
    owner: string | null,
    dueDate: string | null,
    done: boolean,
  ) =>
    invoke<ActionItem[]>("save_action_item", {
      meetingId,
      itemId,
      text,
      owner,
      dueDate,
      done,
    }),
  deleteActionItem: (meetingId: string, itemId: number) =>
    invoke<ActionItem[]>("delete_action_item", { meetingId, itemId }),
  importActionItems: (meetingId: string, summaryId: number) =>
    invoke<ActionItem[]>("import_action_items", { meetingId, summaryId }),
  saveSettings: (pauseShortcut: string, stopShortcut: string | null) =>
    invoke<Settings>("save_settings", { pauseShortcut, stopShortcut }),
  chooseVaultFolder: () => invoke<Settings>("choose_vault_folder"),
  exportMeeting: (id: string) => invoke<ExportResult>("export_meeting", { id }),
  close: () => invoke<void>("close_application"),
  cancelTranscription: () => invoke<boolean>("cancel_transcription"),
  saveSttSettings: (language: string, prompt: string, model: string) =>
    invoke<Settings>("save_stt_settings", { language, prompt, model }),
  /** Maps a transcript (session) time to a position in that track's file, in ms. */
  audioPosition: (id: string, kind: string, sessionMs: number) =>
    invoke<number>("audio_position", { id, kind, sessionMs }),
  /** Asset-protocol URL; the backend scope only serves the app-data audio folder. */
  audioSrc: (path: string) => convertFileSrc(path),
  onRecordingState: (callback: (state: RecordingState) => void) =>
    listen<RecordingState>("recording_state", (event) =>
      callback(event.payload),
    ),
  onSttProgress: (callback: (progress: SttProgress) => void) =>
    listen<SttProgress>("stt_progress", (event) => callback(event.payload)),
  onMeetingUpdated: (callback: () => void) =>
    listen("meeting_updated", callback),
  onCloseRequested: (callback: () => void) => listen("request_close", callback),
  onAudioHealth: (callback: (health: AudioHealth) => void) =>
    listen<AudioHealth>("audio_health", (event) => callback(event.payload)),
  onError: (callback: (message: string) => void) =>
    listen<string>("backend_error", (event) => callback(event.payload)),
  createNote: (title: string) => invoke<string>("create_note", { title }),
  audioUsage: () => invoke<number>("audio_usage"),
  deleteAudio: (id: string) => invoke<void>("delete_audio", { id }),
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  searchMeetings: (query: string) =>
    invoke<SearchHit[]>("search_meetings", { query }),
  listSummaries: (id: string) =>
    invoke<SummaryVersion[]>("list_summaries", { id }),
  /** Saves an edit of `baseId` as the newest version; refused if `expectedLatestId` is stale. */
  /** `baseText` is the text the edit started from; a changed segment is refused. */
  editSegment: (
    meetingId: string,
    segmentId: number,
    baseText: string,
    text: string,
  ) => invoke<void>("edit_segment", { meetingId, segmentId, baseText, text }),
  getTranscriptVersion: (meetingId: string, versionId: number) =>
    invoke<Segment[]>("get_transcript_version", { meetingId, versionId }),
  /** Empty names clear back to "You"/"Others". */
  saveSpeakerNames: (
    meetingId: string,
    you: string | null,
    others: string | null,
  ) => invoke<SpeakerNames>("save_speaker_names", { meetingId, you, others }),
  saveSummaryEdit: (
    meetingId: string,
    baseId: number,
    expectedLatestId: number,
    markdown: string,
  ) =>
    invoke<void>("save_summary_edit", {
      meetingId,
      baseId,
      expectedLatestId,
      markdown,
    }),
  /** Saves and returns the thread the answer joined. `threadId` continues a saved
   * thread, sending its earlier turns; null starts a new one. */
  askMeeting: (id: string, question: string, threadId: number | null) =>
    invoke<QuestionThread>("ask_meeting", { id, question, threadId }),
  /** One request over 1 to 20 meetings, in this order; the answer is saved and returned. */
  askLibrary: (meetingIds: string[], question: string) =>
    invoke<LibraryAnswer>("ask_library", { meetingIds, question }),
  /** Saved library answers, newest first. */
  listLibraryAnswers: () => invoke<LibraryAnswer[]>("list_library_answers"),
  /** Returns the remaining answers. */
  deleteLibraryAnswer: (id: number) =>
    invoke<LibraryAnswer[]>("delete_library_answer", { id }),
  /** Sends only the selected text and request; the result is returned, never stored. */
  rewriteText: (text: string, request: string) =>
    invoke<string>("rewrite_text", { text, request }),
  /** Creates a recipe when `id` is null; otherwise edits it. */
  saveRecipe: (id: string | null, name: string, prompt: string) =>
    invoke<Settings>("save_recipe", { id, name, prompt }),
  deleteRecipe: (id: string) => invoke<Settings>("delete_recipe", { id }),
  /** Returns the remaining threads. */
  deleteQuestionThread: (meetingId: string, threadId: number) =>
    invoke<QuestionThread[]>("delete_question_thread", { meetingId, threadId }),
  renameMeeting: (id: string, title: string) =>
    invoke<string>("rename_meeting", { id, title }),
  setMeetingTags: (meetingId: string, tags: string[]) =>
    invoke<string[]>("set_meeting_tags", { meetingId, tags }),
  saveExportOptions: (options: ExportOptions) =>
    invoke<Settings>("save_export_options", { options }),
  /** Probes known local server ports on 127.0.0.1 only; sends just GET /models. */
  detectLocalServers: () => invoke<LocalServer[]>("detect_local_servers"),
  saveSetupDone: (done: boolean) =>
    invoke<Settings>("save_setup_done", { done }),
  saveUiPrefs: (theme: Theme, inspectorOpen: boolean) =>
    invoke<Settings>("save_ui_prefs", { theme, inspectorOpen }),
  /** This build's own data folder, shown read-only in Export & storage. */
  dataFolder: () => invoke<{ path: string }>("data_folder"),
  /** Read-only look at the previous OpenMeet data folder; never writes there. */
  importStatus: () => invoke<ImportStatus>("import_status"),
  /** Imports the previous OpenMeet data into this (still empty) data folder. */
  importPrevious: () => invoke<ImportResult>("import_previous"),
  saveProcessingDefault: (mode: string, summary: string | null) =>
    invoke<Settings>("save_processing_default", { mode, summary }),
  saveSummaryDefault: (template: string) =>
    invoke<Settings>("save_summary_default", { template }),
  saveDefaultDevices: (microphoneId: string, outputId: string) =>
    invoke<Settings>("save_default_devices", { microphoneId, outputId }),
  recoverAudio: (id: string) => invoke<void>("recover_audio", { id }),
};

/** The backend error code, e.g. "stt_cancelled", if the error carries one. */
export const errorCode = (error: unknown) =>
  (error as { code?: string } | null)?.code;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}
