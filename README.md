# Mailspring Offline Translator

Private, offline email translation for [Mailspring](https://getmailspring.com/). Email content is translated locally and is never sent to a translation service.

## Translation and models

- On macOS 15+, the plugin can use Apple's Translation framework.
- The cross-platform fallback runs CTranslate2 through its native Node.js binding (Node.js 20.19 or later).
- Language packages are downloaded from the official Argos Open Tech catalog only after the user confirms the download in Preferences.
- `.argosmodel` packages are ZIP archives. The plugin extracts and validates each model in its own `data/models` directory. Translation inference then runs offline.
- The CTranslate2 native binding currently supports macOS x64/arm64, Windows x64, and Linux x64; Linux ARM64 is not supported by the binding package.

## Build and install

Install the plugin's Node.js dependencies and build its CommonJS backend:

```bash
cd plugin
npm install
npm run build
```

Copy the plugin directory to Mailspring's packages directory and restart Mailspring. Use **Preferences > Offline Translator > Offline Models** to choose, download, or remove language packages.

To create a release archive, run `npm run package` from this directory. Release archives include the production Node.js dependencies and native CTranslate2 runtime.

## Privacy

The Argos catalog and model files are accessed only for catalog refreshes and user-requested downloads. Translation itself uses the local model and does not make network requests. The local translation cache can be cleared from Preferences.

## License

MIT License.
