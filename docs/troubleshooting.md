# Troubleshooting

## A task is missing

Check that the file is Markdown, not under an excluded path, and not classified by the template guard. In Rules source scope, it must match at least one configured rule. Check [property mapping](configuration.md#property-mapping) when using custom YAML names.

## A task is Unscheduled

Add a usable mapped start or due date, or plan it by dragging it onto Gantt. Invalid date text is intentionally not treated as a scheduled date.

## Google Calendar is unavailable

Direct Google connection works only on desktop. Confirm client ID and client secret settings, complete the browser flow, choose a writable calendar, and use Sync now. ICS export works independently of Google.

## Need more help

Include reproducible steps, Obsidian version, platform, and non-sensitive console errors in an issue. Never include vault content, OAuth codes, refresh tokens, client secrets, or access tokens.
