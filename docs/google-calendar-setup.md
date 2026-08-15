# Google Calendar one-way sync

Neuro Roadmap treats Markdown as the only source of truth. Google Calendar is a downstream projection: edits made directly to managed Google events are not imported into Markdown and may be overwritten by a later reconciliation.

Direct sync is available in the Obsidian desktop app. Mobile users retain the complete roadmap and generic ICS export, but the official desktop loopback OAuth flow cannot run in Obsidian mobile.

## Google Cloud project and OAuth client

The project owner must configure Google Cloud before users can connect:

1. Open the [Google Cloud console](https://console.cloud.google.com/) and select or create a project for Neuro Roadmap.
2. Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. Configure the OAuth consent screen, support email, audience, and test users as appropriate for the project. A public application requesting Calendar user data may require [Google OAuth verification](https://developers.google.com/workspace/calendar/api/auth).
4. Open **Google Auth Platform → Clients**, create an OAuth client, and choose **Desktop app**. The desktop client type permits a loopback redirect on a random `127.0.0.1` port; no fixed callback port is entered in plugin settings.
5. Copy the OAuth **client ID** and **client secret** into **Settings → Neuro Roadmap → Google Calendar**.
6. The client secret is the value from the Google Cloud Desktop OAuth client credentials. It is not a Google password or user refresh token. A native-app client secret is not a security boundary, but it is sent only to Google's token endpoint and must not be logged or committed.

The runtime requests these scopes together because installed applications do not support incremental authorization:

- `openid`, `profile`, and `email` identify the connected account;
- `https://www.googleapis.com/auth/calendar.events` creates, updates, verifies, and deletes managed events in writable calendars;
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly` lists calendars the account can use;
- `https://www.googleapis.com/auth/calendar.calendars` creates the optional secondary `Neuro Roadmap` calendar.

These are separate, purpose-focused scopes rather than the broad `https://www.googleapis.com/auth/calendar` scope. Google documents the current scope meanings in [Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).

## OAuth model

The plugin implements Google’s current [OAuth 2.0 flow for desktop installed applications](https://developers.google.com/identity/protocols/oauth2/native-app):

- authorization opens in the system browser, never an embedded credential form;
- a temporary HTTP listener binds only to `127.0.0.1` on a random port;
- every attempt uses a fresh high-entropy state value and PKCE verifier with an `S256` challenge;
- the authorization code is accepted only when state matches, then exchanged at Google’s token endpoint;
- `access_type=offline` obtains a refresh token; `prompt=consent` supports an intentional reconnect;
- the deprecated out-of-band copy/paste flow and public calendar share links are not used.

The browser callback displays only a success message and closes its one-shot server immediately. If the dialog is cancelled or times out, the listener is closed and no new authorization is persisted.

## Connect and choose a calendar

1. Enter the desktop OAuth client ID and client secret.
2. Select **Connect**, open the Google sign-in link, and approve the requested permissions.
3. Confirm the **Connected as…** account label.
4. Select **Refresh list**, then choose an existing writable calendar; or select **Create and select** to explicitly create `Neuro Roadmap`.
5. Use **Sync now** to fully reassert the Markdown projection. Normal roadmap changes synchronize automatically after a three-second debounce.

The plugin never creates a calendar merely because an account was connected. Read-only calendars are excluded from the selection list.

## Event and reminder semantics

- A deadline is an all-day event on the commitment date. Google’s exclusive all-day `end.date` is the following day.
- Events use `transparency: transparent`, so roadmap deadlines do not block free/busy time.
- Event title and description come from Calendar Core and match the ICS provider’s meaning, including subject/project context and the Obsidian source link.
- The Calendar Core reminder becomes one Google `popup` override. When reminders are disabled, `useDefault: false` prevents calendar defaults from silently adding one.
- A private extended property stores the stable Neuro Roadmap item identity on the managed event.
- A deterministic Google-compatible event ID makes a retried create idempotent and prevents duplicate events after an interrupted request.

## Reconciliation behavior

- Eligible Markdown item with no Google mapping → create a managed event.
- Changed title, deadline, description, status, or reminder → update the same event.
- Explicit calendar exclusion or deleted source item → delete only its mapped managed event.
- Normal changes use FAST reconciliation: unchanged projection hashes do not cause remote reads or writes.
- The configurable safety interval (15 minutes by default) verifies that unchanged managed events still exist; deleted events are recreated without unconditional PUT requests.
- **Sync now** performs FULL reconciliation and reasserts Markdown-defined content even when the local projection hash is unchanged.
- Externally deleted managed event → recreate it during periodic existence verification or **Sync now**.
- Changed target calendar → remove managed Google events from the previous calendar before switching. If cleanup fails, the selection remains unchanged.
- Startup schedules one non-blocking FAST reconciliation after the Markdown index is consistent. A persisted dirty flag carries interrupted pending work into the next session.
- Shutdown makes a best-effort non-blocking FAST flush; network completion is not assumed or required for application exit.
- Restarting Obsidian preserves stable item/calendar/event mappings in plugin state and the refresh token in SecretStorage.
- Offline, timeout, authentication, permission, quota, and server errors never modify or delete Markdown.

This is one-way sync. There is no Google-to-Markdown import, two-way conflict resolution, webhook, public calendar requirement, or cloud relay.

## Security, disconnect, and privacy

- Refresh tokens are stored through Obsidian [`SecretStorage`](https://docs.obsidian.md/plugins/guides/secret-storage), never in the plugin’s `data.json`.
- Access tokens and pending OAuth material exist only in memory. Tokens and Authorization headers are never logged.
- The plugin requires Obsidian 1.11.4 or newer for SecretStorage.
- **Disconnect** calls Google’s official token revocation endpoint before deleting the local refresh token. If revocation cannot be confirmed, the local token is retained so the user can retry rather than silently leaving an active grant behind.
- Disconnect leaves managed events and their provider mappings intact for a safe reconnect to the same account. Users can also revoke access from their [Google Account third-party connections](https://myaccount.google.com/connections).
- Obsidian Community Plugins share an application environment. SecretStorage is the supported central secret facility, not a permission boundary between untrusted plugins. Install only plugins you trust and protect the device account.

Google’s [token revocation documentation](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke) notes that revocation affects the project grant, not only a single Calendar scope.

## Errors and quotas

- An expired or revoked refresh token produces an actionable reconnect state.
- A `401` invalidates the in-memory access token and retries once with refresh.
- A non-quota `403` is reported as a permission or administrator-policy error.
- Google rate limits can arrive as `403` or `429`; transient quota and `5xx` responses use bounded exponential backoff and honor `Retry-After`.
- A deleted or no-longer-writable selected calendar is reported and must be replaced manually.
- A missing managed event is recreated without changing its Markdown source.
- Network requests have a bounded timeout and are serialized by the shared sync controller.

Google can change project and per-user quotas. Consult the current [Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota) and [error guidance](https://developers.google.com/workspace/calendar/api/guides/errors) for production rollout and verification testing.
