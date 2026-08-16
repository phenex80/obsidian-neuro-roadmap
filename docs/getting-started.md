# Getting started

Neuro Roadmap is currently available to testers through [BRAT](beta-testing.md). After enabling it, open **Neuro Roadmap** from the ribbon or command palette.

## Five-minute workflow

1. Create or open a normal Markdown note for a subject.
2. Give it a mapped subject property, such as `predmet: ISKB02`, `subject: ISKB02`, or `course: ISKB02`.
3. Add a task: `- [ ] Read chapter one`.
4. Add dates when known: `- [ ] Submit outline [start:: 2026-09-10] [due:: 2026-09-14]`.
5. Start on Dashboard, inspect timing in Gantt, and choose the next action in Horizon.

Tasks without usable dates remain in **Unscheduled** until you plan them. A note with `typ: roadmapa` is a valid roadmap anchor, not automatically a template.

Existing vaults usually need no Markdown migration. Adjust [property mapping](configuration.md#property-mapping) if your YAML uses different names.
