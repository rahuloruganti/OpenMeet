# Phase 7 hardware qualification checklist (Python build)

This checklist is for the owner to run personally on this Windows 11 PC. It qualifies the **Python
build**, `py\dist\OpenMeet-py.exe`, on real audio hardware, real models and real power states. Nothing
in this document has been run by the agent that wrote it. Every result below is blank until the owner
records it.

## Purpose and scope

- **Qualifies:** the Python build's recording (microphone and system audio), pause privacy, device and
  power failures, recovery, the 60-minute clock check, local and sherpa-onnx transcription, automatic
  processing, global shortcuts, meeting detection, Windows credential storage, and data deletion.
- **Out of scope:** the Rust Tauri app. It cannot be compiled on this PC (no Windows SDK or MSVC), so
  nothing here qualifies `src-tauri/`. Rust app behaviour is described only in `docs/user-guide.md`.
- **Not claimed until every box passes:** that recording is reliable, that transcripts are accurate, or
  that the Python build can replace the Rust app. Until then the "unqualified" labels stay (see section O).
- A passing `pytest` run, a `--smoke` run, a browser check or a fake-device run is **not** a pass here.

## Consent and privacy rules

- Record **only yourself**, your own voice and the test tones in `C:\OpenMeetQual\audio`. Do not record
  other people. If anyone else is in the room, tell them before you start and stop if they object.
- Delete test recordings afterwards (section O). Keep only the evidence files you need.
- **Never paste meeting content, transcripts, speech text, API keys, credentials or signed URLs into a
  report.** Record counts, timings, status text, file sizes, hashes and the `verify_recording` summary
  lines only. Use the fictional titles given in each step (`QUAL-...`).
- This build has **no telemetry**. Nothing leaves the PC unless you choose a cloud connection in
  section I or J. Local transcription keeps audio on the PC.
- Recording consent law is your responsibility. The app does not check consent.

## Prerequisites

| Item | Needed for | Check |
| --- | --- | --- |
| Windows 11 Pro, current updates | all | `winver` shows the build; record it |
| WebView2 Runtime | the window (sections A onward) | installed (Edge ships it) |
| Built exe: `py\dist\OpenMeet-py.exe` | all | build with `powershell -ExecutionPolicy Bypass -File py\build.ps1` from the repo root; record `Get-FileHash -Algorithm SHA256 py\dist\OpenMeet-py.exe` |
| Microphone privacy on | sections A, B, E | Settings > Privacy & security > Microphone: "Microphone access" On, and "Let desktop apps access your microphone" On |
| Built-in or USB microphone | A, B, C | |
| Speakers or headset (system output) | B, C, H, K, L | |
| **Optional:** USB or Bluetooth headset | E (device loss), A6 (saved device missing) | marked `[HW-USB]` |
| Second app that plays audio | B, C, H | Windows Media Player or a browser |
| Free disk space | H needs about 5 GB (the 60-minute marker file about 1.4 GB, two tracks up to about 1.4 GB each at 48 kHz stereo float32, plus index files); I needs the model size shown in Settings | `Get-PSDrive C` |
| Power settings | F (sleep), H (no sleep) | see section F; restore afterwards |
| Stopwatch or phone clock | B, H, F | record start and stop times |
| Internet | I and J only, for model downloads and an AI connection you choose | |
| Optional AI server | J | e.g. a local OpenAI-compatible server such as Ollama, or your own connection |

Scratch folder used by every step (create it first):

```
mkdir C:\OpenMeetQual
mkdir C:\OpenMeetQual\audio
mkdir C:\OpenMeetQual\evidence
mkdir C:\OpenMeetQual\results
```

### Check that no fake mode is set

The fake-device switches must be absent. Run this first; the result must be empty:

```
Get-ChildItem Env: | Where-Object { $_.Name -like 'OPENMEET_PY_*' }
```

If anything prints, close the terminal, open a new one, and run it again. Do not continue while it prints
anything.

### Where the data lives

