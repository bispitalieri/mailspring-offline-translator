//
//  TranslationHelper.swift
//  Mailspring Offline Translator - Apple Translation Framework Native Helper
//
//  Requires macOS 15.0+ (Sequoia)
//  Built using Swift 6 / Foundation / Translation framework.
//  Uses TranslationSession for native, on-device offline translation.
//  No Apple Intelligence requirement; works with standard on-device models.
//  Communicates with Mailspring over stdin/stdout using JSON Lines.
//

import Foundation
import NaturalLanguage

#if canImport(Translation)
import Translation
#endif

// MARK: - IPC Protocol Structs

struct IPCRequest: Codable {
    let id: String
    let action: String
    let payload: RequestPayload?
}

struct RequestPayload: Codable {
    let text: String?
    let texts: [String]?
    let sourceLang: String?
    let targetLang: String?
    let fromLang: String?
    let toLang: String?
}

struct IPCResponse<T: Codable>: Codable {
    let id: String
    let action: String
    let payload: T?
    let error: IPCError?
}

struct IPCError: Codable {
    let code: String
    let message: String
}

struct DetectionPayload: Codable {
    let language: String
    let confidence: Double
    let isReliable: Bool
}

struct TranslationPayload: Codable {
    let translatedText: String
    let detectedSourceLang: String?
    let targetLang: String
    let durationMs: Double
}

struct BatchTranslationPayload: Codable {
    let translatedTexts: [String]
    let detectedSourceLang: String?
    let targetLang: String
    let durationMs: Double
}

struct LanguagePairPayload: Codable {
    let source: String
    let target: String
    let installed: Bool
    let providerId: String
}

// MARK: - Apple Translation Service Implementation

@available(macOS 15.0, *)
class AppleTranslationBridge {
    
    #if canImport(Translation)
    private var activeSessions: [String: TranslationSession] = [:]
    #endif
    
    func checkAvailability() -> Bool {
        #if canImport(Translation)
        return true
        #else
        return false
        #endif
    }
    
    func getSupportedLanguages() -> [LanguagePairPayload] {
        // Common macOS Translation framework supported offline language codes
        let commonCodes = ["en", "it", "es", "de", "fr", "pt", "ru", "ja", "ko", "zh", "nl", "pl", "uk", "ar", "tr"]
        var pairs: [LanguagePairPayload] = []
        
        for src in commonCodes {
            for tgt in commonCodes {
                if src != tgt {
                    pairs.append(LanguagePairPayload(
                        source: src,
                        target: tgt,
                        installed: true,
                        providerId: "apple"
                    ))
                }
            }
        }
        return pairs
    }
    
    func detectLanguage(text: String) -> DetectionPayload {
        if let dominant = NLLanguageRecognizer.dominantLanguage(for: text) {
            return DetectionPayload(
                language: dominant.rawValue,
                confidence: 0.85,
                isReliable: true
            )
        }
        return DetectionPayload(language: "en", confidence: 0.5, isReliable: false)
    }
    
    func translateBatch(texts: [String], source: String, target: String) async throws -> [String] {
        #if canImport(Translation)
        let sourceLocale = Locale.Language(identifier: source)
        let targetLocale = Locale.Language(identifier: target)
        
        // Check if the language pair models are installed before creating the session
        let availability = LanguageAvailability()
        let status = await availability.status(from: sourceLocale, to: targetLocale)
        
        switch status {
        case .installed:
            // Models are installed and ready for translation
            break
        case .supported:
            // Language pair is supported but models are not installed
            throw NSError(domain: "AppleTranslation", code: 412, userInfo: [
                NSLocalizedDescriptionKey: "Translation models for \(source) → \(target) are not installed. Please install them in System Settings > Language & Region > Translation Languages."
            ])
        case .unsupported:
            throw NSError(domain: "AppleTranslation", code: 404, userInfo: [
                NSLocalizedDescriptionKey: "Language pair \(source) → \(target) is not supported by Apple Translation"
            ])
        @unknown default:
            throw NSError(domain: "AppleTranslation", code: 500, userInfo: [
                NSLocalizedDescriptionKey: "Unknown language availability status for \(source) → \(target)"
            ])
        }
        
        // Create TranslationSession with installed source and target
        let session = TranslationSession(installedSource: sourceLocale, target: targetLocale)
        
        // Translate each text
        var results: [String] = []
        for text in texts {
            do {
                let response = try await session.translate(text)
                results.append(response.targetText)
            } catch {
                // If translation fails, return original text
                results.append(text)
            }
        }
        
        return results
        #else
        throw NSError(domain: "AppleTranslation", code: 501, userInfo: [
            NSLocalizedDescriptionKey: "Translation framework is not available in this build"
        ])
        #endif
    }
}

// MARK: - Stdin/Stdout JSON Lines Loop (Async)

