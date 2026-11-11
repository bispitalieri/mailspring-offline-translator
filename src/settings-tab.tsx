/**
 * Mailspring Offline Translator - Settings Preferences Tab
 * 
 * Implements a native Mailspring PreferencesUIStore tab for:
 * - Default target language (System locale or custom BCP-47)
 * - Preferred Provider selection (Auto, Apple, Windows AI, Argos)
 * - Automatic Fallback switch
 * - Display Mode (Inline, Split/Side-by-side)
 * - Exclusions (Signatures, Quoted replies, Code blocks)
 * - Local SHA-256 Translation Cache management & stats
 * - Offline Language Model Manager (Installed status, disk size, user consent for downloads)
 * - Provider Diagnostics & Hardware probes
 */

import React, { useEffect, useState } from './react-runtime';
import { TranslationManager } from './translation-manager';
import { LanguagePair, ModelPackage, PluginSettings, ProviderInfo } from './types';
import { getLanguageDisplayName, getCommonLanguages, getSystemLocale } from './bcp47';

export const OfflineTranslatorSettingsTab: React.FC<{
  manager?: TranslationManager;
}> = (props) => {
  const [manager] = useState<TranslationManager>(
    () => props.manager || (window as any).__mailspring_offline_translator_manager || new TranslationManager()
  );

  const [settings, setSettings] = useState<PluginSettings>(() => manager.getSettings());
  const [providersInfo, setProvidersInfo] = useState<ProviderInfo[]>(() => manager.getProvidersInfo());
  const [cacheStats, setCacheStats] = useState(() => manager.getCache().getStats());
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'models' | 'diagnostics'>('general');

  // Offline model management state
  const [models, setModels] = useState<ModelPackage[]>([]);

  const [installingModel, setInstallingModel] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ percent: number; message: string } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ModelPackage | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  const languages = getCommonLanguages();
  const systemLocale = getSystemLocale();

  useEffect(() => {
    let active = true;
    manager.getProviderDiagnostics().then((info: ProviderInfo[]) => {
      if (active) setProvidersInfo(info);
    });
    return () => {
      active = false;
    };
  }, [manager]);

  const handleUpdate = (patch: Partial<PluginSettings>) => {
    manager.updateSettings(patch);
    setSettings(manager.getSettings());
  };

  const handleClearCache = () => {
    manager.getCache().clear();
    setCacheStats(manager.getCache().getStats());
  };

  const handleRequestDownload = (pkg: ModelPackage) => {
    setConfirmModal(pkg);
  };

  const refreshInstalledModels = async () => {
    const [installedResult, availableResult] = await Promise.allSettled([
      manager.getInstalledArgosModels(),
      manager.getInstallableArgosModels(),
    ]);

    if (installedResult.status === 'rejected' && availableResult.status === 'rejected') {
      throw installedResult.reason;
    }

    const installedPairs: LanguagePair[] = installedResult.status === 'fulfilled' ? installedResult.value : [];
    const availableModels: ModelPackage[] = availableResult.status === 'fulfilled' ? availableResult.value : [];
    const installed = new Set(
      installedPairs.map((pair: LanguagePair) => `${pair.source}->${pair.target}`)
    );
    const availableKeys = new Set(availableModels.map((model) => `${model.fromCode}->${model.toCode}`));
    const installedOnlyModels: ModelPackage[] = installedPairs
      .filter((pair) => !availableKeys.has(`${pair.source}->${pair.target}`))
      .map((pair) => ({
        fromCode: pair.source,
        fromName: pair.sourceName || getLanguageDisplayName(pair.source),
        toCode: pair.target,
        toName: pair.targetName || getLanguageDisplayName(pair.target),
        packageVersion: '',
        sizeMB: pair.modelSizeMB || 0,
        isInstalled: true,
        provider: 'argos',
      }));

    setModels([
      ...availableModels.map((model) => ({
        ...model,
        isInstalled: installed.has(`${model.fromCode}->${model.toCode}`),
      })),
      ...installedOnlyModels,
    ]);
    setModelError(
      availableResult.status === 'rejected'
        ? `Could not load the Argos model catalog: ${String(availableResult.reason)}`
        : installedResult.status === 'rejected'
          ? `Could not read installed Argos models: ${String(installedResult.reason)}`
          : null
    );
  };

  useEffect(() => {
    if (activeSubTab !== 'models') return;
    let active = true;
    setModelsLoading(true);
    setModelError(null);
    refreshInstalledModels()
      .catch((error: unknown) => {
        if (active) {
          setModelError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeSubTab, manager]);

  const executeInstall = async (pkg: ModelPackage) => {
    setConfirmModal(null);
    const key = `${pkg.fromCode}->${pkg.toCode}`;
    setInstallingModel(key);
    setInstallProgress({ percent: 0, message: 'Starting model installation...' });
    setModelError(null);
    try {
      const installed = await manager.installArgosModel(
        pkg.fromCode,
        pkg.toCode,
        (percent: number, message: string) => setInstallProgress({ percent, message })
      );
      if (!installed) {
        throw new Error(`Argos did not install the ${pkg.fromCode} → ${pkg.toCode} model.`);
      }
      await refreshInstalledModels();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingModel(null);
      setInstallProgress(null);
    }
  };

  const executeRemove = async (pkg: ModelPackage) => {
    setModelError(null);
    try {
      const removed = await manager.removeArgosModel(pkg.fromCode, pkg.toCode);
      if (!removed) {
        throw new Error(`Argos did not remove the ${pkg.fromCode} → ${pkg.toCode} model.`);
      }
      await refreshInstalledModels();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    }
  };

  const installedSizeMB = models
    .filter((m) => m.isInstalled)
    .reduce((acc, curr) => acc + curr.sizeMB, 0);
  const hasKnownInstalledSize = models.some((model) => model.isInstalled && model.sizeMB > 0);

  return (
    <div className="offline-translator-settings max-w-4xl space-y-6 text-neutral-200">
      {/* Subtab Navigation */}
      <div className="flex border-b border-neutral-800 space-x-6 text-xs font-medium">
        <button
          onClick={() => setActiveSubTab('general')}
          className={`pb-3 transition ${
            activeSubTab === 'general'
              ? 'border-b-2 border-cyan-500 text-cyan-400 font-semibold'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          General & Translation Rules
        </button>
        <button
          onClick={() => setActiveSubTab('models')}
          className={`pb-3 transition ${
            activeSubTab === 'models'
              ? 'border-b-2 border-cyan-500 text-cyan-400 font-semibold'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          Offline Models ({models.filter((m) => m.isInstalled).length} installed)
        </button>
        <button
          onClick={() => setActiveSubTab('diagnostics')}
          className={`pb-3 transition ${
            activeSubTab === 'diagnostics'
              ? 'border-b-2 border-cyan-500 text-cyan-400 font-semibold'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          Provider Architecture & Diagnostics
        </button>
      </div>

      {/* Tab 1: General Settings */}
      {activeSubTab === 'general' && (
        <div className="space-y-6 text-xs">
          {/* Default Target Language */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <h4 className="text-sm font-semibold text-neutral-100">Default Target Language</h4>
            <p className="mt-1 text-neutral-400">
              Select the language emails should be translated into by default.
            </p>
            <div className="mt-3 flex items-center space-x-3">
              <select
                value={settings.defaultTargetLanguage}
                onChange={(e) => handleUpdate({ defaultTargetLanguage: e.target.value })}
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              >
                <option value="system">
                  System Default ({getLanguageDisplayName(systemLocale)} - {systemLocale})
                </option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name} ({l.code})
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-neutral-400">
                Resolved locale: <strong>{getLanguageDisplayName(manager.getEffectiveTargetLanguage())}</strong>
              </span>
            </div>
          </div>

          {/* Provider Selection & Fallback */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-neutral-100">Preferred Translation Provider</h4>
              <p className="mt-1 text-neutral-400">
                Choose which local engine to attempt first when translating.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {[
                  { id: 'auto', label: 'Automatic (OS Priority)', desc: 'macOS: Apple → Argos; Windows/Linux: Argos' },
                  { id: 'apple', label: 'Apple Translation Framework', desc: 'Native macOS 15+ CoreML on-device models' },
                  { id: 'argos', label: 'Argos Translate (Local Runtime)', desc: 'Offline neural translation using the installed Argos runtime' },
                  { id: 'windows-ai', label: 'Windows AI Native', desc: 'Probed only on Windows 11 Copilot+ PCs' },
                ].map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer flex-col rounded-md border p-3 transition ${
                      settings.preferredProvider === p.id
                        ? 'border-cyan-500 bg-cyan-950/20'
                        : 'border-neutral-800 bg-neutral-800/40 hover:border-neutral-700'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        name="preferredProvider"
                        value={p.id}
                        checked={settings.preferredProvider === p.id}
                        onChange={() => handleUpdate({ preferredProvider: p.id as any })}
                        className="text-cyan-600 focus:ring-cyan-500"
                      />
                      <span className="font-medium text-neutral-200">{p.label}</span>
                    </div>
                    <span className="mt-1 ml-5 text-[11px] text-neutral-400">{p.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t border-neutral-800 pt-3">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoFallback}
                  onChange={(e) => handleUpdate({ autoFallback: e.target.checked })}
                  className="rounded text-cyan-600 focus:ring-cyan-500"
                />
                <div>
                  <span className="font-medium text-neutral-200">Enable automatic fallback</span>
                  <p className="text-[11px] text-neutral-400">
                    If preferred provider encounters an unsupported language pair, smoothly fall back to Argos.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Translation Display Mode & Exclusions */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 space-y-4">
            <h4 className="text-sm font-semibold text-neutral-100">Message Display & Privacy Rules</h4>

            <div className="space-y-3">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.excludeSignatures}
                  onChange={(e) => handleUpdate({ excludeSignatures: e.target.checked })}
                  className="rounded text-cyan-600 focus:ring-cyan-500"
                />
                <div>
                  <span className="font-medium text-neutral-200">Exclude email signatures</span>
                  <p className="text-[11px] text-neutral-400">
                    Keeps contact information, phone numbers, and job titles in original language.
                  </p>
                </div>
              </label>

              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.excludeQuotedReplies}
                  onChange={(e) => handleUpdate({ excludeQuotedReplies: e.target.checked })}
                  className="rounded text-cyan-600 focus:ring-cyan-500"
                />
                <div>
                  <span className="font-medium text-neutral-200">Exclude quoted thread replies</span>
                  <p className="text-[11px] text-neutral-400">
                    Prevents translating historical replies inside blockquotes and gmail_quote blocks.
                  </p>
                </div>
              </label>

              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.excludeCodeBlocks}
                  onChange={(e) => handleUpdate({ excludeCodeBlocks: e.target.checked })}
                  className="rounded text-cyan-600 focus:ring-cyan-500"
                />
                <div>
                  <span className="font-medium text-neutral-200">Exclude code blocks and preformatted text</span>
                  <p className="text-[11px] text-neutral-400">
                    Protects &lt;pre&gt; and &lt;code&gt; tags from translation syntax distortion.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Local Translation Cache */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-neutral-100">Local Translation Cache</h4>
                <p className="mt-1 text-neutral-400">
                  Saves SHA-256 keyed translations in local storage to avoid repeated inference.
                </p>
              </div>
              <button
                onClick={handleClearCache}
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-700 hover:text-white"
              >
                Clear Cache
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-4 rounded bg-neutral-950/40 p-3 sm:grid-cols-4">
              <div>
                <div className="text-[10px] text-neutral-400 uppercase">Cached Items</div>
                <div className="text-sm font-semibold text-neutral-200">{cacheStats.entryCount}</div>
              </div>
              <div>
                <div className="text-[10px] text-neutral-400 uppercase">Storage Used</div>
                <div className="text-sm font-semibold text-neutral-200">
                  {(cacheStats.totalSizeBytes / 1024).toFixed(1)} KB
                </div>
              </div>
              <div>
                <div className="text-[10px] text-neutral-400 uppercase">Cache Hits</div>
                <div className="text-sm font-semibold text-emerald-400">{cacheStats.hitCount}</div>
              </div>
              <div>
                <div className="text-[10px] text-neutral-400 uppercase">Cache Misses</div>
                <div className="text-sm font-semibold text-neutral-400">{cacheStats.missCount}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Offline Models */}
      {activeSubTab === 'models' && (
        <div className="space-y-4 text-xs">
          <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <div>
              <h4 className="text-sm font-semibold text-neutral-100">Argos Neural Translation Models</h4>
              <p className="mt-1 text-neutral-400">
                Downloaded models are stored in the plugin's data/models folder and run 100% offline using the native CTranslate2 runtime.
              </p>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-neutral-400">Known Disk Space In Use</div>
              <div className="text-sm font-semibold text-cyan-400">
                {hasKnownInstalledSize ? `${installedSizeMB.toFixed(1)} MB` : 'Not provided'}
              </div>
            </div>
          </div>

          {modelError && (
            <div className="offline-translator-error" role="alert">
              <strong>Argos model management issue.</strong> {modelError}
            </div>
          )}

          {/* Model Table */}
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/60">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-neutral-800 bg-neutral-950/40 text-[11px] text-neutral-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Language Pair</th>
                  <th className="px-4 py-2.5 font-medium">Engine</th>
                  <th className="px-4 py-2.5 font-medium">Package Size</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/60">
                {modelsLoading && (
                  <tr><td colSpan={5} className="px-4 py-4 text-center text-neutral-400">Loading Argos models...</td></tr>
                )}
                {!modelsLoading && models.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-4 text-center text-neutral-400">No Argos models are available. Check your network connection.</td></tr>
                )}
                {models.map((m) => {
                  const key = `${m.fromCode}->${m.toCode}`;
                  const isBusy = installingModel === key;

                  return (
                    <tr key={key} className="hover:bg-neutral-800/30">
                      <td className="px-4 py-3 font-medium text-neutral-200">
                        {m.fromName} ({m.fromCode}) → {m.toName} ({m.toCode})
                      </td>
                      <td className="px-4 py-3 text-neutral-400 uppercase">{m.provider}</td>
                      <td className="px-4 py-3 text-neutral-400">{m.sizeMB ? `${m.sizeMB} MB` : 'Not provided'}</td>
                      <td className="px-4 py-3">
                        {m.isInstalled ? (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-950/80 px-2 py-0.5 text-[11px] text-emerald-400 border border-emerald-800/30">
                            ✓ Installed & Ready
                          </span>
                        ) : isBusy ? (
                          <span className="offline-translator-install-progress text-cyan-400">
                            <span>{installProgress?.message || 'Downloading and installing...'}</span>
                            <progress max={100} value={installProgress?.percent || 0} />
                            <span>{installProgress?.percent ?? 0}%</span>
                          </span>
                        ) : (
                          <span className="text-neutral-400">Not Installed</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {m.isInstalled ? (
                          <button
                            onClick={() => executeRemove(m)}
                            className="rounded px-2.5 py-1 text-xs text-rose-400 hover:bg-rose-950/50"
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRequestDownload(m)}
                            disabled={Boolean(installingModel)}
                            className="rounded bg-cyan-600 px-3 py-1 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
                          >
                            Download Model
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: Diagnostics */}
      {activeSubTab === 'diagnostics' && (
        <div className="space-y-4 text-xs">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <h4 className="text-sm font-semibold text-neutral-100">Hardware & Provider Capabilities</h4>
            <p className="mt-1 text-neutral-400">
              Real-time platform detection and availability checks across registered translation providers.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {providersInfo.map((p) => (
              <div
                key={p.id}
                className="flex flex-col justify-between rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-100">{p.name}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        p.isAvailable
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40'
                          : 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      {p.isAvailable ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-cyan-400 font-mono">{p.version}</div>
                  <p className="mt-2 text-[11px] text-neutral-400">{p.description}</p>
                </div>

                <div className="mt-4 border-t border-neutral-800/60 pt-3 text-[11px]">
                  {p.unavailabilityReason && (
                    <div className="rounded bg-neutral-950/60 p-2 text-neutral-400 border border-neutral-800">
                      ℹ️ {p.unavailabilityReason}
                    </div>
                  )}
                  <div className="mt-2 text-neutral-400">
                    Platforms: <span className="text-neutral-300">{p.platform.join(', ')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Explicit User Consent Modal for Model Download */}
      {confirmModal && (
        <div className="offline-translator-confirm-backdrop">
          <div className="offline-translator-confirm-modal w-full max-w-md p-6">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-600/20 text-cyan-400">
                📥
              </div>
              <div>
                <h3 className="text-sm font-semibold text-neutral-100">Confirm Model Download</h3>
                <p className="text-xs text-neutral-400">Explicit user consent required</p>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-neutral-300">
              <p>
                You are about to download the offline neural translation package for:
              </p>
              <div className="rounded bg-neutral-950 p-2.5 font-medium text-cyan-300">
                {confirmModal.fromName} ({confirmModal.fromCode}) → {confirmModal.toName} ({confirmModal.toCode})
              </div>
              <div className="flex justify-between text-neutral-400 pt-1">
                <span>Download size:</span>
                <span className="font-semibold text-neutral-200">
                  {confirmModal.sizeMB ? `~${confirmModal.sizeMB} MB` : 'Not provided by Argos'}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Once downloaded, this model will be stored locally in Mailspring's offline-translation-models folder and will perform translations completely offline without network access.
              </p>
            </div>

            <div className="mt-6 flex justify-end space-x-2 text-xs">
              <button
                onClick={() => setConfirmModal(null)}
                className="rounded border border-neutral-700 px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={() => executeInstall(confirmModal)}
                className="rounded bg-cyan-600 px-4 py-1.5 font-medium text-white hover:bg-cyan-500"
              >
                Approve & Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