| What | Default location | Used by this checklist |
| --- | --- | --- |
| Database | `%APPDATA%\OpenMeetPy\meetings.db` | Never. Every run uses `--data-dir` (below). |
| Audio | `<data folder>\audio\<meeting-id>\` with `mic.wav`, `system.wav`, `mic.timing.jsonl`, `system.timing.jsonl` | `C:\OpenMeetQual\data-<run>\audio\<meeting-id>\` |
| Exports | the folder you choose in Settings > Export & storage | `C:\OpenMeetQual\export` |
| Credentials | Windows Credential Manager | section M only |

**Always pass `--data-dir` so the owner's real data is never mixed with test data.** Use a new folder
per run, for example `C:\OpenMeetQual\data-A`. The exe creates it on first start.

### How to start the exe

```
cd C:\Users\Rahul\Documents\personal\openmeet
py\dist\OpenMeet-py.exe --data-dir C:\OpenMeetQual\data-A
```

Other flags (used in section A only):

- `--smoke`: starts the server, checks `/health` and one command, prints `OK: ...` and exits. No window.
- `--check-audio-import`, `--check-stt-import`, `--check-sherpa-import`: import the library and print its
  version. They open no device and load no model.

### How to stop cleanly

1. Click **Stop** in the recording bar first, and wait for the recording bar to say stopped. Stop can take
   up to 20 seconds.
2. Close the window with the X button, or use **Save and quit** if it is shown.
3. Check that the process has ended: `Get-Process OpenMeet-py -ErrorAction SilentlyContinue` prints nothing.

Use **End task** in Task Manager only where a step says so (section G).

### Helper tools

Both tools are read-only on inputs or write only new files. They never play audio and never open a device.
Run them from the repo root with the venv Python.

- Generate a test WAV (writes a file, never plays it):

  ```
  py\.venv\Scripts\python.exe py\tools\make_test_audio.py --help
  py\.venv\Scripts\python.exe py\tools\make_test_audio.py <out.wav> [--freq 440] [--marker-freq 1000] [--marker-every 60] [--duration 300] [--channels 2] [--format float32|pcm16] [--marker-drift-ppm 0]
  ```

  It refuses to overwrite an existing file. Duration may be up to 3900 s. `--marker-every 0` makes a plain
  tone. `--marker-drift-ppm` injects a known clock error and is only for checking the verifier.

- Check a meeting folder or two WAV files (read-only):

  ```
  py\.venv\Scripts\python.exe py\tools\verify_recording.py --help
  py\.venv\Scripts\python.exe py\tools\verify_recording.py "<meeting folder>" --tone-freq 440 --marker-every 60
  py\.venv\Scripts\python.exe py\tools\verify_recording.py "<meeting folder>" --tone-freq 440 --marker-every 60 --wall-seconds 3600.0 --json > C:\OpenMeetQual\evidence\<step>-verify.json
  py\.venv\Scripts\python.exe py\tools\verify_recording.py --mic "<mic.wav>" --system "<system.wav>"
  ```

  Options: `--tone-freq` (expected tone on the system track), `--marker-freq` and `--marker-every` (must
  match the file you generated), `--marker-tracks` (default `system`), `--paused-freq` (any onset of this
  tone is reported), `--wall-seconds` (wall-clock duration of the run), `--json`.

  Exit codes: `0` no FAIL, `1` at least one FAIL, `2` inputs missing or unreadable. Each line is
  `[PASS|FAIL|INFO] <check id>: <message>`. A FAIL is a finding to record, not a reason to rerun until it passes.

- Find a meeting id (read-only):

  ```
  py\.venv\Scripts\python.exe -c "import sqlite3; db=sqlite3.connect('file:C:/OpenMeetQual/data-A/meetings.db?mode=ro', uri=True); [print(r) for r in db.execute('select id, title, status, started_at, ended_at from meetings order by started_at')]"
  ```

  Change the data folder in the path to the run you are checking.

### Interpreting verify results

- **Timing index FAIL after a crash.** The app writes the WAV before its timing line, so after a kill the
  WAV can hold one block more than the index. `timing` then FAILs with "index covers X frames but the WAV
  has Y". This is a true finding: the app also refuses transcription and seeking on such an index.
- **`finalized` FAIL** means the WAV header was never closed (an interrupted write), which is expected in
  section G before recovery.
- **`mic.markers` and `mic.drift` are not checked** by default. Markers are played on the system track only.
- The tool checks files. It does not hear them. Listening is still required (section C).

## Results table and rules

Copy this table into `C:\OpenMeetQual\results\results.md` (not into the repo). One row per step.

| Step ID | Date | Result (PASS / FAIL / BLOCKED) | Evidence (file names, verify summary line, hashes) | Notes (no meeting content) |
| --- | --- | --- | --- | --- |
| A1 | | | | |

Rules:

- **BLOCKED** means a required device, power state or model was not available. **BLOCKED is never PASS.**
  Record it, state what was missing, and leave the rest of the section open.
- **FAIL** means the step ran and the expected result did not happen. Stop the section, keep every file,
  and file the exact error text (section rules below).
- A section passes only when every step in it is PASS. A step that is not run is BLOCKED, not skipped.

### What to do on failure (every section)

1. **Stop.** Do not continue to the next step and do not retry silently.
2. **Keep the files.** Do not delete the meeting, the audio folder or the data folder.
3. Copy the **exact** error text, banner text or message from the window, and the time it appeared.
4. Note the `verify_recording` summary line for the affected files (`[FAIL] ...` lines only).
5. Record the result as FAIL, then decide with the agent whether a fix or a retry with a new data folder is
   needed. Retries use a new `--data-dir`.

## Time and hardware summary

| Section | Time | Needs |
| --- | --- | --- |
| Preparation (this page, folders, build, env check) | 30 min | |
| A. Smoke and device discovery | 20 min | microphone, output |
| B. Two distinct tracks | 30 min | microphone, output, second app |
| C. Audible content | 25 min | B's files |
| D. Paused audio excluded | 30 min | microphone, output, second app |
| E. Failure and device loss | 60 min | `[HW-USB]` for E1 to E4 |
| F. Sleep and wake | 20 min | `[SLEEP]` (the PC sleeps) |
| G. Window close and crash | 25 min | |
| H. 60-minute drift | 90 min | `[LONG]` (60 min), disk about 3 GB |
| I. Transcription with a real model | 90 min | `[MODEL]` downloads; optional `[CLOUD]` |
| J. Automatic processing and summaries | 60 min | `[AI]` (your own connection or local server) |
| K. Global hotkeys | 20 min | a free chord for the conflict test |
| L. Meeting detection | 30 min | a second app that uses the microphone |
| M. Credentials | 15 min | Windows Credential Manager |
| N. Data safety | 25 min | |
| O. Cleanup and sign-off | 20 min | |

Total: roughly 8 to 9 hours across two sittings. Sections E, F, H and I can each be split across days; the
data folder keeps its state.

---

## Preparation

- [ ] **P1** Build the exe (10 min). From the repo root:
  `powershell -ExecutionPolicy Bypass -File py\build.ps1`. Expect the last line `Built ...\py\dist\OpenMeet-py.exe`.
  Record `Get-FileHash -Algorithm SHA256 py\dist\OpenMeet-py.exe`.
- [ ] **P2** Run the env check above. The output must be empty.
- [ ] **P3** Run the unit tests once (5 min). From `py\`: `py\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
  Record the count. This does not qualify anything; it confirms the tools work on this PC.
- [ ] **P4** Create the scratch folders (see Prerequisites). Record `winver`.
- [ ] **P5** Write down the devices you will use: microphone name, output name, and the USB/Bluetooth device if you
  have one. You will check the same names in section A.
- [ ] **P6** Turn off notifications and Focus Assist for the session. Keep the PC plugged in.
- [ ] **P7** Generate the standard test files (5 min):

  ```
  py\.venv\Scripts\python.exe py\tools\make_test_audio.py C:\OpenMeetQual\audio\tone-440-120s.wav --duration 120 --freq 440 --marker-every 10
  py\.venv\Scripts\python.exe py\tools\make_test_audio.py C:\OpenMeetQual\audio\paused-2000hz-60s.wav --duration 60 --freq 2000 --marker-every 0
  ```

  Expected: each command prints `Wrote ...`. Do not overwrite these files later; generate new names instead.

---

## A. Smoke and device discovery (20 min)

**Goal:** the exe starts, the devices are listed correctly, and a saved device is never replaced silently.
**Preconditions:** P1 to P5 done. `--data-dir C:\OpenMeetQual\data-A`.

- [ ] **A1 Smoke** (2 min). Command:
  `py\dist\OpenMeet-py.exe --smoke --data-dir C:\OpenMeetQual\data-A`.
  Expected: prints `OK: /health 200, list_meetings returned 0 meetings.` and exits with code 0 (check with `echo %errorlevel%`
  or `$LASTEXITCODE`). Evidence: the console line.
- [ ] **A2 Import checks, no devices** (3 min). Run each:
  `py\dist\OpenMeet-py.exe --check-audio-import`, `--check-stt-import`, `--check-sherpa-import`.
  Expected: each prints `OK: ...` with its library name and "no ... was opened/loaded". Nothing else.
- [ ] **A3 Launch the window** (2 min). `py\dist\OpenMeet-py.exe --data-dir C:\OpenMeetQual\data-A`.
  Expected: a window titled **OpenMeet** opens (minimum size 720 by 580). If a **First-run setup** dialog appears,
  you may complete or dismiss it. Record which.
- [ ] **A4 Devices in Settings** (4 min). Click **Settings** in the sidebar (or the collapsed toolbar), then the
  **Recording** tab, then the **Default devices** section. Open **Default microphone** and **Default system audio**.
  Expected: every microphone you use is listed. Every system-audio entry ends with the text
  `(all audio, includes OpenMeet playback)`. Record the names exactly.
- [ ] **A5 Devices in New recording** (3 min). Click **+ New recording** in the sidebar (or **New recording** in the
  toolbar), then **Refresh devices**. Expected: the **Microphone** and **System audio** selects show the same names as
  A4, with no "(unavailable)" entry. Click **Close**.
- [ ] **A6 Saved device is not replaced silently** `[HW-USB]` (5 min). With the USB or Bluetooth device connected,
  choose it under **Default microphone** and confirm it is saved. Close the app. Unplug the device. Start the app
  again with the same `--data-dir`. Open **+ New recording**.
  Expected: the **Microphone** select shows **Saved microphone (unavailable)**, the panel shows the alert
  "Selected microphone is unavailable. Connect or allow it ..." with "no device is substituted", and **Start recording**
  is disabled. No other microphone is selected. Plug the device back in and press **Refresh devices**; it becomes
  selectable again. Record the exact alert text.
  *If you have no second device, mark A6 BLOCKED. Do not substitute another device.*

