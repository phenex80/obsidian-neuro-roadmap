# Configuration

Open **Settings → Neuro Roadmap** to adapt the plugin to an existing vault.

## Property mapping

Each canonical meaning accepts comma-separated YAML keys. Defaults cover common conventions such as:

- Subject: `predmet, subject, course, module`
- Due date: `due_date, due, deadline, termin, odovzdanie`
- Project: `project, projekt, workstream`
- Status: `status, stav`

Value aliases normalize common English, Slovak, and Czech values for status, priority, and type. Existing Markdown is not rewritten merely because it uses another schema. **Detect existing properties** inspects cached metadata and offers suggestions for confirmation.

## Source scope and templates

Use **Excluded folders / paths** for hard exclusions. **Roadmap source scope** can index every Markdown file (the compatible default) or only notes matching configured property/value rules. The template guard ignores mapped values that truly identify templates; `roadmapa` remains a valid roadmap-note value.

## Planning and appearance

Configure duration buffer, default priority, Horizon Next and critical windows, overdue preview limit, semantic colors, and the persisted Gantt scale. Color coding is optional; text, borders, markers, and tooltips retain important non-color cues.

## Calendar

Calendar settings control automatic inclusion policy, per-type reminders, manual overrides, and optional Google connection. See [Calendar](calendar.md).
