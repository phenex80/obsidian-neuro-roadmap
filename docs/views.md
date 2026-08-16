# Views

## Dashboard

Dashboard is the home view. Each subject card shows Task completion, done/total count, next relevant deadline, overdue count, and a small roadmap timeline.

## Gantt

Gantt answers how work is distributed over time. It groups rows as Subject → optional Project/Workstream → tasks and milestones. Subjects and workstreams can be collapsed.

**Fit** is the default scale. **Weeks**, **Months**, and **Semester** provide wider semantic zoom levels. The full-height Today Line and overview ribbon retain time orientation; the ribbon aggregates dense items rather than rendering unreadable labels. Status colors describe Todo, In Progress, and Done when color coding is enabled. High and Low priority retain ▲ and ▼ markers, so they are not color-only signals.

Drag scheduled tasks to reschedule at day precision. The source Markdown is updated through the normal safe write path. Fixed/hard dates are not automatically moved by dependency propagation.

## Horizon

Horizon answers what to work on now:

- **Now**: incomplete overdue work, work due today, in-progress work, and critical-horizon tasks.
- **Next**: dated upcoming work within the configured window.
- **Later**: dated work outside that window.
- **Unscheduled**: tasks with no usable start or due date.

Overdue work does not silently receive a new deadline. When there are many overdue tasks, the view presents a deterministic preview and a way to show all.