**Evidence:** device names (A4), screenshot names (not contents), A1 and A2 console lines.
**Failure:** stop; keep `C:\OpenMeetQual\data-A`; record the exact text.

---

## B. Two distinct tracks (30 min)

**Goal:** the microphone and the system track record different sources, both files finish, and the meters move
independently.
**Preconditions:** A passed. Speakers or a headset for output (a headset reduces bleed into the microphone; record which
you used). The file `C:\OpenMeetQual\audio\tone-440-120s.wav` open in a media player, not yet playing. Stopwatch ready.
`--data-dir C:\OpenMeetQual\data-B`.

- [ ] **B1 Start** (2 min). Click **+ New recording**. Type the title `QUAL-B1`. Choose the **Microphone** and
  **System audio** you intend to use. Click **Start recording**.
  Expected: the recording bar shows **Recording** and two meters labelled **Mic** and **System**. Record the start time.
- [ ] **B2 Speech only** (1 min). Speak your own sentence into the microphone for 15 seconds. Do not play anything.
  Expected: **Mic** moves (its label reads "signal" or "quiet" then changes with your voice). **System** stays "quiet".
  No "no signal" text on the **Mic** meter.
- [ ] **B3 Tone only** (1 min). Play `tone-440-120s.wav` in the media player for 20 seconds. Keep talking quietly
  or stay silent. Expected: **System** moves while the file plays. **Mic** moves only if it hears the speakers.
  Stop the player after 20 seconds.
- [ ] **B4 Both at once** (1 min). Play the tone again for 15 seconds while speaking your sentence. Expected: both meters
  move. Stop the player.
- [ ] **B5 Stop** (2 min). Click **Stop** and wait. Expected: the recording bar reads **Recording: stopped** (or
  "Not recording" after it finishes); no error banner. Record the stop time.
