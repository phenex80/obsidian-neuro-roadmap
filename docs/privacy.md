# Privacy

Neuro Roadmap is designed around a Markdown-first model: your vault remains the source of truth. The plugin does not operate a cloud service, collect telemetry, or maintain a separate online task database.

## Local data

The plugin reads Markdown, cached metadata, YAML properties, and Markdown checkbox tasks in the vault that you open in Obsidian. It stores its own settings, stable calendar IDs, and calendar mapping state in Obsidian's plugin data file. It does not upload vault content, task titles, file paths, or planning metadata to a Neuro Roadmap backend, for analytics, advertising, or donation processing.

When enabled, roadmap actions can update the original Markdown file that you explicitly edit or reschedule. The plugin uses Obsidian's normal vault APIs for those writes.

## Calendar integrations

ICS export is generated locally in your Obsidian session and downloaded only after you request it.

Google Calendar sync is optional and desktop-only. After you explicitly configure and connect Google Calendar, the plugin sends only the calendar projection needed to create, update, verify, or delete managed Google events described in the [Google Calendar setup guide](google-calendar-setup.md): title, scheduled date/range, description with source context, reminder policy, and the stable item identity needed to manage the event. Google OAuth refresh tokens are held in Obsidian SecretStorage; access tokens and OAuth codes stay in memory. The plugin does not import Google Calendar edits into Markdown.

No Google network request is made until you explicitly connect or use an enabled Google synchronization feature. The implementation does not include telemetry. Google handling is also subject to Google's own privacy terms.

## Voluntary support links

Revolut and Ko-fi links are **user-initiated external links**. Neuro Roadmap does not contact Revolut or Ko-fi until you select one of the support buttons. It does not send either service vault data, task data, or plugin settings; use either service's API; use funding analytics; or know whether you contributed.

Contributions are voluntary. They do not unlock features, change plugin behavior, or create a donor profile in the plugin.

## Contact

For a privacy or security question, open an issue at [github.com/phenex80/obsidian-neuro-roadmap](https://github.com/phenex80/obsidian-neuro-roadmap/issues).
