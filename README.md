# Neuro Roadmap

Neuro Roadmap is an Obsidian Community Plugin that turns ordinary Markdown notes, YAML properties, and Markdown checkbox tasks into an academic roadmap. The vault remains the only source of truth: the plugin does not maintain a separate task database and writes changes back to the originating Markdown.

## Views

- **Dashboard** is the default home view. Subject cards show task completion, done/total counts, the next deadline, overdue count, and a compact timeline.
- **Gantt** shows Subject → optional Project/Workstream → Task hierarchy, collapsible swimlanes, semantic Days/Weeks/Months zoom, a full-height Today Line, and a density-aware overview ribbon.
- **Horizon** organizes actionable work into Now, Next, and Later. Tasks without usable dates remain in the Unscheduled drawer.

The Gantt and Horizon views can check or uncheck real Markdown tasks and open their source note. Dragging updates mapped date properties atomically; fixed downstream deadlines are excluded from automatic dependency propagation.

## Calendar and ICS

Calendar is a one-way projection from the Markdown-backed roadmap. Exams, assignment deadlines, project deadlines, milestones, and presentations are included by default; regular tasks are opt-in. Per-item include/exclude actions are stored in plugin state rather than written as YAML properties.

The Calendar toolbar menu distinguishes **Export current view** from **Export all eligible items**. Exported RFC 5545 files use stable UIDs, all-day deadline events with exclusive end dates, transparent availability, optional type-specific reminders, escaped Unicode text, and source links back to Obsidian.

Inline tasks receive a compact Obsidian block ID only when a calendar operation first needs stable identity. Provider IDs and sync metadata remain in plugin-managed state.

On Obsidian desktop, the optional **Google Calendar** provider can project the same eligible items directly through the Google Calendar API. It uses installed-app OAuth with a loopback redirect and PKCE, writes only managed downstream events, and never imports Google edits into Markdown. Select an existing writable calendar or explicitly create `Neuro Roadmap`; changes synchronize after a three-second debounce, periodic existence verification runs every 15 minutes by default, and **Sync now** fully reasserts Markdown-defined events. Generic ICS remains available without an account and on mobile. See [Google Calendar setup](docs/google-calendar-setup.md).

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

## Roadmap source scope

By default, the plugin indexes tasks from all Markdown files for backward compatibility. **Roadmap source scope** can opt into a stricter mode where a document must match at least one YAML property/value rule before its frontmatter or checkbox tasks enter the shared roadmap dataset. For example, a rule for `typ` with values `predmet, projekt, roadmapa, prednáška` keeps study notes in scope without turning those document types into task nodes.

**Excluded folders / paths** remain a hard exclusion and always take precedence over source rules. This is useful for template folders and system areas that must never be indexed.

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
- template, path, and optional source-scope filtering;
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