- [ ] **B6 Locate files** (3 min). Find the meeting id with the read-only query in Helper tools. Open
  `C:\OpenMeetQual\data-B\audio\<meeting-id>\`. Expected files: `mic.wav`, `system.wav`, `mic.timing.jsonl`,
  `system.timing.jsonl`. Record their sizes (`dir`).
- [ ] **B7 Verify** (5 min). Run:
  `py\.venv\Scripts\python.exe py\tools\verify_recording.py "C:\OpenMeetQual\data-B\audio\<meeting-id>" --tone-freq 440 --marker-every 10 --json > C:\OpenMeetQual\evidence\B7-verify.json`
  and the same without `--json` to read the summary.
  Expected: `mic.header`, `system.header` PASS (float32, format tag 3). `mic.finalized` and `system.finalized` PASS.
  `mic.frames` and `system.frames` PASS (frames > 0). `pair.distinct` PASS. `system.tone` PASS (about 440 Hz). `system.timing` PASS.
  `pair.envelope_correlation` is INFO only.

**Evidence:** B5 times, B6 sizes, the B7 summary lines, the JSON file.
**Failure:** a missing file, a `FAIL` on finalization, or a silent track is a FAIL. Keep the folder and stop.

---

## C. Audible content (25 min)

**Goal:** the files contain what the meters showed, the tone and the voice are audible, and the levels are not clipped or silent.
**Preconditions:** B passed. Use the B meeting `QUAL-B1`.

- [ ] **C1 Transcript tab players** (5 min). Open `QUAL-B1` in **My notes**. Click the **Transcript** tab.
  Expected: one player per track. Play the **mic** player for 10 seconds: your voice is audible, and the tone is faint or absent.
  Play the **system** player for 20 seconds from the start of the tone: the tone and the 1 kHz marker bursts (every 10 s) are audible,
  and your voice is absent. Record what you heard in your own words.
- [ ] **C2 External player** (5 min). Open `mic.wav` and `system.wav` in an external player (Windows Media Player or VLC). If a player
  cannot open 32-bit float WAV, record "player cannot decode" and use Audacity instead. Expected: the same content as C1.
- [ ] **C3 Levels** (3 min). Run the verifier from B7 again and read the `level`, `clipping` and `silence` lines.
  Expected: `clipping` PASS (no samples at full scale above 0.01 %). `silence` on **system** is INFO (not FAIL) with peak
  above -60 dBFS. If `clipping` FAILs, lower the output volume and repeat B with a new meeting.
- [ ] **C4 Expected frequency on system** (2 min). The `system.tone` line must show about 440 Hz (PASS). Record the value.
- [ ] **C5 Marker spacing on system** (5 min). Expected: `system.markers` PASS (about 12 bursts in 120 s, spacing 10 s).
  `system.marker_jitter` INFO shows max residual in ms. Record both.

**Evidence:** C1 notes (own words), C2 player name and result, the C3 to C5 summary lines.
**Failure:** if the mic has no voice or the system has no tone while B showed meter movement, that is a FAIL. Keep the files.

---

## D. Paused audio excluded (30 min)

**Goal:** audio captured while paused is absent from both files, and the timing index shows the pause.
**Preconditions:** A to C passed. Play `paused-2000hz-60s.wav` only during the pause, as described. The tone at 440 Hz is
the normal tone. The paused marker is a 2000 Hz tone.
`--data-dir C:\OpenMeetQual\data-D`.

- [ ] **D1 Start and positive control** (4 min). Start `QUAL-D1` (same devices as B). Play `paused-2000hz-60s.wav` for
  10 seconds while recording is **active** (positive control). Stop the player.
  Expected: the recording bar reads **Recording**. Record the start clock time.
- [ ] **D2 Active speech and tone** (2 min). Play `tone-440-120s.wav` for 20 seconds while you speak one sentence.
  Stop the player.
- [ ] **D3 Pause** (2 min). Click **Pause**. Expected: the recording bar reads **Recording: paused**. Note the pause clock time.
- [ ] **D4 Paused marker and marker word** (60 s). While paused, play `paused-2000hz-60s.wav` for 30 seconds
  and say the marker word `Quarterly` clearly at least three times. Stop the player. Expected: nothing in the app changes
  while paused and no meter moves.
- [ ] **D5 Resume** (2 min). Click **Resume**. Expected: **Recording**. Record the resume clock time.
- [ ] **D6 Active tone after resume** (2 min). Play `tone-440-120s.wav` for 20 seconds, speaking one sentence. Stop the player.
- [ ] **D7 Stop** (1 min). Click **Stop**. Record the stop clock time.
- [ ] **D8 Verify paused-tone onsets** (5 min). Run:
  `py\.venv\Scripts\python.exe py\tools\verify_recording.py "C:\OpenMeetQual\data-D\audio\<meeting-id>" --tone-freq 440 --marker-every 10 --paused-freq 2000 --json > C:\OpenMeetQual\evidence\D8-verify.json`.
  `system.paused_marker` and `mic.paused_marker` will show **FAIL** because D1 played the 2000 Hz tone while active. That FAIL is
  expected for this run. Judge the result by the onset times, not the status: open the JSON and read
  `tracks.system.paused_marker_onsets_s` and `tracks.mic.paused_marker_onsets_s`. Expected: every onset lies in the first
  11 seconds of the file (D1's positive control). Any onset later than that is a FAIL of pause privacy.
  Also expected: `system.pauses` INFO lists one pause, and `system.pause_consistency` PASS.
- [ ] **D9 Listen at the pause** (5 min). In `system.wav` and `mic.wav` (external player), go to the file time given by
  `tracks.system.timing.pauses[0].file_time_s` in the D8 JSON. Expected: no 2000 Hz tone and no spoken "Quarterly" at that point,
  and the audio resumes with the D5 content. Record "absent" or "present" for each file.
- [ ] **D10 Frames versus active time** (3 min). Expected: `frames` (ms) about equal to (D3 pause clock time minus D1 start) plus
  (D7 stop clock time minus D5 resume clock time), within 1 second. The stopwatch limits accuracy. Record both numbers.
- [ ] **D11 Gap in the index** (1 min). The verifier's `system.pauses` entry must show one gap whose `duration_ms` matches the
  pause length you timed (within 1 second). Record it.

**Evidence:** D1 to D7 clock times, D8 JSON, D9 numbers.
**Failure:** any paused-tone onset after D1 is a FAIL of pause privacy. Keep both files and do not replay the test
on the same folder.

---

## E. Failure and device loss (60 min)

**Goal:** failures show visibly, keep recoverable files, never switch devices silently, and recover through **Recover audio**.
**Preconditions:** A to D passed. A USB or Bluetooth microphone and/or headset is needed for E1 to E4 `[HW-USB]`.
`--data-dir C:\OpenMeetQual\data-E`.

- [ ] **E1 Unplug the microphone during recording** `[HW-USB]` (8 min). Start `QUAL-E1` with the USB microphone selected.
  Speak for 20 seconds, then unplug the microphone. Expected: a red **Capture:** banner appears with text starting
  "An audio device stopped responding (...). Both tracks paused; stop, check permissions/devices, and start again." The
  recording bar reads **Recording: paused**. Record the exact banner text. Click **Dismiss capture error** only after recording it.
- [ ] **E2 Stop after device loss** (3 min). Click **Stop**. Expected: the meeting ends with its error recorded (status
  interrupted). Run the verifier on the folder. Expected: `mic.finalized` and `system.finalized` PASS (the writer closed on stop),
  frames end at the unplug time (within 2 s), `mic.timing` PASS. Record the verifier lines.
- [ ] **E3 Recover audio if offered** (5 min). Open `QUAL-E1`. If an **Interrupted recording** card with **Recover audio** appears,
  record its hashes first, then click **Recover audio**. Expected: repaired copies `mic.recovered-<uuid>.wav` and/or
  `system.recovered-<uuid>.wav` appear next to the originals; the originals' SHA-256 hashes (`Get-FileHash`) are unchanged.
  If the card does not appear because both files were finalized on stop, record "Recover audio not offered (finalized)" as
  the observed result and rely on the verifier. Do not treat that alone as FAIL.
- [ ] **E4 No silent switch on resume** `[HW-USB]` (8 min). Start `QUAL-E2` with the USB microphone selected. Speak 10 seconds. Unplug
  the USB microphone (the built-in microphone stays present). Click **Pause**, then **Resume** while the USB microphone is still
  unplugged. Expected: an error banner names the microphone as unavailable ("Selected microphone is unavailable. Enable microphone
  access or remote microphone redirection, then refresh devices." or the panel alert text). The recording stays paused, and the
  built-in microphone is **not** used (its meter does not move). Record the exact text. Click **Stop**.
- [ ] **E5 Output removed or changed during recording** `[HW-USB]` (8 min). Start `QUAL-E3` with the headset selected as system audio.
  Play the tone for 10 seconds. Disconnect the headset. Expected: a **Capture:** banner names the system output
  ("...system output..." or "An audio device stopped responding ..."). Then record what happens when you change the default
  output in Windows Sound settings while recording: expected that OpenMeet does **not** switch to the new output
  (the **System** meter shows no signal from it). Record observed behaviour. Click **Stop**.
- [ ] **E6 Selected device missing at start** (5 min). Unplug the USB microphone, leave it unplugged, open **+ New recording**, select
  the saved microphone, and press **Refresh devices**. Expected: the alert "Selected microphone is unavailable ..." is shown and
  **Start recording** is disabled. Confirm no new folder appeared under `C:\OpenMeetQual\data-E\audio\` and no new meeting appears
  in the sidebar.
- [ ] **E7 Microphone privacy toggle off** (10 min). Open Settings > Privacy & security > Microphone. Turn **Microphone access** Off.
  Back in OpenMeet, click **Refresh devices** in New recording, then try **Start recording** with a title.
  Expected: an error with the exact message from the app. Expected text candidates: "Selected microphone is unavailable. Enable
  microphone access or remote microphone redirection, then refresh devices." (the start error) or the panel alert. Record the
  exact text shown, whichever it is. Expected: no folder and no meeting created. **Turn Microphone access back On** and record that.

**Evidence:** every banner text verbatim, the verifier lines for E2, hashes for E3, and the E6 and E7 observations.
**Failure:** stop after the failing step. A silent device switch, a missing error, or a file that disappeared is a FAIL.
If `[HW-USB]` hardware is missing, mark E1 to E5 BLOCKED. E6 and E7 need no extra hardware.

---

## F. Sleep and wake (20 min) `[SLEEP]`

**Goal:** a sleep during recording is visible, the files stay valid, and nothing is written after wake without the owner's action.
**Preconditions:** A to E passed. Record your current sleep setting before you start.
**Power setting for this test:** Settings > System > Power & battery > Screen and sleep > "When plugged in, put my device to sleep after" = **1 minute**.
(Label wording can differ by Windows version; record the label you see.) Restore the old value in O.

- [ ] **F1 Start** (1 min). Start `QUAL-F1`. Play `tone-440-120s.wav` for the whole test. Record the start clock time.
- [ ] **F2 Run 2 minutes** (2 min). Let the recording run for 120 seconds.
- [ ] **F3 Sleep** (2 min). Click the Start menu > **Power** > **Sleep**. Wait 90 seconds. Wake with the keyboard.
- [ ] **F4 Observe** (3 min). Expected: a **Capture:** banner reads "Capture was interrupted by sleep or a scheduling gap. Stop and
  start a new recording." The recording bar reads **Recording: paused**. Record the exact text and the time you saw it.
  **If no banner appears** after wake, record "no sleep banner" and continue; that is a FAIL of sleep detection (the meter uses
  a monotonic clock that may not advance across sleep). Keep the files.
- [ ] **F5 Stop** (1 min). Click **Stop**. Record the stop clock time.
- [ ] **F6 Verify** (5 min). Run the verifier on `QUAL-F1`. Expected: `system.finalized` PASS; `system.frames` about 120 s
  (not about 210 s; within 2 s); no `system.gaps` FAIL. A recording with no sleep banner may show a gap; read it and record it.
- [ ] **F7 Restore power setting** (1 min). Put the sleep value back to the value you recorded.

**Evidence:** F4 banner text, F6 frames, sleep start and wake clock times.
**Failure:** no banner, or frames that run past the sleep time, is a FAIL. Keep the folder.

---

## G. Window close and crash (25 min)

**Goal:** closing the window finalizes files; a killed process leaves a meeting marked **interrupted** whose audio can be recovered
without touching the originals.
**Preconditions:** A to F passed. `--data-dir C:\OpenMeetQual\data-G`.

- [ ] **G1 Close during recording** (6 min). Start `QUAL-G1` with `tone-440-120s.wav` playing for 30 seconds. Close the window with
  the **X** button while recording is active. Expected: the process exits. Restart the exe with the same `--data-dir`.
  Expected: `QUAL-G1` shows status **stopped** with no error; no **Interrupted recording** card. Run the verifier on the folder:
  `mic` and `system` finalized PASS, frames about 30 s.
- [ ] **G2 Kill the process** (5 min). Start `QUAL-G2` (speak and play the tone for 40 seconds). Open Task Manager > Processes >
  **OpenMeet-py** > **End task** (or `taskkill /IM OpenMeet-py.exe /F`). Expected: the window disappears. Record the time.
- [ ] **G3 Restart and find interrupted** (4 min). Start `py\dist\OpenMeet-py.exe --data-dir C:\OpenMeetQual\data-G`. Expected:
  `QUAL-G2` shows status **interrupted**. Open it: the **Interrupted recording** card appears with **Recover audio**.
  Before clicking, record `Get-FileHash -Algorithm SHA256` for `mic.wav`, `system.wav`, and both timing files.
- [ ] **G4 Recover audio** (5 min). Click **Recover audio**. Expected: "Recovering..." then the card goes away. New files
  `mic.recovered-<uuid>.wav` and `system.recovered-<uuid>.wav` appear. Record `Get-FileHash` of the **originals** again.
  Expected: identical to G3.
- [ ] **G5 Verify recovered and originals** (5 min). Run the verifier on the meeting folder. Expected on the **recovered** copies:
  header and finalized PASS, frames about 40 s. The verifier's `timing` line may FAIL with "index covers X frames but the WAV
  has Y" (see Interpreting verify results). Record it as observed. Expected on the **originals**: `finalized` FAIL
  (the header was never closed), which is correct.
- [ ] **G6 Cleanup of copies** (1 min). Leave the recovered copies in place until section O.

**Evidence:** G1 status and verifier lines, G2 time, G3 and G4 hashes, G5 lines.
**Failure:** a missing interrupted status after the kill, an original whose hash changed, or a recovery that overwrote a file is a FAIL.

---

## H. 60-minute drift (90 min) `[LONG]`

**Goal:** over a full 60-minute run, the measured clock drift stays below 100 ms, as AGENTS.md requires, and the files match the
wall clock.
**Preconditions:** A to G passed. Free disk space of at least 5 GB. Sleep disabled for the whole run. Notifications off.
Keep the PC plugged in. Do not use the PC for other work during the run.

- [ ] **H0 Verifier control, short** (5 min). Confirm the verifier reports a known drift. Generate and check:
  `py\.venv\Scripts\python.exe py\tools\make_test_audio.py C:\OpenMeetQual\audio\control-2000ppm-600s.wav --duration 600 --marker-every 60 --marker-drift-ppm 2000`
  then `py\.venv\Scripts\python.exe py\tools\verify_recording.py --system C:\OpenMeetQual\audio\control-2000ppm-600s.wav --marker-every 60`.
  Expected: `system.drift` FAIL (extrapolated 60-minute drift about 7200 ms). This proves the drift check can FAIL.
  Record the line. (`system.timing` will FAIL because there is no index; ignore that line.)
- [ ] **H1 Generate the 60-minute marker tone** (5 min). Command:
  `py\.venv\Scripts\python.exe py\tools\make_test_audio.py C:\OpenMeetQual\audio\marker-60min.wav --duration 3600 --freq 440 --marker-every 60`.
  Expected: `Wrote ... 3600 s, ... 59 marker bursts every 60 s`. The file is about 1.4 GB for 48 kHz stereo float32.
  Record the size.
- [ ] **H2 Start** (2 min). `--data-dir C:\OpenMeetQual\data-H`. Settings > Recording > Automatic processing: **When a recording stops**
  = **Recording only**. Click **+ New recording**, title `QUAL-H1 60min`, choose the microphone and the system audio you use.
  Click **Start recording**. Record the start clock time (and the stopwatch start).
- [ ] **H3 Play the 60-minute file** (60 min). Open `marker-60min.wav` in the media player with **repeat off**. Play it fully from
  the start to the end without pausing, seeking or changing the volume. Keep the microphone open in the room (silent is fine).
- [ ] **H4 Monitor every 10 minutes** (60 min, by the clock). Record, at 10, 20, 30, 40, 50 and 60 minutes: Task Manager
  **OpenMeet-py.exe** CPU %, Memory (working set), free disk space on C:, and whether the **System** meter is showing "signal".
  Expected: no **Capture:** banner at any time. Any banner is a FAIL; record its text and the time.
- [ ] **H5 Stop** (2 min). When the file ends, click **Stop**. Record the stop clock time and stop the stopwatch.
- [ ] **H6 Read the meeting times and counts** (3 min). Save this as `C:\OpenMeetQual\h6_times.py` (copy it exactly; it opens the
  database read-only and prints only the timestamps, the id and the track counts):

  ```python
  import sqlite3, datetime as dt, sys

  db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
  parse = lambda s: dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
  row = db.execute(
      "select id, started_at, ended_at, status from meetings where title like 'QUAL-H1%' order by started_at desc limit 1"
  ).fetchone()
  print("meeting", row[0], row[3])
  print("wall_seconds", (parse(row[2]) - parse(row[1])).total_seconds())
  for track in db.execute("select kind, frames, dropped_frames, finalized from tracks where meeting_id = ?", (row[0],)):
      print(track)
  ```

  Run it: `py\.venv\Scripts\python.exe C:\OpenMeetQual\h6_times.py C:/OpenMeetQual/data-H/meetings.db`.
  Record `wall_seconds`, each track's `frames`, `dropped_frames` and `finalized`. `dropped_frames` must be 0 for both tracks.
- [ ] **H7 Verify** (10 min). Run (use the `wall_seconds` value from H6):
  `py\.venv\Scripts\python.exe py\tools\verify_recording.py "C:\OpenMeetQual\data-H\audio\<meeting-id>" --tone-freq 440 --marker-every 60 --wall-seconds <wall_seconds> --json > C:\OpenMeetQual\evidence\H7-verify.json`
  and read the summary. Record: `system.drift` (measured drift in ms over the run, and ppm), `system.wallclock`, `mic.wallclock`, `system.gaps`,
  `mic.gaps`, `system.markers` (count), `pair.duration`.
- [ ] **H8 Size check** (2 min). Expected size per file is about frames x channels x 4 bytes + 58 bytes header, plus about 4 kB per second of
  timing index. Compare `Get-Item` sizes with that estimate. Record both numbers.

**Pass rule for H (all must hold):**
1. `system.drift` PASS: measured drift over a run of 55 minutes or more is below **100 ms** (the tool's verdict).
2. `mic.wallclock` PASS: the mic frames equal the wall-clock duration within **100 ms**.
3. `system.wallclock` PASS: the same for the system track.
4. `dropped_frames` = 0 on both tracks and no `gaps` FAIL on either track.
5. No capture banner during H4.

Report the measured numbers even if a check fails. Extrapolated 60-minute drift is reported separately and does not replace the measured value.

**Measurement uncertainty to record:** `started_at` and `ended_at` are set by the app a few tens of milliseconds
around the audio start and stop, and the stopwatch is accurate to about a second. Use `wall_seconds` from H6, not the stopwatch,
for the 100 ms check. Note any difference between the two.

**Evidence:** H0 line, H1 size, H4 table, H6 numbers, H7 JSON, H8 sizes.
**Failure:** any FAIL is recorded with its number. Keep the folder; do not re-run on the same folder.

---

## I. Transcription with a real model (90 min) `[MODEL]`

**Goal:** a real local speech model downloads with its checksums, transcribes owner speech with timestamps that play back, and
cancel or re-transcribe keep earlier results.
**Preconditions:** H passed or BLOCKED. Internet for the downloads. This section downloads models from Hugging Face or GitHub only
after you click the download button. Nothing downloads at start-up. `--data-dir C:\OpenMeetQual\data-I`.

Passage to read (fictional, read in your own voice; keep the recording of it in `C:\OpenMeetQual\data-I`):

> On Tuesday the project team met to review the quarterly budget. Maria asked for the revised timeline by Friday, and Dev
> agreed to send the vendor list before lunch. The next review is planned for the third week of November in the large meeting room.

- [ ] **I1 Choose the local engine** (5 min). Settings > **Transcription**. Choose **On this computer** under **Transcription engine**
  (the first choice card). Expected: status text reads **Not installed** (or **Installed and verified**). Open **Available speech models**.
  Record the displayed size and label for **Whisper small** (or the nearest Whisper small label).
- [ ] **I2 Download and verify** (15 min, depends on bandwidth). Click **Download speech engine and models (≈ ...)**. Expected: progress
  text "Downloading ..." with byte counts, then status **Installed and verified**. Downloads are checked against pinned SHA-256
  checksums automatically. A checksum or "already exists" error is a FAIL: stop, keep the data folder, file the text.
  Record the total downloaded bytes shown.
- [ ] **I3 Record the passage** (5 min). Click **+ New recording**, title `QUAL-I1`, Start recording. Read the passage once at normal pace
  (about 25 seconds). Wait 5 seconds, then click **Stop**.
- [ ] **I4 Transcribe** (depends on length). Open `QUAL-I1` and the **Transcript** tab. Click **Transcribe audio** (or the
  **Next steps** card action). Expected: progress is shown on this tab; the transcript appears when done. Record the start and end time.
- [ ] **I5 Accuracy, subjective** (5 min). Compare the transcript with the passage. Count the words that are wrong or missing
  (write the number only). Expected: the passage is recognisable. There is no pass threshold; record the number and your judgement.
- [ ] **I6 Timestamps and playback** (5 min). Expected: timestamps increase from one segment to the next (no step backwards).
  Click a timestamp: the matching track player seeks, and the audio at that time matches the text. Record one example pair
  (time and whether it matched), without copying the transcript text.
- [ ] **I7 Cancel keeps the previous transcript** (10 min). Click **Re-transcribe audio**, then **Re-transcribe** in the confirmation.
  While it runs, click **Cancel transcription**. Expected: the run stops; the previous transcript remains; the message says cancelling
  keeps the previous transcript.
- [ ] **I8 Re-transcribe keeps the earlier version** (10 min). Run **Re-transcribe audio** to completion. Expected: the earlier
  transcript appears under **Earlier transcripts** (read-only section, labelled "Earlier transcript (read-only)").
- [ ] **I9 Time to transcribe** (record only). Divide the transcription time by the audio length. Record both.
- [ ] **I10 Optional sherpa-onnx models** (30 min, optional). In **Available speech models**, choose **Parakeet**, **Moonshine** or
  **SenseVoice** (labels as shown). Record each displayed size. Download and repeat I3 to I9 for one of them.
  Note: the **SenseVoice** model's licence is **not confirmed** (see `THIRD_PARTY_LICENSES.md`). Only you can decide whether to use it.
  Mark BLOCKED any model you do not run.
- [ ] **I11 Cloud speech `[CLOUD]`** (optional, only if you choose it). Settings > **Connections**: create your own connection with an
  HTTPS base URL and your own key (the key field is uncontrolled; do not paste it anywhere else), **Save connection**. Settings >
  **Transcription** > **API connection**, select the connection and a model. Transcribe a 20-second owner-only clip.
  Expected: the choice card text "Uploads audio to your speech connection." Audio leaves the PC. Costs may apply. In-flight requests
  cannot be recalled. Record the result and the connection's provider name only.

**Evidence:** I1 and I2 sizes and status texts, I5 count, I6 example pair, I7 and I8 result texts, I9 times.
**Failure:** a checksum error, a crash, or a transcript that replaces the previous one after cancel is a FAIL.

---

## J. Automatic processing and summaries (60 min) `[AI]`

**Goal:** processing runs its stages after a recording, the notes barrier and cancel behave, and an interrupted run is shown without an
automatic retry.
**Preconditions:** I passed (Whisper small installed). An AI connection you choose: your own OpenAI-compatible endpoint or a local server
such as Ollama on your PC (for Ollama, the base URL is the OpenAI-compatible address shown by your Ollama install; record the one you used).
`--data-dir C:\OpenMeetQual\data-J`.

- [ ] **J1 Connection** (10 min). Settings > **Connections**: **Base URL** and optional **API key** (a local server needs no key;
  the form reads "Local server. API key optional."), **Save connection**. Then Settings > **AI notes** and assign a model to the
  summary task. Expected: the connection shows "API key saved in the OS keychain" for a key, or the local-server text. Record the model id used.
- [ ] **J2 Choose processing** (3 min). Settings > **Recording** > **Automatic processing**: **When a recording stops** =
  **Final transcription after stop**. **Automatic summary** = a built-in template (for example "General summary"; record the label).
- [ ] **J3 Stages** (15 min). Start `QUAL-J1`, read the passage in I3, stop. Watch the **Session processing** panel (heading
  **Automatic processing**, line **Stage: ...**). Record each stage label in the order shown. The plan's stage ids are
  live, finalizing_audio, transcribing, awaiting_notes, summarizing, completed (the panel shows its own labels). Expected to end at
  completed ("Done" or the completed label).
- [ ] **J4 Notes barrier** (10 min). Start `QUAL-J2`, speak 20 seconds, stop, and type a line in **My notes** while processing is still
  running. Expected, if the stage reaches waiting: the text "Automatic summary waits for saved notes." and the button
  **Save notes and continue processing**. Click it and expect the summary to continue. Record whether the stage was reached.
- [ ] **J5 Cancel keeps the transcript** (8 min). Start `QUAL-J3`, stop, and click **Cancel session processing** during the summary
  stage. Expected: the stage reads cancelled. The transcript remains. No summary is saved for that run. Record the stage.
- [ ] **J6 Retry** (5 min). Click **Retry processing** on the cancelled run. Expected: it runs again and completes; a completed
  transcript is kept. Record the stage and the **Used N requests** line.
- [ ] **J7 Interrupted after quit** (10 min). Start `QUAL-J4`, stop, and while the stage is transcribing use **Save and quit**.
  Restart with the same `--data-dir`. Expected: the panel shows **interrupted** and does not start any request on its own. Record the
  stage name and that no new request was sent (the **Used** line does not grow).
- [ ] **J8 Failure keeps the recording** (5 min). Stop your AI server (or set a wrong base URL). Start `QUAL-J5` and stop. Expected: a visible
  error in the panel (stage failed or needs attention) and the recording is still kept. Record the exact error text. Restore the server.

**Evidence:** stage names J3, the J4 barrier text, J5 and J6 stages, J7 stage after restart, J8 error text.
**Failure:** an automatic retry after restart, a lost transcript after cancel, or a recording that disappears is a FAIL.

---

## K. Global hotkeys (20 min)

**Goal:** pause and stop shortcuts work while another app has focus, taken chords are reported, a held key toggles once, and shortcuts are
released on quit. There is no shortcut to start a recording.
**Preconditions:** A to J passed or BLOCKED. Notepad open in another window. `--data-dir C:\OpenMeetQual\data-K`.

- [ ] **K1 Save shortcuts** (3 min). Settings > **Recording** > **Keyboard shortcuts**: **Pause / resume shortcut** = `Ctrl+Shift+F9`;
  **Stop recording shortcut (optional)** = `Ctrl+Shift+F10`. Click **Save shortcuts**. Expected: no error.
- [ ] **K2 Pause and resume with focus elsewhere** (5 min). Start `QUAL-K1` and speak. Click into Notepad so it has focus.
  Press `Ctrl+Shift+F9`. Switch to OpenMeet: **Recording: paused**. Press `Ctrl+Shift+F9` again: **Recording**.
- [ ] **K3 Held key toggles once** (3 min). Hold `Ctrl+Shift+F9` for about 3 seconds (key repeat on). Expected: exactly one state change
  (paused or recording, one step). Record what you counted.
- [ ] **K4 Stop shortcut** (2 min). With focus in Notepad, press `Ctrl+Shift+F10`. Expected: the recording stops; the meeting shows stopped.
- [ ] **K5 Taken chord shows an error** (3 min). Settings > Recording > Keyboard shortcuts: set **Pause / resume shortcut** to `Ctrl+Shift+Space`
  and click **Save shortcuts**. On this PC another app already owns that chord (a Phase 1 probe returned error 1409). Expected: a visible error
  reading "This shortcut could not be registered. Choose another combination." The earlier shortcut stays active (repeat K2 quickly).
  Record the exact text.
- [ ] **K6 Bare key refused** (1 min). Enter `Shift+A` in the pause field. Expected: the hint "Add Ctrl or Alt, or use an F-key." Record it.
- [ ] **K7 No start shortcut** (1 min). Read the text under the shortcut fields: "There is no shortcut to start recording: starting always goes through New recording."
  Record it.
- [ ] **K8 Released on quit** (5 min). Save and quit the app (or close the window). Start a second instance:
  `py\dist\OpenMeet-py.exe --data-dir C:\OpenMeetQual\data-K2`. Set **Pause / resume shortcut** to `Ctrl+Shift+F9` and **Save shortcuts**.
  Expected: no "could not be registered" error (the first instance released the chord). Close the second instance.

**Evidence:** K2 to K8 texts and counts.
**Failure:** a chord that still works after quit, a repeated toggle from one hold, or a missing error for a taken chord is a FAIL.

---

## L. Meeting detection (30 min)

**Goal:** a microphone-using app produces a prompt that only offers to set up recording; the prompt never starts capture or picks devices.
**Preconditions:** K passed or BLOCKED. A second app that uses the microphone: Windows Voice Recorder, or a browser microphone test page you choose.
`--data-dir C:\OpenMeetQual\data-L`.

- [ ] **L1 Enable** (2 min). Settings > **Recording** > **Meeting detection**: tick **Offer to record when another app uses the microphone**.
- [ ] **L2 Prompt appears** (5 min). Open the second app and start using the microphone. Expected: within about 10 seconds a card reading
  "... is using your microphone. Record this meeting?" with **Set up recording**, **Not now** and **Never for <app name>**.
  Record the app name and the time to appear.
- [ ] **L3 Set up recording does not record** (5 min). Click **Set up recording**. Expected: the **New recording** panel opens with the title
  "<app name> meeting" (if the title was "Untitled meeting"). The recording bar shows **Not recording**. Wait 15 seconds: no new meeting
  appears in the sidebar and no folder appears under `C:\OpenMeetQual\data-L\audio\`.
- [ ] **L4 Not now** (4 min). Stop the second app's microphone use, then start it again in the same session. Expected: after **Not now**, the
  prompt does not return during the same microphone session. Record what happened on the next start.
- [ ] **L5 Never for** (5 min). Start the second app again and click **Never for <app name>**. Expected: no prompt for that app. Settings >
  Recording > **Meeting detection** lists it under **Apps never prompted about** with **Prompt again**. Click **Prompt again** and expect the prompt to return on the next start.
- [ ] **L6 Own recording ignored** (3 min). Start `QUAL-L2` (OpenMeet uses the microphone). Expected: no "OpenMeet is using your microphone" prompt.
- [ ] **L7 Minimised window flashes** (4 min). Minimise OpenMeet. Start the second app using the microphone. Expected: the OpenMeet taskbar
  button flashes (request attention) and OpenMeet is **not** brought to the front by itself. Record "flashes: yes" or "no".

**Evidence:** L2 app name and timing, L3 panel and sidebar observations, L5 Settings list, L7 result.
**Failure:** a recording that starts from a prompt, a device chosen without you, or a prompt that cannot be dismissed is a FAIL.

---

## M. Credentials (15 min)

**Goal:** a connection key goes to Windows Credential Manager only, not to the database or logs, and can be removed.
**Preconditions:** A to L done. Use a **synthetic** key only: `QUAL-KEY-000000-NOT-REAL`. The base URL is a loopback address with no server:
`http://127.0.0.1:9/v1`. Nothing is sent to a provider. `--data-dir C:\OpenMeetQual\data-M`.

