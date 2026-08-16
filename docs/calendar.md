# Calendar

Calendar is a one-way projection: Markdown remains authoritative. Google Calendar edits are not imported into the vault.

## Eligibility and overrides

Hard academic dates—exams, assignment/project deadlines, milestones, and presentations—are included by default when they have a usable commitment date. Regular tasks are opt-in. Per-item include/exclude controls are persisted in plugin state and do not add arbitrary YAML properties.

## ICS

**Export current view** and **Export all eligible items** create a local RFC 5545 file. Date-only commitments are all-day events with an exclusive following-day end and transparent/free availability. ICS needs no account and remains available on mobile.

## Google Calendar

Google sync is optional and desktop-only. It uses a browser-based loopback OAuth flow with PKCE and state validation, then projects managed events to a selected writable calendar. Normal changes debounce for three seconds; periodic verification is 15 minutes by default; **Sync now** reasserts the full Markdown projection.

Reminders use the configured type policy. If a managed event is deleted externally, verification or Sync now recreates it. Disconnect first requests token revocation; on success it removes the local refresh token while leaving managed events and mappings intact for safe reconnect. See [Google Calendar setup](google-calendar-setup.md).
