# OpenMeet 0.9.1

Fixes duplicate calendar controls when switching meetings and keeps event details in a compact dropdown.

## What changed since 0.9.0

- One calendar control after repeated meeting navigation. Stale event responses no longer appear in another meeting.
- Event choices, linked details, earlier meetings and Unlink stay in a dropdown without growing the meeting header.
- Long event titles stay compact in the header and readable in the dropdown. Open it by keyboard; Escape closes it and restores focus without navigating away.
- Earlier UI polish includes clearer contrast, wrapping task titles, quieter empty dates and one Continue button in setup, plus further setup, palette and recording-control fixes.
- Apple silicon macOS source support and follow-up fixes are included, but the port is unit-tested with fakes only and remains unqualified on a Mac.

## Before you install

- **Not tested on real hardware.** Audio capture, local transcription, shortcuts, meeting detection and credential storage have only run with fakes and stubs. The macOS port has not run on a Mac. Do not rely on it for a meeting you cannot repeat.
- **Unsigned.** SmartScreen will warn. Click **More info**, then **Run anyway**.
- **No updater.** To update, close the app and replace the `.exe`. Your data stays in `%APPDATA%\OpenMeetPy`.
- **Unencrypted data.** Files are plain on disk. There is no telemetry. API keys live in Windows Credential Manager.
- You are responsible for recording-consent laws that apply to your meetings.

## Download

This release includes only the Windows `OpenMeet.exe`, attached to GitHub release [`v0.9.1`](https://github.com/rahuloruganti/OpenMeet/releases/tag/v0.9.1).

The older [0.9.0 Mac preview](https://github.com/rahuloruganti/OpenMeet/releases/download/v0.9.0/OpenMeet-0.9.0-arm64.dmg) is not updated by this release. No 0.9.1 Mac binary is included; macOS 0.9.1 can be built from source.

SHA256: `9726af5f411a3cb9221257c00c573a60000c814a219bb58bc045402498c0ac22`

Check it in PowerShell with `Get-FileHash .\OpenMeet.exe`.