- [ ] **M1 Save a connection** (3 min). Settings > **Connections**: enter the base URL, the synthetic key in **API key**, and click
  **Save connection**. Expected: the status line reads "API key saved in the OS keychain".
- [ ] **M2 Windows Credential Manager** (3 min). Open Control Panel > User Accounts > Credential Manager > Windows Credentials. Expected: an entry
  whose name contains **OpenMeetPy**. Record the exact entry name. Do **not** click "Show" on the password.
- [ ] **M3 Not in the database or logs** (3 min). Run each of these; each must print `False`:

  ```
  Select-String -Path "C:\OpenMeetQual\data-M\meetings.db" -SimpleMatch "QUAL-KEY-000000-NOT-REAL" -Quiet
  Get-ChildItem "C:\OpenMeetQual\data-M" -Recurse -Include *.log,*.txt,*.json -ErrorAction SilentlyContinue | Select-String -SimpleMatch "QUAL-KEY-000000-NOT-REAL" -Quiet
  ```

  Expected: `False` for both. Record the results.
- [ ] **M4 Remove the key** (3 min). Click **Remove key**. Expected: "No API key saved". The Credential Manager entry is gone (refresh the list). Record both.

**Evidence:** the entry name (M2), the two `False` results (M3), M4 status.
**Failure:** the synthetic key found in any of the checked places, or a key still in Credential Manager after **Remove key**, is a FAIL.

