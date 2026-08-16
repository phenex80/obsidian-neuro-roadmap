# Tasks and metadata

Neuro Roadmap reads normal Markdown and leaves the vault authoritative.

## Checkbox tasks

```markdown
- [ ] Prepare the presentation [start:: 2026-09-10] [due:: 2026-09-14]
- [x] Submit the topic proposal
```

Unchecked tasks are active. Checked tasks stay in the dataset as `done`, so Dashboard can calculate Task completion. The plugin can check or uncheck an indexed Markdown task from Gantt or Horizon and updates the original checkbox atomically.

## Supported meanings

Mapped YAML and inline task metadata can provide `title`, `start`, `due`/`deadline`, `status`, `priority`, `type`, and `milestone`. The configured mappings translate your property names into these internal meanings; they do not force new YAML names.

Tasks inherit `subject`, `semester`, and optional `project`/`workstream` from the parent note. A task's calendar identity is stable when calendar features need it; users do not need to add technical IDs during normal task creation.

## Editing

Live Preview displays compact task metadata alongside supported tasks. The information control opens **Task Properties** for supported actions. In Source mode, the original Markdown remains visible and editable.
