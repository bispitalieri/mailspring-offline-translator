# 📦 Mailspring Offline Translator

**Translate emails privately, right inside [Mailspring](https://getmailspring.com/).** This plugin runs translations on your device instead of sending email content to a cloud translation service.

<a href="https://github.com/bispitalieri/mailspring-offline-translator/releases/latest">
  <img alt="Latest release" src="https://img.shields.io/github/v/release/bispitalieri/mailspring-offline-translator?label=download">
</a>

## What it does

- **Read in your language:** translate incoming messages, detect their source language, and switch between the original, inline translation, or side-by-side views.
- **Write with confidence:** translate a draft and review a preview before explicitly applying it. The plugin never sends a message for you.
- **Keep the email intact:** message translations are presented without replacing the original message. HTML layout and links are preserved, and quoted replies, signatures, and code blocks can be excluded.
- **Choose your translation engine:** use Apple Translation on macOS 26 or later (Intel and Apple Silicon), or Mozilla/Translations for cross-platform, on-device translation.
- **Manage models and cache:** install or remove language models from Preferences, and clear the local translation cache whenever you like.
- **Translate beyond direct pairs:** when Mozilla/Translations has no direct model for a language pair, it can use English as a pivot language and download the required models after confirmation.

## Translation engines

| Platform | Available engines |
| --- | --- |
| macOS 26 or later | Apple Translation; Mozilla/Translations fallback |
| macOS 25 or earlier | Mozilla/Translations |
| Windows and Linux | Edge; Mozilla/Translations fallback|

Available languages and language pairs depend on the selected engine and its models. Apple Translation is provided by macOS; its bundled helper is universal (`arm64` and `x86_64`) and requires macOS 26 or later. Mozilla/Translations models are managed by the plugin.

## Install

1. Download the latest `.zip` from [GitHub Releases](https://github.com/bispitalieri/mailspring-offline-translator/releases/latest).
2. Extract the `mailspring-offline-translator` folder into Mailspring's `packages` directory. On macOS, this is commonly `~/Library/Application Support/Mailspring/packages`.
3. Restart Mailspring.
4. Open **Preferences > Offline Translator > Offline Models** to browse available Mozilla/Translations models. Confirm a download to install a language pair.

Once the required models are available, translation runs locally. The first model download requires an internet connection; it is not needed for inference afterward.

## Use it

- **Translate a received message:** use the translation controls in the message view, choose a target language, then switch between the translated and original views.
- **Translate a draft:** choose **Translate Draft**, review the translation, and confirm before replacing the draft text.
- **Adjust behavior:** in **Preferences > Offline Translator**, set the default target language and preferred engine, choose the display layout, configure exclusions, and manage models and cache.

## Privacy

Email text is translated on-device and is not sent to a translation service. Network access is used to refresh the model catalog and to download models when requested; translation inference itself does not make network requests. Translations are cached locally, and the cache can be cleared in Preferences.

## Build from source

Run these commands from the repository root (Node.js 24 is used by the release workflow):

```bash
npm ci
npm test
npm run typecheck
npm run build
```

To create installable release archives, run:

```bash
npm run package
```

The ZIP and TAR.GZ archives are written to `dist-package/`. Copy the staged `mailspring-offline-translator` folder from that directory into Mailspring's `packages` directory to test a local build.

## License

This project is released under the MIT License.
