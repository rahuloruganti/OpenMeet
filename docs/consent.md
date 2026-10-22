# Recording consent

OpenMeet records your microphone and, on Windows, the audio of every other app (the system track). Apple Silicon macOS 14.2 or newer records the selected output-only device as a preview. Historical fictional entries remain labeled; simulation creation is removed.

**You are responsible for complying with the recording-consent laws and policies that apply to you and the people you record.** Many places require telling participants, or getting everyone's permission, before recording a conversation. OpenMeet does not ask for an acknowledgement before recording; the recording indicator in the app and tray shows when capture is on. The system track can include unrelated app audio, and headphones do not change recording obligations.

Automatic processing follows the default in **Settings → AI notes**. Recording only is the default. When live or final transcription or an automatic summary is chosen, every new recording runs it without a separate review: audio goes to the speech engine set in Transcription and, for summaries, saved notes and the final transcript go to the AI notes connection. A local engine keeps audio on this device; an API connection sends it to that provider, whose retention and billing apply. If the chosen engine or connection is not ready, the recording is kept and processing is skipped with a notice.

Manual summaries, questions, rewrites and cloud transcription send as soon as you use them. Hard limits on requests, uploaded bytes and text size still apply, failed requests are never retried automatically, and a result is not saved when the notes, transcript or provider changed while it was pending. Cancellation cannot recall content already sent.

Pausing excludes new audio. Work using audio accepted before the pause may finish while paused. Save and quit interrupts unfinished processing, and restart never repeats requests automatically. Hardware pause privacy and real-provider behavior remain unqualified.

Never rename simulated results as actual recordings. Qualification recordings require explicit authorization and identifiable synthetic speech or tones, not private meetings.