---

## N. Data safety (25 min)

**Goal:** deleting audio or a meeting touches only that meeting's files, exports never overwrite, and the Rust app's data is not touched.
**Preconditions:** A to M done. `--data-dir C:\OpenMeetQual\data-N`.

- [ ] **N1 Delete audio** (6 min). Create `QUAL-N1` with a 30-second tone recording (Stop when done). Place a decoy file outside its
  folder: `C:\OpenMeetQual\data-N\audio\not-mine.txt`, and another meeting's folder
  `C:\OpenMeetQual\data-N\audio\00000000-0000-4000-8000-000000000001\other.txt`. Open `QUAL-N1` > **•••** > **Delete audio…**,
  type `QUAL-N1` in the confirmation, and confirm. Expected: the meeting's audio folder is gone (its WAV and timing files are
  removed, and by design any other regular file inside that folder is removed too); the note, transcript and summary remain;
  both decoys still exist.
- [ ] **N2 Export is non-overwriting** (6 min). Create a note in `QUAL-N2`, click **Export Markdown** and choose `C:\OpenMeetQual\export`.
  Expected: an exported file. Edit that file in Notepad (add a line "external edit"), save it. Click **Export Markdown** again.
  Expected notice: "Existing file preserved; created a new snapshot: ...". Record `Get-FileHash` of the first file before and after: unchanged.
