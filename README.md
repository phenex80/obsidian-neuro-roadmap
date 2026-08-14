# Neuro Roadmap

Neuro Roadmap is an Obsidian Community Plugin that turns ordinary Markdown notes, YAML properties, and Markdown checkbox tasks into an academic roadmap. The vault remains the only source of truth: the plugin does not maintain a separate task database and writes changes back to the originating Markdown.

## Views

- **Dashboard** is the default home view. Subject cards show task completion, done/total counts, the next deadline, overdue count, and a compact timeline.
- **Gantt** shows Subject → optional Project/Workstream → Task hierarchy, collapsible swimlanes, semantic Days/Weeks/Months zoom, a full-height Today Line, and a density-aware overview ribbon.
- **Horizon** organizes actionable work into Now, Next, and Later. Tasks without usable dates remain in the Unscheduled drawer.

The Gantt and Horizon views can check or uncheck real Markdown tasks and open their source note. Dragging updates mapped date properties atomically; fixed downstream deadlines are excluded from automatic dependency propagation.

## Markdown data

Both unchecked and completed tasks are indexed:

```markdown
- [ ] Draft the essay [start:: 2026-09-10] [due:: 2026-09-14]
- [x] Submit the topic proposal
```

Inline tasks inherit `subject`, `semester`, and optional `project/workstream` values from their parent note. A roadmap anchor is valid content, not a template:

```yaml
---
typ: roadmapa
predmet: ISKB02
semester: 1. semester
---
```

Real templates can be excluded through mapped Type values such as `template` or `šablóna`.

## Semantic property mapping

Settings → Neuro Roadmap → **Property mapping** accepts multiple YAML keys for every canonical field. Defaults cover common English and Slovak conventions, including:

- `predmet`, `subject`, `course`, `module`
- `due_date`, `due`, `deadline`, `termin`, `odovzdanie`
- `project`, `projekt`, `workstream`
- `status`, `stav`

Status, priority, and node-type values have independent alias mappings. Existing aliases are preserved when dates are written. The optional **Detect existing properties** action reads cached YAML metadata and presents suggestions for confirmation; it never rewrites notes.

## Settings

The plugin includes ready-to-use defaults for:

- semantic property and value mappings;
- template exclusion;
- duration buffer and priority;
- Horizon Next/critical windows and overdue preview limit;
- color coding plus configurable Todo, In Progress, Done, Overdue, and priority colors.

Color coding can be disabled. Important states also use text, borders, shapes, and tooltips so they remain understandable without color.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

The production build generates the three Obsidian plugin assets in the repository root: `main.js`, `manifest.json`, and `styles.css`.
