# Mailspring Offline Translator

Private, offline email translation for [Mailspring](https://getmailspring.com/). Email content is translated locally and is never sent to a translation service.

## Translation and models

- On macOS 15+, the plugin can use Apple's Translation framework.
- Cross-platform translation is provided by Mozilla/Translations.
- Language packages are downloaded only after the user confirms the download in Preferences.
- Translation inference runs entirely offline.
- **Pivot translation**: When a direct model for a language pair is not available (e.g., Spanish → Italian), Mozilla/Translations automatically translates through English as an intermediate step (Spanish → English → Italian).
- **Automatic pivot model download**: When installing a language pair without a direct model, the plugin automatically downloads both intermediate models needed for pivot translation (e.g., Spanish → English and English → Italian).

## Build and install

Install the plugin's Node.js dependencies and build its CommonJS backend:

```bash
cd plugin
npm install
npm run build
```

Copy the plugin directory to Mailspring's packages directory and restart Mailspring. Use **Preferences > Offline Translator > Offline Models** to choose, download, or remove language packages.

To create a release archive, run `npm run package` from this directory.

## Privacy

The model catalog and files are accessed only for catalog refreshes and user-requested downloads. Translation itself uses the local model and does not make network requests. The local translation cache can be cleared from Preferences.

## License

MIT License.
