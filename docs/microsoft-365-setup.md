# Microsoft 365 / Outlook one-way sync

Neuro Roadmap treats Markdown as the only source of truth. Microsoft 365 is a downstream projection: edits made directly to managed Outlook events are not imported into Markdown and can be overwritten by a later reconciliation.

## Microsoft App Registration

The plugin is a public client. It uses the Microsoft identity platform OAuth 2.0 Device Authorization Grant and never uses a client secret.

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) and go to **Identity → Applications → App registrations → New registration**.
2. Name the application, for example `Neuro Roadmap`.
3. Choose the supported account type appropriate for the vault owner. To support work, school, and personal Microsoft accounts, choose accounts in any organizational directory and personal Microsoft accounts. A tenant-only registration can instead use its tenant ID in plugin settings.
4. Register the application and copy its **Application (client) ID** into **Neuro Roadmap settings → Microsoft 365 / Outlook**.
5. Under **API permissions**, add Microsoft Graph delegated permissions:
   - `User.Read`
   - `Calendars.ReadWrite`
6. Under **Authentication → Advanced settings**, enable **Allow public client flows**. Device-code authentication does not need a redirect URI.
7. Do not create or distribute a client secret. If a secret already exists for this registration, Neuro Roadmap does not use it.

The runtime requests `openid`, `profile`, `email`, and `offline_access` in addition to the two Graph delegated permissions. `offline_access` is required for refresh tokens. See Microsoft’s current [device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [scope guidance](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), and [Graph calendar permissions](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0).

Some organizations require administrator consent or enforce Conditional Access. A `403` or interaction-required response must be resolved by the organization’s Microsoft 365 administrator; the plugin does not bypass tenant policy.

## Connect and select a calendar

1. Enter the client ID and tenant (`common`, `organizations`, `consumers`, or a tenant ID).
2. Select **Connect**.
3. Open the Microsoft verification link and enter the displayed device code.
4. Refresh the calendar list and select an existing calendar, or explicitly choose **Create and select** to create `Neuro Roadmap`.
5. Use **Sync now** for a full verification. Automatic sync debounces subsequent roadmap changes.

The plugin never creates a calendar merely because an account was connected.

## Security and token storage

- The refresh token is stored through Obsidian [`SecretStorage`](https://docs.obsidian.md/plugins/guides/secret-storage), not in the plugin’s `data.json`.
- Access tokens live only in memory and are refreshed shortly before expiry.
- Authorization codes, device codes, access tokens, refresh tokens, and Authorization headers are never logged.
- The plugin requires Obsidian 1.11.4 or newer for `SecretStorage` on desktop and mobile.
- Obsidian plugins execute in the same application environment. `SecretStorage` is the supported central secret facility, but it is not a permission boundary between untrusted Community Plugins. Install only plugins you trust and protect the device/vault account.

**Disconnect** removes the local token from SecretStorage but deliberately leaves managed Outlook events and provider mappings intact for a safe reconnect to the same account. It does not revoke consent tenant-wide. To revoke server-side access, remove the application’s consent in Microsoft My Apps / Microsoft Account or ask the tenant administrator; Microsoft documents that refresh tokens can also be revoked by user/admin action in its [refresh-token guidance](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).

## Sync behavior

- Eligible Markdown item with no mapping → create an Outlook event.
- Changed title, deadline, description, status, or reminder → update the same mapped event.
- Excluded or deleted source item → delete only the mapped managed event.
- Externally deleted managed event → recreate it during **Sync now** or startup/full verification.
- Changed target calendar → remove managed events from the old calendar before creating them in the new calendar. If cleanup fails, the selection is not changed.
- Offline, timeout, `401`, `403`, `429`, and server failures never modify or delete Markdown.

All deadline events are all-day events with `showAs: free`. Outlook exposes one `reminderMinutesBeforeStart` value per event, so the provider translates the single Calendar Core reminder and does not pretend to support multiple alarms.

Microsoft Graph throttling is handled using `Retry-After` with bounded retries, following the official [Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling) and [Graph error model](https://learn.microsoft.com/en-us/graph/errors).

## Current boundary

This integration is one-way and uses delegated user permissions. There is no Microsoft Graph application permission, client secret, cloud relay, webhook, Outlook-to-Markdown import, or two-way conflict resolution.
