# Beta testing with BRAT

[BRAT](https://tfthacker.com/BRAT) can install Neuro Roadmap directly from its GitHub repository before Community Plugin publication.

## Tester steps

1. Install and enable the BRAT community plugin.
2. In BRAT, choose **Add Beta Plugin**.
3. Enter `https://github.com/phenex80/obsidian-neuro-roadmap` and select the intended branch when BRAT asks.
4. Enable **Neuro Roadmap** in Obsidian's Community plugins settings.
5. For the Google Calendar option, use a test OAuth client and test calendar. The feature is desktop-only; Dashboard, Gantt, Horizon, and ICS export remain available on mobile.

BRAT installs built repository assets, so maintainers must push a commit containing an up-to-date `main.js`, `manifest.json`, and `styles.css` before inviting testers. Do not use production vault data for early sync testing.

## Feedback to collect

- enable/disable and cold-start behavior;
- Dashboard, Gantt, Horizon, and narrow-pane/mobile layout behavior;
- Markdown checkbox, drag scheduling, and calendar identity writes;
- ICS export;
- Google connection, calendar selection, sync, disconnect, and error recovery, where a test account is available.

Report reproducible steps, Obsidian version, platform, and non-sensitive console errors. Never include OAuth codes, refresh tokens, client secrets, or private vault content in an issue.