- [ ] **N3 Delete meeting** (5 min). Open `QUAL-N2` > **•••** > **Delete meeting…**, type the title, confirm. Expected: the meeting is gone,
  its audio folder is gone, and the exported snapshots in `C:\OpenMeetQual\export` are untouched (notice "Exported Markdown snapshots were not touched").
- [ ] **N4 Rust profile untouched** (4 min). Before the first run of this checklist, list `dir "$env:APPDATA\dev.openmeet*" -Recurse`
  (if nothing exists, record "none"). Compare the list now. Expected: identical names and last-write times.
- [ ] **N5 Default data folder untouched** (4 min). Record the last-write time of `%APPDATA%\OpenMeetPy\meetings.db` if it exists. Expected: unchanged after
  every run in this checklist (every run used `--data-dir`). If it did not exist, expected: still does not exist.

**Evidence:** N1 folder listing before and after, N2 hashes, N3 notice, N4 and N5 listings.
**Failure:** any decoy removed, any exported snapshot changed, or a change to a Rust or default-profile folder is a FAIL. Keep everything and stop.

---

## O. Cleanup and sign-off (20 min)

**Goal:** the owner removes test data, records the outcome, and decides which labels can change.

- [ ] **O1 Stop everything.** Stop any recording; Save and quit the app; `Get-Process OpenMeet-py -ErrorAction SilentlyContinue` prints nothing.
- [ ] **O2 Restore settings.** Restore the sleep setting (F7), Microphone access On (E7), and any Windows audio or power setting you changed.
- [ ] **O3 Remove the synthetic credential.** If the **Remove key** step did not already do so, delete the entry from Credential Manager
  (only the entry named in M2 for the synthetic key).
