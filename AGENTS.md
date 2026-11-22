# prudent snippet for your agent instructions

Paste the block below into your project's `AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, `CONVENTIONS.md` or whatever file your coding agent reads.
Adjust the base branch and project name. Claude Code users can install the
skill in [`skills/prudent`](skills/prudent/SKILL.md) instead.

---

```markdown
## Review through prudent

Changes meant for upstream are reviewed by a human in prudent before anything
is pushed or posted. Do not push, open a PR or post comments yourself.

1. Commit the change on a branch. Write `notes.md` (outside the repository or
   untracked) following the format `prudent guide` prints: Summary, How the project
   works (just enough), Walkthrough (anchored per file and hunk), Risks, What
   was tested (and what was not), Questions for the reviewer, Upstream rules
   checked, and optionally PR description.
2. Check the notes against the diff, fix every warning that matters:
       prudent check --notes notes.md --repo . --base origin/main --head HEAD
3. Submit, with a short stable id:
       prudent submit --repo . --base origin/main --head HEAD \
         --title "<one line>" --project "<Project>" --upstream <url> \
         --notes notes.md --id <short-id>
4. Tell the user the review page URL that `submit` printed, then wait:
       prudent wait <short-id> --json     # or poll: prudent status <short-id> --json
5. Read `status`, `message` and `comments` (line comments carry `file`,
   `line` and `lineText`). If `status` is `changes_requested`, address every
   comment, update notes.md, and resubmit:
       prudent resubmit <short-id> --notes notes.md -m "what changed"
   Then wait again. Only act upstream after `status` is `approved`, and only
   with the user's go-ahead.
```

## Other agents (Codex, Cursor, Aider, Continue, …)

prudent is a plain CLI, so any agent that can run shell commands can use it.
The whole loop is five commands:

```sh
prudent check    --notes notes.md --repo . --base origin/main --head HEAD
prudent submit   --repo . --base origin/main --head HEAD --title "..." --notes notes.md --id my-change
prudent status   my-change --json    # exit code: 0 approved, 10 changes requested, 11 pending
prudent wait     my-change --json    # blocks until a decision (add --timeout <seconds>)
prudent resubmit my-change --notes notes.md -m "what changed"
```

No repository? `prudent submit --patch change.patch --notes notes.md --title "..."`
takes the output of `git diff` or `git format-patch`.
