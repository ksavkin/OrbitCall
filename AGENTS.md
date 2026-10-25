# Rules for coding agents in OrbitCall

## Commits

- Split work into small commits, one logical change each: a component, a fix, a style pass, a doc. When several changes are pending, stage and commit them group by group.
- Commit messages are imperative and say what changed ("Add plan rows to the decision view"), not "update" or "wip".
- Never rewrite published history. Record tool use honestly.

## Branches

- Adil works on `adil`. Commit and push there, then merge `adil` into `main` and push `main`, so the UI on `main` stays current. Fetch first. If `main` has new commits, merge `main` into `adil`, run `npx tsc --noEmit` and `npx eslint src` in `web/`, and only then merge back.
- Before committing, check `git branch --show-current` and `git status`. Other sessions may work in this repo at the same time: never reset, rebase or force-push without asking.

## Where things are

- `web/`: the Next.js frontend. Next.js version notes: `web/AGENTS.md`.
- `docs/adil/`: frontend progress and the UI design system. Read the design system before any UI change.
- `docs/user-flow.md`, `docs/specification.md`, `docs/functionality.md`: product rules and the data contract.
- `convex/`, `scripts/`, `tests/`: the backend (Kostya, Andrew).
