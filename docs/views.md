# Views

## Dashboard

Dashboard is the home view. Each subject card shows Task completion, done/total count, next relevant deadline, overdue count, and a small roadmap timeline.

## Gantt

Gantt answers how work is distributed over time. It groups rows as Subject → optional Project/Workstream → tasks and milestones. Subjects and workstreams can be collapsed.

**Fit** is the default scale. **Weeks**, **Months**, and **Semester** provide wider semantic zoom levels. The full-height Today Line and overview ribbon retain time orientation; the ribbon aggregates dense items rather than rendering unreadable labels. Status colors describe Todo, In Progress, and Done when color coding is enabled. High and Low priority retain ▲ and ▼ markers, so they are not color-only signals.

Drag scheduled tasks to reschedule at day precision. The source Markdown is updated through the normal safe write path. Fixed/hard dates are not automatically moved by dependency propagation.

## Horizon

Horizon answers what to work on now:

- **Now**: incomplete in-progress tasks (regardless of date), incomplete tasks whose start date is today or earlier, tasks due today, and tasks with a due date inside the configured critical horizon. With the default critical horizon of `0`, that last rule is also today-only.
- **Next**: remaining scheduled tasks whose effective date is after today and no later than the configured Next window (7 days by default).
- **Later**: remaining scheduled tasks beyond the Next window.
- **Unscheduled**: actionable tasks with neither a usable due date nor a usable start date.

Completed tasks are excluded from all active Horizon buckets. Overdue means a usable due date before today and an incomplete task; these items are shown in the Now column's separate overdue group, with a five-item preview by default and **Show all** for the remainder. In-progress tasks are prioritized into normal Now before the overdue split. For dated tasks, due date is preferred over start date as the effective date; a start date on or before today still promotes a task to Now. Bucket sorting is deterministic: urgency date first, then priority (High, Medium, Low), title, and stable ID; unscheduled tasks use priority, title, and stable ID.

Overdue work does not silently receive a new deadline. Horizon windows are inclusive at their stated end boundaries, and all values can be adjusted in Settings.
