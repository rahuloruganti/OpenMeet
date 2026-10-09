# Ponytail skills-only installation

- Source: https://github.com/DietrichGebert/ponytail
- Commit: `9cc65d03aa2da1db7121b912d03596409ee340b8`
- Upstream package version: 5.1.0
- Scope: this project's Pi skills directory; six unchanged `SKILL.md` files.
- License: MIT; see `LICENSE`.

Run `/reload` in Pi, then invoke `/skill:ponytail`, `/skill:ponytail-review`, `/skill:ponytail-audit`, `/skill:ponytail-debt`, `/skill:ponytail-gain`, or `/skill:ponytail-help`.

This installs skills only, not the upstream Pi extension, lifecycle hooks, or always-on rules. Upstream help's plugin mode settings, automatic activation, and update commands do not apply to this skills-only install. Use Pi's `/skill:` command prefix. Updates require replacing these files from a reviewed upstream revision.

The gain skill quotes upstream benchmark claims, not measured savings in this project. Its cited README and benchmark report are in the upstream repository at the commit above.

To uninstall, remove `.pi/skills/ponytail-bundle/` and run `/reload`.
