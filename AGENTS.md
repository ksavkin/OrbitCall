# Rules for coding agents in OrbitCall

## Commits and pushes go through Cursor

- Make every commit and push with Cursor: the `cursor-agent` CLI or the Cursor app. Other agents (Claude Code and others) write and test the code, then hand the commit to Cursor. Example:

  ```bash
  cursor-agent -p --force "Stage web/src/components/ops/IncidentView.tsx and commit it with the message 'Add the incident command view'. Then push the current branch to origin."
  ```

- Split work into small commits, one logical change each: a component, a fix, a style pass, a doc. Never bundle a whole session into one commit. When several changes are pending, stage and commit them group by group.
- Commit messages are imperative and say what changed ("Add plan rows to the decision view"), not "update" or "wip".
- Record tool use honestly. A commit made through Cursor shows that Cursor made the commit. Do not describe Cursor as the author of code another agent or a person wrote, and do not rewrite existing history for prize eligibility (see `docs/master-roadmap.md`, "Record real usage accurately").

## Branches

- Adil works on `adil`. Commit and push there, then merge `adil` into `main` and push `main`, so the UI on `main` stays current (Adil's rule since Oct 24). Fetch first. If `main` has new commits, merge `main` into `adil`, run `npx tsc --noEmit` and `npx eslint src` in `web/`, and only then merge back.
- Before committing, check `git branch --show-current` and `git status`. Other sessions may work in this repo at the same time: never reset, rebase or force-push without asking.

## Where things are

- `web/`: the Next.js frontend. Next.js version notes: `web/AGENTS.md`.
- `docs/adil/`: frontend progress and the UI design system. Read the design system before any UI change.
- `docs/user-flow.md`, `docs/specification.md`, `docs/functionality.md`: product rules and the data contract.
- `convex/`, `scripts/`, `tests/`: the backend (Kostya, Andrew).