- [ ] **O4 Results.** Complete `C:\OpenMeetQual\results\results.md` with every step ID in this checklist. Every BLOCKED or FAIL is listed.
  Keep the evidence folder until the sign-off below is complete.
- [ ] **O5 Delete test data.** Only after the results are copied: delete `C:\OpenMeetQual\audio`, the `C:\OpenMeetQual\data-*` folders and the export
  folder. **Do not delete `%APPDATA%\OpenMeetPy`**: that is your real data unless you decide otherwise. Recovered copies go with their meeting folders.
- [ ] **O6 Sign-off** (see the block below). Fill it in only when every section is PASS, or list each non-PASS result.

### Sign-off

```
Owner:
Date:
PC (model, Windows build from winver):
Exe SHA-256 (Get-FileHash py\dist\OpenMeet-py.exe):
Commit (git rev-parse --short HEAD):
Results file (path, not contents):

Section results (PASS / FAIL / BLOCKED per section):
A  B  C  D  E  F  G  H  I  J  K  L  M  N  O

Steps not PASS (IDs only):

Owner decision:
  [ ] All sections PASS. The "unqualified" labels may be changed as listed below.
  [ ] Not all sections PASS. The labels stay. Nothing is claimed beyond the sections marked PASS.
```

### Pass rule

**A PASS table is the only basis for removing the "unqualified" labels.** No other evidence (a smoke run, a fake device,
a unit test, a browser check, a verifier PASS on a file you did not record yourself) changes a label. Sections marked BLOCKED keep their labels.

When every section is PASS, update these, and no others:

- `docs/python-port-plan.md`: the status paragraph at the top, the "Phases" entries 3, 4 and 5 (remove "unqualified") and Phase 7's
  status. Record the sign-off date and the results file path there.
- The README and user guide: `docs/user-guide.md` describes the Rust app, so do not change its wording for the Python build. Update the
  "Notes for Python-build users" section of `docs/python-port-plan.md` and `README.md` only if its wording is contradicted by the results.
- The **New recording notice**: `src/widgets/setup-panel/SetupPanel.tsx` shows "Recording is still being tested on more computers. Try a
  short test meeting first." Change it only after all sections pass. Update the same text in any test that asserts it.

After a partial pass, change nothing except the sections you can name as PASS in the plan's "Known gaps" list.

---

## Appendix: what each verifier check means

| Check ID | Meaning | Sections |
| --- | --- | --- |
| `<kind>.header` | RIFF/WAVE readable; format and channels shown | B, C, G |
| `<kind>.finalized` | WAV header closed on stop | B, E, G, H |
| `<kind>.frames` | frames above zero, duration shown | B, F, H |
| `<kind>.silence` | FAIL only when the track is silent (peak below -60 dBFS) | B, C |
| `<kind>.clipping` | samples at full scale above 0.01 % | C |
| `<kind>.timing` | index validates with the app's rules and covers the file | B, D, G, H |
| `<kind>.pauses` / `<kind>.pause_consistency` | pauses with a generation change; active time plus gaps matches span within 50 ms | D, F |
| `<kind>.gaps` | FAIL on a gap without a generation change | F, H |
| `system.tone` | median dominant frequency within 1 % of `--tone-freq` | C, H |
| `system.markers` | count of marker bursts close to duration / spacing | C, H |
| `system.drift` | measured drift over 55+ minutes below 100 ms; shorter runs extrapolated to 60 minutes | H |
| `<kind>.wallclock` | track duration within 100 ms of `--wall-seconds` | H |
| `<kind>.paused_marker` | any onset of `--paused-freq` (FAIL if any) | D |
| `pair.duration` | mic and system durations within 100 ms | B, H |
| `pair.distinct` | FAIL if both tracks hold the same samples | B |

Test data to use in each section:

- Standard tone and markers: `make_test_audio.py --freq 440 --marker-freq 1000 --marker-every 10`
- Paused marker: `--freq 2000 --marker-every 0`
- 60-minute run: `--duration 3600 --marker-every 60`
- Drift control: `--marker-drift-ppm 2000` (expected extrapolated 60-minute drift of about 7200 ms)

Passage for section I (fictional): see section I.
