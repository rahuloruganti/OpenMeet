# Claude Code guide

Read `AGENTS.md` first; its rules apply to all work here.

## Delegation

- Delegate implementation work (writing code, wiring modules, running `just check` and fixing the fallout) to Haiku subagents: `Agent` with `model: "haiku"`.
- The main model does not redo that work. It verifies it: read the diff, run the checks listed in `AGENTS.md`, and confirm claims against code and test output before reporting or committing.
- Give each subagent a complete brief: files and area, what done looks like, and the AGENTS.md limits (no recordings, no model downloads, no commits).
- Only the main model commits and pushes to `main`, after verification.
