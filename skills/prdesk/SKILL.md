---
name: prdesk
description: Submit a finished change (a git branch or a patch) to the user's local prdesk review desk with plain-language notes, then read the human reviewer's decision and comments and resubmit. Use when a change is meant for an upstream project or needs human sign-off before it is pushed, posted or merged, or when the user says "send it to prdesk", "put it up for review" or asks what the reviewer said.
---

# Review through prdesk

prdesk is a local web app where the user reviews your patch next to your
explanation, then approves or requests changes. The user may never have seen
this codebase, so your notes carry the review. Never push, open a PR or post
upstream yourself; prdesk is the gate.

Check it is installed: `prdesk --version`. If it is not on PATH, ask the user
where prdesk lives and run `node <that folder>/bin/prdesk`.

## 1. Write the notes

Write `notes.md` outside the repository (or leave it untracked). Run `prdesk guide`
once: it prints the notes format with a complete example. The sections are:

- `# Summary`: what the project is, the problem, the fix, who benefits, in
  plain words for someone new to the project.
- `# How the project works (just enough)`: only the background needed to
  judge this change; gloss platform concepts in a paragraph.
- `# Walkthrough`: `## path/to/file` per file; `### @@ <hunk header or
  function name>` or `### lines A-B` per hunk. Explain what and why.
- `# Risks`: honest. If it was not built or run, say so.
- `# What was tested`: what ran and passed, and what was not tested.
- `# Questions for the reviewer`
- `# Upstream rules checked`: the project's CONTRIBUTING/AGENTS rules and how
  the change follows them.
- `# PR description` (optional): the exact text that would be posted upstream.

## 2. Check, then submit

```sh
prdesk check --notes notes.md --repo . --base origin/main --head HEAD
prdesk submit --repo . --base origin/main --head HEAD \
  --title "<one line>" --project "<Project>" --upstream <url> \
  --notes notes.md --id <short-id>
```

Fix warnings from `check` (missing sections, anchors that match nothing)
before submitting. `--base` defaults to the merge-base with `origin/HEAD`.
For a loose patch use `--patch file.patch` instead of `--repo/--base/--head`.

Tell the user the review page URL that `submit` printed. If it says the
server is not running, tell them to run `prdesk serve`.

## 3. Read the decision

```sh
prdesk status <short-id> --json
```

Or block until the user decides: `prdesk wait <short-id> --json --timeout 3600`.

The JSON has `schema: "prdesk.status/v1"`, `status` (`pending`, `approved`,
`changes_requested`), `message`, `checklist`, and `comments`. Line comments
have `file`, `side` (`new` or `old`), `line` and `lineText`; each comment has
the `revision` it was made on. Exit codes: 0 approved, 10 changes requested,
11 pending.

## 4. Resubmit after changes

Address every comment on the current revision, update the commits and the
notes (say what changed and answer the reviewer's points), then:

```sh
prdesk resubmit <short-id> --notes notes.md -m "<what changed in one line>"
```

Options left out are taken from the previous revision (same repo, base and
head refs). The reviewer sees exactly what changed since the revision they
last opened. Repeat until approved. After approval, act upstream only with
the user's explicit go-ahead.
