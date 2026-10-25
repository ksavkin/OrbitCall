# docs/adil

Source of truth: [master roadmap v1.1](../master-roadmap.md). It defines the four-screen demo, 2-4 operator rooms, EN/RU/ZH voice, sponsor roles, and DigitalOcean deployment. Claude runs analysis/advocates, Gemini runs the Coordination Host, and Grok runs independent checking and selected audio tasks. Existing implementation notes below are not completion claims.


Frontend notes from Adil (UI owner). Start here if you work on `web/`.

- [../user-flow.md](../user-flow.md): latest accepted fleet dashboard, scan scope, priority, approval paths and acceptance scenarios.
- [design-system.md](design-system.md): shared UI conventions, component patterns, mode boundaries and visual QA.
- [progress.md](progress.md): what is built, what was checked in the browser, what is still a placeholder, what comes next.
- [../specification.md](../specification.md): the backend target contract. The current `web/src/lib/ops/types.ts` is a simulator view model and needs a typed adapter plus documented field additions.

Update `progress.md` when a screen changes state.
