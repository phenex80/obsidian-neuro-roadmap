# Neuro Roadmap

Neuro Roadmap turns ordinary Markdown notes, YAML properties, and checkbox tasks into an academic planning layer for Obsidian. Dashboard, Gantt, and Horizon read the vault directly; Markdown remains the source of truth.

It is designed with executive-function and attention-related planning challenges in mind. It is a planning tool, not a clinical or medical product.

## Why Neuro Roadmap

Keep your notes, tasks, dates, and plans in normal Markdown while gaining a shared overview of subjects, workstreams, deadlines, and unscheduled work. Existing vaults can usually be used without migration through semantic property mappings.

## Features

- Markdown-first indexing of YAML and checkbox tasks, including completed tasks.
- Dashboard for task completion, deadlines, overdue work, and mini timelines.
- Hierarchical Gantt with overview ribbon, Today Line, collapsible lanes, and drag rescheduling.
- Horizon for Now, Next, Later, and Unscheduled planning.
- Optional one-way calendar projection through ICS or desktop Google Calendar sync.

## Quick start

1. Enable Neuro Roadmap, then open it from the ribbon or command palette.
2. Add a subject property to a note, for example `predmet: ISKB02` or `course: ISKB02`.
3. Add a normal Markdown task: `- [ ] Prepare reading [due:: 2026-09-14]`.
4. Use Dashboard for the overview, Gantt for time, and Horizon for the next action.

Until Community Plugin publication, beta testers can install the repository through [BRAT](docs/beta-testing.md). Community installation will be available only after a published release.

## Views

### Dashboard

The default home view summarizes each subject with **Task completion**, done/total counts, next deadline, overdue count, and a compact timeline.

### Gantt

Gantt presents Subject → optional Project/Workstream → Task hierarchy. It has Fit, Weeks, Months, and Semester scales, a Today Line, overview ribbon, status colors, High/Low priority markers, collapse controls, and day-precision drag/rescheduling.

### Horizon

Horizon prioritizes incomplete work in Now, Next, and Later; tasks without a usable date remain in Unscheduled. Overdue and in-progress work remains visible in Now.

## Tasks and Markdown

The plugin indexes both unchecked and completed checkbox tasks. Tasks can inherit subject and project/workstream metadata from their note. In Live Preview, compact metadata and a Task Properties popover offer quick actions; Source mode keeps the raw Markdown visible and editable.

See [tasks and metadata](docs/tasks-and-metadata.md) for supported fields and [configuration](docs/configuration.md) for multilingual property mappings.

## Calendar integration

Calendar is a one-way projection from Markdown: Markdown stays authoritative. Eligible hard dates are included by default; regular tasks are opt-in. Export ICS locally on any supported platform, or optionally connect Google Calendar on desktop after configuring a Google OAuth client. Google edits are never imported into Markdown.

See [calendar](docs/calendar.md) and [Google Calendar setup](docs/google-calendar-setup.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Tasks and metadata](docs/tasks-and-metadata.md)
- [Views](docs/views.md)
- [Configuration](docs/configuration.md)
- [Calendar](docs/calendar.md)
- [Privacy](docs/privacy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)

## Privacy and external services

Roadmap processing is local to the vault. ICS export is local. Google Calendar is an optional, explicit desktop connection. Revolut and Ko-fi are explicit external links only; no donor tracking or funding-service API is used. Details: [privacy](docs/privacy.md).

## Project status and support

Neuro Roadmap began as a personal hobby project to solve problems I encountered in my own academic planning. I decided to share it publicly so that anyone who finds the approach useful can use it as well.

Feedback, bug reports, suggestions, and financial support are very welcome. The project is maintained in my spare time, so feedback or donations do not imply a commitment to provide support, implement requested features, or resolve issues within a particular timeframe. I will continue developing the project as my time and its priorities allow.

Voluntary contributions do not unlock features or change plugin behavior.

- [Support via Revolut](https://checkout.revolut.com/pay/ae52e66f-c30d-46fc-b7f0-7df89097b3e0)
- [Support on Ko-fi](https://ko-fi.com/J6C5255736)

## License

Neuro Roadmap is source-available software under the [PolyForm Noncommercial License 1.0.0](LICENSE). The public license permits uses allowed by that license; commercial or business use is not permitted by the public license. Separate commercial licensing may be available from the copyright holder. The [LICENSE](LICENSE) file is authoritative; this summary is not legal advice. Required notices are in [NOTICE](NOTICE).

## Development

```bash
npm ci
npm test
npm run check
npm run build
```

See [development notes](docs/development.md), [contributing](CONTRIBUTING.md), and the [manual release checklist](docs/release-checklist.md).

## Author

Neuro Roadmap is developed by Matteo Rossi ([@phenex80](https://github.com/phenex80)).
