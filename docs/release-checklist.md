# Release and Community Plugin checklist

This repository is prepared for publication, but publishing remains a maintainer-controlled process.

## Before a beta or release

- [ ] Review a clean `git status`; do not include local vaults, plugin `data.json`, OAuth material, secrets, or temporary files.
- [ ] Confirm version consistency in `package.json`, `manifest.json`, and `versions.json` if the repository uses one.
- [ ] Run `npm ci`, `npm test`, `npm run check`, and `npm run build` from a clean checkout.
- [ ] Verify the generated `main.js`, `manifest.json`, and `styles.css` match the source commit.
- [ ] Review README, documentation, [LICENSE](../LICENSE), [NOTICE](../NOTICE), [CONTRIBUTING](../CONTRIBUTING.md), and funding links.
- [ ] Confirm Google setup wording, external-service disclosure, and no committed OAuth material.
- [ ] Smoke test desktop and mobile, dark and light themes, normal and narrow panes. Test Google only with a non-production account/calendar.
- [ ] Capture accurate current screenshots for the release page; do not use placeholders.
- [ ] Run a BRAT beta with a fresh test vault.

## Community Plugin submission

Obsidian Community Plugin submission requires a public GitHub repository, `README.md`, `LICENSE`, and valid `manifest.json` on the repository's default branch. Before submitting:

1. Choose and verify the availability of the manifest ID `neuro-roadmap` in the Community directory.
2. Update the manifest version using semantic versioning and create a matching GitHub release tag.
3. Attach the built `main.js`, `manifest.json`, and `styles.css` to that GitHub release.
4. Confirm the tag exactly matches the manifest version.
5. Submit the repository URL through the Obsidian Community directory and address its automated review feedback.

No release, tag, version change, or submission is created by this repository checklist.

## Google publication status

The plugin's generic Markdown planning and ICS export do not require an external account. Direct Google Calendar sync requires a Google Cloud OAuth desktop client, consent-screen configuration, and any Google verification applicable to the selected scopes and publishing audience. The plugin owner must complete those Google-side steps before advertising a shared public OAuth client. Users may instead configure their own desktop OAuth client for testing.
