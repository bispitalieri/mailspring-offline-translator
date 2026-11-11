# Mailspring Offline Translator: Native Provider Feasibility Report

## Executive Summary

This feasibility report evaluates native operating system and open-source capabilities for offline machine translation in Mailspring across macOS, Windows, and Linux.

The evaluation specifically addresses the prompt's constraints:
1. **Zero paid translation APIs, API keys, subscriptions, or external cloud services**.
2. **Apple Translation framework on macOS 15+**.
3. **Windows AI / Windows App SDK / Phi Silica evaluation without inventing non-existent APIs**.
4. **Argos Translate as the universal, open-source local fallback**.

---

## 1. macOS: Apple Translation Framework

### Technical Architecture
- **API**: Apple Translation Framework (`Translation.framework`), introduced in macOS 15.0 Sequoia and iOS 17.4/18.
- **Core Class**: `TranslationSession` and `LanguageAvailability`.
- **Underlying Engine**: Apple Silicon Neural Engine (Core ML bilingual models).
- **Network Requirement**: On-demand download for initial language packs (with user prompt). Once downloaded, 100% offline inference with zero network traffic.
- **Apple Intelligence Requirement**: **NOT REQUIRED**. The Translation framework operates on standard Apple Silicon Macs and Intel Macs without requiring Apple Intelligence hardware tiers.

### Communication Pattern
Mailspring is an Electron application. Because Electron cannot directly link against Swift 6 / Objective-C frameworks without native C++ Node addons, a lightweight compiled Swift helper (`TranslationHelper`) communicates with Mailspring using newline-delimited JSON (`JSON Lines`) over `stdin`/`stdout`.

### Feasibility Verdict
- **Feasibility**: **HIGH / PRODUCTION-READY** (on macOS 15.0+).
- **Fallback**: Automatically falls back to Argos Translate on macOS 14 and earlier.

---

## 2. Windows: Windows AI & Windows App SDK Evaluation

### Native Windows AI APIs Examined
1. **Windows App SDK 1.6+ (`Microsoft.Windows.AI.Generative`)**:
   - Provides access to **Phi Silica**, a 3.3-billion parameter Small Language Model (SLM) integrated into Windows 11.
   - **Hardware Requirement**: Copilot+ PC with a Neural Processing Unit (NPU) delivering **40+ TOPS** (Qualcomm Snapdragon X Elite/Plus, Intel Core Ultra 200V Lunar Lake, AMD Ryzen AI 300).
   - **OS Requirement**: Windows 11 Build 26100 (24H2) or later.

### Critical Engineering Findings
- **A General-Purpose SLM is NOT a Translation API**: Phi Silica is optimized for text completion, summarization, and tone rewriting. Running translation via prompt engineering (`"Translate from Italian to English: ..."`) causes hallucinations, non-deterministic phrasing, high token latency, and vocabulary collapse on low/medium-resource languages.
- **No Offline Microsoft Translator API**: Microsoft does **not** provide an offline translation runtime in Windows App SDK or Win32 APIs. The official Microsoft Translator API is strictly a paid cloud service hosted on Microsoft Azure Cognitive Services.
- **Invention Rule**: We adhere strictly to the guideline: *"Do not invent a Microsoft Translator offline API. Respect hardware, Windows SDK and model availability requirements. Implement this provider only if it can deliver reliable translations. If implementation is not feasible, expose it as unavailable and use Argos."*

### Feasibility Verdict
- **Feasibility**: **UNFEASIBLE FOR PRODUCTION TRANSLATION WITHOUT CLOUD AZURE**.
- **Strategy**: The `WindowsAiProvider` inspects the Windows build and NPU status via WMI, transparently reports its diagnostics in Settings, and **gracefully routes all Windows translation traffic to Argos Translate**.

---

## 3. Cross-Platform: Argos Models with CTranslate2

### Technical Architecture
- **Engine**: Native Node.js CTranslate2 binding using Argos Open Tech's language models.
- **Platform Support**: macOS x64/arm64, Windows x64, and Linux x64. Linux ARM64 is not supported by the current native binding package.
- **Execution Mode**: CTranslate2 model loading and inference run directly in the plugin's Node.js process; there is no Python worker.
- **Model Storage**: User-approved `.argosmodel` ZIP archives are extracted per language pair under the plugin's `data/models` directory.
- **Network Requirement**: Strictly offline during inference. Package downloads require explicit user approval in the UI.

### Feasibility Verdict
- **Feasibility**: **HIGH** on the native binding's supported platforms.
- Serves as the primary engine for Windows, Linux x64, and legacy macOS, and as the fallback on macOS 15+.

---

## 4. Provider Support Matrix

| OS / Platform | Native Engine | Argos Fallback | Offline Guarantee | User Consent Required for Models |
|---|---|---|---|---|
| **macOS 15+ (Sequoia)** | Apple Translation (`TranslationSession`) | Supported | 100% On-Device | Yes |
| **macOS 14- (Sonoma & earlier)** | Unavailable (OS limitation) | Primary | 100% On-Device | Yes |
| **Windows 11 (Copilot+ NPU)** | Evaluated (Phi Silica SLM unfeasible for MT) | Primary | 100% On-Device | Yes |
| **Windows 10 / 11 (Standard PC)** | Unavailable (No offline API) | Primary | 100% On-Device | Yes |
| **Linux x64** | N/A | Primary | 100% On-Device | Yes |
| **Linux ARM64** | N/A | Not supported by current Node binding | N/A | Yes |