func sendJSONResponse<T: Codable>(id: String, action: String, payload: T?, error: IPCError?) {
    let resp = IPCResponse(id: id, action: action, payload: payload, error: error)
    if let data = try? JSONEncoder().encode(resp), let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

/// Async main loop that reads JSON lines from stdin and processes them.
@main
struct CLIEntry {
    static func main() async {
        if #available(macOS 15.0, *) {
            let bridge = AppleTranslationBridge()
            let input = FileHandle.standardInput
            var buffer = ""
            
            while true {
                let chunk = input.availableData
                if chunk.isEmpty {
                    // Wait for more data
                    try? await Task.sleep(nanoseconds: 10_000_000) // 10ms
                    continue
                }
                
                if let text = String(data: chunk, encoding: .utf8) {
                    buffer += text
                }
                
                while let newlineRange = buffer.range(of: "\n") {
                    let endIndex = buffer.index(newlineRange.lowerBound, offsetBy: 1)
                    let line = String(buffer[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespaces)
                    buffer.removeSubrange(buffer.startIndex..<endIndex)
                    
                    guard !line.isEmpty else { continue }
                    
                    do {
                        let request = try JSONDecoder().decode(IPCRequest.self, from: Data(line.utf8))
                        await handleRequest(request, bridge: bridge)
                    } catch {
                        let err = IPCError(code: "PARSE_ERROR", message: "Failed to parse JSON line: \(error.localizedDescription)")
                        sendJSONResponse(id: "unknown", action: "error", payload: String?.none, error: err)
                    }
                }
            }
        } else {
            let err = IPCError(code: "UNSUPPORTED_OS", message: "Apple Translation Framework requires macOS 15.0 or later.")
            sendJSONResponse(id: "unknown", action: "error", payload: String?.none, error: err)
        }
    }
}

@available(macOS 15.0, *)
func handleRequest(_ req: IPCRequest, bridge: AppleTranslationBridge) async {
    switch req.action {
    case "ping":
        sendJSONResponse(id: req.id, action: "ping", payload: ["status": "ok", "version": "1.0.0"], error: nil)
        
    case "status":
        let isAvail = bridge.checkAvailability()
        sendJSONResponse(id: req.id, action: "status", payload: [
            "available": isAvail ? "true" : "false",
            "os": "macOS 15+",
            "provider": "apple"
        ] as [String: String], error: nil)
        
    case "list_languages":
        let pairs = bridge.getSupportedLanguages()
        sendJSONResponse(id: req.id, action: "list_languages", payload: pairs, error: nil)
        
    case "detect":
        let text = req.payload?.text ?? ""
        let detected = bridge.detectLanguage(text: text)
        sendJSONResponse(id: req.id, action: "detect", payload: detected, error: nil)
        
    case "translate":
        let text = req.payload?.text ?? ""
        let src = req.payload?.sourceLang ?? "auto"
        let tgt = req.payload?.targetLang ?? "en"
        
        let detected = src == "auto" ? bridge.detectLanguage(text: text).language : src
        let start = Date()
        
        // Call translateBatch with a timeout to prevent hanging
        do {
            let translatedTexts = try await withTimeout(seconds: 10) {
                try await bridge.translateBatch(texts: [text], source: detected, target: tgt)
            }
            
            let durationMs = Date().timeIntervalSince(start) * 1000
            let translatedText = translatedTexts.first ?? text
            let payload = TranslationPayload(
                translatedText: translatedText,
                detectedSourceLang: detected,
                targetLang: tgt,
                durationMs: durationMs
            )
            sendJSONResponse(id: req.id, action: "translate", payload: payload, error: nil)
        } catch {
            let err = IPCError(code: "TRANSLATION_ERROR", message: error.localizedDescription)
            sendJSONResponse(id: req.id, action: "translate", payload: TranslationPayload?.none, error: err)
        }
        
    default:
        let err = IPCError(code: "UNKNOWN_ACTION", message: "Action \(req.action) is not recognized")
        sendJSONResponse(id: req.id, action: req.action, payload: String?.none, error: err)
    }
}

/// Executes an async operation with a timeout in seconds.
func withTimeout<T>(seconds: Int, operation: @escaping () async throws -> T) async throws -> T {
    return try await withThrowingTaskGroup(of: T.self) { group in
        // Start the main operation
        group.addTask {
            try await operation()
        }
        
        // Start the timeout task
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            throw NSError(domain: "Timeout", code: 408, userInfo: [
                NSLocalizedDescriptionKey: "Operation timed out after \(seconds) seconds"
            ])
        }
        
        // Wait for the first task to complete
        guard let result = try await group.next() else {
            throw NSError(domain: "Timeout", code: 408, userInfo: [
                NSLocalizedDescriptionKey: "Operation timed out after \(seconds) seconds"
            ])
        }
        
        // Cancel the other task
        group.cancelAll()
        return result
    }
}
