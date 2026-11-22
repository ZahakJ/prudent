# Changelog

All notable changes to prudent are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-22

- Renamed from prdesk to prudent: the command, `PRUDENT_HOME`, the data folder
  (`~/.local/share/prudent`), the skill and the status schema (`prudent.status/v1`).

## [0.1.0] - 2026-11-22

First release.

- `prudent submit` captures a branch (`--repo`, `--base`, `--head`, diffed from
  the merge-base like a pull request) or a loose patch (`--patch`), its commit
  messages and a notes file.
- `prudent resubmit` adds revisions; the review page shows what changed since
  the revision the reviewer last opened.
- `prudent status` and `prudent wait` print the decision and comments as text
  or as the `prudent.status/v1` JSON object, with meaningful exit codes.
- `prudent check` lints notes against a diff; `prudent list`; `prudent demo`.
- Review page: Overview from the notes, Changes with walkthrough notes inline
  above files, hunks and lines, line and general comments, checklist,
  approve or request changes, Commits, PR description with copy, Revisions.
- Keyboard shortcuts, dark theme, works from laptop screens to 1080p and up.
- Localhost only, per-run token on every write, Host and Origin checks, a
  strict Content Security Policy, and escaping of all patch and notes content.
- No dependencies; Node.js 20 or newer.

[0.1.1]: https://github.com/ZahakJ/prudent/releases/tag/v0.1.1
[0.1.0]: https://github.com/ZahakJ/prudent/releases/tag/v0.1.0
