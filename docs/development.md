# Development

Install dependencies and run the local gate:

```bash
npm ci
npm test
npm run check
npm run build
```

`main.js` and `styles.css` are generated release assets and are not committed to the source repository. Do not place a real vault, `data.json`, OAuth credentials, or tokens in the repository.

The manifest ID is `neuro-roadmap`. For local Obsidian development, the plugin folder or symlink must use that same name: `.obsidian/plugins/neuro-roadmap`.

See [CONTRIBUTING](../CONTRIBUTING.md) before proposing substantive code changes.
