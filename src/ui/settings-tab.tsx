/**
 * Mailspring Offline Translator - Settings Preferences Tab
 * 
 * Implements a native Mailspring PreferencesUIStore tab for:
 * - Default target language (System locale or custom BCP-47)
 * - Preferred Provider selection (Auto, Apple, Windows AI, Mozilla/Translations)
 * - Automatic Fallback switch
 * - Display Mode (Inline, Split/Side-by-side)
 * - Exclusions (Signatures, Quoted replies, Code blocks)
 * - Local SHA-256 Translation Cache management & stats
 * - Offline Language Model Manager (Installed status, disk size, user consent for downloads)
 * - Provider Diagnostics & Hardware probes
 */

import React, { useEffect, useState } from '../utils/react-runtime';
import { TranslationManager } from '../core';
import { LanguagePair, ModelPackage, PluginSettings, ProviderInfo } from '../types';
import { getLanguageDisplayName, getCommonLanguages, getSystemLocale } from '../utils';
import { confirmationWindow } from './confirmation-window';

const MODEL_PAGE_SIZE = 10;

export const OfflineTranslatorSettingsTab: React.FC<{
  manager?: TranslationManager;
}> = (props) => {
  const [manager] = useState<TranslationManager>(
    () => props.manager || (window as any).__mailspring_offline_translator_manager || new TranslationManager()
  );

  useEffect(() => {
    const isLocalInstance = !props.manager && !(window as any).__mailspring_offline_translator_manager;
    return () => {
      if (isLocalInstance) {
        manager.dispose();
      }
    };
  }, [manager, props.manager]);

  const [settings, setSettings] = useState<PluginSettings>(() => manager.getSettings());
  const [providersInfo, setProvidersInfo] = useState<ProviderInfo[]>(() => manager.getProvidersInfo());
  const [cacheStats, setCacheStats] = useState(() => manager.getCache().getStats());
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'models' | 'diagnostics'>('general');

  // Offline model management state
  const [models, setModels] = useState<ModelPackage[]>([]);

  const [installingModel, setInstallingModel] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ percent: number; message: string } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleModelCount, setVisibleModelCount] = useState(MODEL_PAGE_SIZE);

  const languages = getCommonLanguages();
  const systemLocale = getSystemLocale();

  useEffect(() => {
    let active = true;
    manager.getProviderDiagnostics()
      .then((info: ProviderInfo[]) => {
        if (active) setProvidersInfo(info);
      })
      .catch(() => {});
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
    confirmationWindow.show({
      model: pkg,
      onConfirm: executeInstall,
      onCancel: () => {
        // User cancelled - do nothing
      },
    }).catch(() => {});
  };

  const refreshInstalledModels = async () => {
    const [installedResult, availableResult] = await Promise.allSettled([
      manager.getInstalledBergamotModels(),
      manager.getInstallableBergamotModels(),
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
        provider: 'bergamot',
      }));

    setModels([
      ...availableModels.map((model) => ({
        ...model,
        isInstalled: installed.has(`${model.fromCode}->${model.toCode}`),
      })),
      ...installedOnlyModels,
    ]);

    let error = null;
    if(availableResult.status === 'rejected'){
      error = `Could not load the Mozilla/Translations model catalog: ${String(availableResult.reason)}`
    } else if(installedResult.status === 'rejected') {
      error = `Could not read installed Mozilla/Translations models: ${String(installedResult.reason)}`;
    }
    setModelError(error);
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
    const key = `${pkg.fromCode}->${pkg.toCode}`;
    setInstallingModel(key);
    setInstallProgress({ percent: 0, message: 'Starting model installation...' });
    setModelError(null);
    try {
      const installed = await manager.installBergamotModel(
        pkg.fromCode,
        pkg.toCode,
        (percent: number, message: string) => setInstallProgress({ percent, message })
      );
      if (!installed) {
        setModelError(`Mozilla/Translations did not install the ${pkg.fromCode} → ${pkg.toCode} model.`);
        return;
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
      const removed = await manager.removeBergamotModel(pkg.fromCode, pkg.toCode);
      if (!removed) {
        setModelError(`Mozilla/Translations did not remove the ${pkg.fromCode} → ${pkg.toCode} model.`);
        return;
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

  const filteredModels = models.filter((m) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.fromName.toLowerCase().includes(q) ||
      m.toName.toLowerCase().includes(q) ||
      m.fromCode.toLowerCase().includes(q) ||
      m.toCode.toLowerCase().includes(q)
    );
  });
  const visibleModels = filteredModels.slice(0, visibleModelCount);

  return (
    <div className="offline-translator-settings">
      {/* Subtab Navigation */}
      <div className="offline-translator-subtabs">
        <button
          onClick={() => setActiveSubTab('general')}
          className={activeSubTab === 'general' ? 'active' : ''}
        >
          General & Translation Rules
        </button>
        <button
          onClick={() => setActiveSubTab('models')}
          className={activeSubTab === 'models' ? 'active' : ''}
        >
          Offline Models (Mozilla/Translations)
        </button>
        <button
          onClick={() => setActiveSubTab('diagnostics')}
          className={activeSubTab === 'diagnostics' ? 'active' : ''}
        >
          Provider Architecture & Diagnostics
        </button>
      </div>

      {/* Tab 1: General Settings */}
      {activeSubTab === 'general' && (
        <div className="offline-translator-general">
          {/* Default Target Language */}
          <div className="offline-translator-card">
            <h4 className="offline-translator-card-title">Default Target Language</h4>
            <p className="offline-translator-card-desc">
              Select the language emails should be translated into by default.
            </p>
            <div className="offline-translator-lang-row">
              <select
                value={settings.defaultTargetLanguage}
                onChange={(e) => handleUpdate({ defaultTargetLanguage: e.target.value })}
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
              <span className="offline-translator-locale-hint">
                Resolved locale: <strong>{getLanguageDisplayName(manager.getEffectiveTargetLanguage())}</strong>
              </span>
            </div>
          </div>

          {/* Provider Selection & Fallback */}
          <div className="offline-translator-card">
            <div>
              <h4 className="offline-translator-card-title">Preferred Translation Provider</h4>
              <p className="offline-translator-card-desc">
                Choose which local engine to attempt first when translating.
              </p>
              <div className="offline-translator-provider-grid">
                {[
                  { id: 'auto', label: 'Automatic (OS Priority)', desc: 'macOS: Apple → Mozilla/Translations; Windows: Edge Translator → Mozilla/Translations' },
                  { id: 'apple', label: 'Apple Translation Framework', desc: 'Native macOS 15+ CoreML on-device models' },
                  { id: 'edge-translator', label: 'Edge Translator API', desc: 'Windows 10/11: built-in Edge/Chromium Translator API with on-device neural models' },
                  { id: 'bergamot', label: 'Mozilla/Translations WASM (Mozilla)', desc: 'Mozilla Firefox Translations: WebAssembly engine, per-pair models, auto-unloads after 2 min' },
                ].map((p) => (
                  <label
                    key={p.id}
                    className={`offline-translator-provider-card ${
                      settings.preferredProvider === p.id ? 'active' : ''
                    }`}
                  >
                    <div className="offline-translator-provider-radio">
                      <input
                        type="radio"
                        name="preferredProvider"
                        value={p.id}
                        checked={settings.preferredProvider === p.id}
                        onChange={() => handleUpdate({ preferredProvider: p.id as any })}
                      />
                      <span className="offline-translator-provider-label">{p.label}</span>
                    </div>
                    <span className="offline-translator-provider-desc">{p.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="offline-translator-divider">
              <label className="offline-translator-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.autoFallback}
                  onChange={(e) => handleUpdate({ autoFallback: e.target.checked })}
                />
                <div>
                  <span className="offline-translator-checkbox-label">Enable automatic fallback</span>
                  <p className="offline-translator-checkbox-desc">
                    If preferred provider encounters an unsupported language pair, smoothly fall back to the next available provider.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Translation Display Mode & Exclusions */}
          <div className="offline-translator-card">
            <h4 className="offline-translator-card-title">Message Display & Privacy Rules</h4>

            <div className="offline-translator-checkbox-list">
              <label className="offline-translator-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.excludeSignatures}
                  onChange={(e) => handleUpdate({ excludeSignatures: e.target.checked })}
                />
                <div>
                  <span className="offline-translator-checkbox-label">Exclude email signatures</span>
                  <p className="offline-translator-checkbox-desc">
                    Keeps contact information, phone numbers, and job titles in original language.
                  </p>
                </div>
              </label>

              <label className="offline-translator-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.excludeQuotedReplies}
                  onChange={(e) => handleUpdate({ excludeQuotedReplies: e.target.checked })}
                />
                <div>
                  <span className="offline-translator-checkbox-label">Exclude quoted thread replies</span>
                  <p className="offline-translator-checkbox-desc">
                    Prevents translating historical replies inside blockquotes and gmail_quote blocks.
                  </p>
                </div>
              </label>

              <label className="offline-translator-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.excludeCodeBlocks}
                  onChange={(e) => handleUpdate({ excludeCodeBlocks: e.target.checked })}
                />
                <div>
                  <span className="offline-translator-checkbox-label">Exclude code blocks and preformatted text</span>
                  <p className="offline-translator-checkbox-desc">
                    Protects &lt;pre&gt; and &lt;code&gt; tags from translation syntax distortion.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Local Translation Cache */}
          <div className="offline-translator-card">
            <div className="offline-translator-card-header">
              <div>
                <h4 className="offline-translator-card-title">Local Translation Cache</h4>
                <p className="offline-translator-card-desc">
                  Saves SHA-256 keyed translations in local storage to avoid repeated inference.
                </p>
              </div>
              <button
                onClick={handleClearCache}
                className="offline-translator-secondary-btn"
              >
                Clear Cache
              </button>
            </div>

            <div className="offline-translator-stats-grid">
              <div className="offline-translator-stat">
                <div className="offline-translator-stat-label">Cached Items</div>
                <div className="offline-translator-stat-value">{cacheStats.entryCount}</div>
              </div>
              <div className="offline-translator-stat">
                <div className="offline-translator-stat-label">Storage Used</div>
                <div className="offline-translator-stat-value">
                  {(cacheStats.totalSizeBytes / 1024).toFixed(1)} KB
                </div>
              </div>
              <div className="offline-translator-stat">
                <div className="offline-translator-stat-label">Cache Hits</div>
                <div className="offline-translator-stat-value offline-translator-success">{cacheStats.hitCount}</div>
              </div>
              <div className="offline-translator-stat">
                <div className="offline-translator-stat-label">Cache Misses</div>
                <div className="offline-translator-stat-value">{cacheStats.missCount}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Offline Models */}
      {activeSubTab === 'models' && (
        <div className="offline-translator-models">
          <div className="offline-translator-card offline-translator-models-header">
            <div>
              <h4 className="offline-translator-card-title">
                Mozilla/Translations WASM Translation Models
              </h4>
              <p className="offline-translator-card-desc">
                Mozilla/Translations from Mozilla Firefox Translations runs entirely in WebAssembly. Each language pair downloads its own model (~15-40 MB). Auto-unloads after 2 minutes of inactivity to keep RAM usage low.
              </p>
            </div>
            <div className="offline-translator-models-disk">
              <div className="offline-translator-small-text">Known Disk Space In Use</div>
              <div className="offline-translator-disk-value">
                {hasKnownInstalledSize ? `${installedSizeMB.toFixed(1)} MB` : 'Not provided'}
              </div>
            </div>
          </div>


          {modelError && (
            <div className="offline-translator-error" role="alert">
              <strong>Mozilla/Translations</strong> model management issue. {modelError}
            </div>
          )}

          {/* Search Field */}
          <div className="offline-translator-card offline-translator-search-card">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleModelCount(MODEL_PAGE_SIZE);
              }}
              placeholder="Search language pairs (e.g. English, en -> it, Italian)..."
              className="offline-translator-search-input"
            />
          </div>

          {/* Model Table */}
          <div className="offline-translator-table-wrapper">
            <table className="offline-translator-table">
              <thead>
                <tr>
                  <th>Language Pair</th>
                  <th>Package Size</th>
                  <th>Status</th>
                  <th className="offline-translator-table-action">Action</th>
                </tr>
              </thead>
              <tbody>
                {modelsLoading && (
                  <tr><td colSpan={5} className="offline-translator-table-empty">
                    Loading Mozilla/Translations models...
                  </td></tr>
                )}
                {!modelsLoading && filteredModels.length === 0 && (
                  <tr><td colSpan={5} className="offline-translator-table-empty">
                    {models.length === 0
                      ? 'No Mozilla/Translations models are available. Check your network connection.'
                      : 'No models match your search criteria.'}
                  </td></tr>
                )}
                {visibleModels.map((m) => {
                  const key = `${m.fromCode}->${m.toCode}`;
                  const isBusy = installingModel === key;

                  return (
                    <tr key={key}>
                      <td className="offline-translator-table-pair">
                        {m.fromName} ({m.fromCode}) → {m.toName} ({m.toCode})
                      </td>
                      <td className="offline-translator-table-size">{m.sizeMB ? `${m.sizeMB.toFixed(1)} MB` : 'Not provided'}</td>
                      <td className="offline-translator-table-status">
                        {m.isInstalled ? (
                          <span className="offline-translator-badge offline-translator-badge-success">
                            ✓ Installed & Ready
                          </span>
                        ) : isBusy ? (
                          <span className="offline-translator-install-progress">
                            <span>{installProgress?.message || 'Downloading and installing...'}</span>
                            <progress max={100} value={installProgress?.percent || 0} />
                            <span>{installProgress?.percent ?? 0}%</span>
                          </span>
                        ) : (
                          <span className="offline-translator-not-installed">Not Installed</span>
                        )}
                      </td>
                      <td className="offline-translator-table-action">
                        {m.isInstalled ? (
                          <button
                            onClick={() => executeRemove(m)}
                            className="offline-translator-danger-btn"
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRequestDownload(m)}
                            disabled={Boolean(installingModel)}
                            className="offline-translator-primary-btn"
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
          {!modelsLoading && filteredModels.length > MODEL_PAGE_SIZE && (
            <div className="offline-translator-table-pagination">
              {visibleModelCount < filteredModels.length && (
                <button
                  type="button"
                  onClick={() => setVisibleModelCount((count) => Math.min(count + MODEL_PAGE_SIZE, filteredModels.length))}
                  className="offline-translator-secondary-btn"
                >
                  Show more ({filteredModels.length - visibleModelCount} remaining)
                </button>
              )}
              {visibleModelCount > MODEL_PAGE_SIZE && (
                <button
                  type="button"
                  onClick={() => setVisibleModelCount(MODEL_PAGE_SIZE)}
                  className="offline-translator-secondary-btn"
                >
                  Show less
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Diagnostics */}
      {activeSubTab === 'diagnostics' && (
        <div className="offline-translator-diagnostics">
          <div className="offline-translator-card">
            <h4 className="offline-translator-card-title">Hardware & Provider Capabilities</h4>
            <p className="offline-translator-card-desc">
              Real-time platform detection and availability checks across registered translation providers.
            </p>
          </div>

          <div className="offline-translator-diag-grid">
            {providersInfo.map((p) => (
              <div
                key={p.id}
                className="offline-translator-diag-card"
              >
                <div>
                  <div className="offline-translator-diag-header">
                    <span className="offline-translator-diag-name">{p.name}</span>
                    <span
                      className={`offline-translator-diag-badge ${p.isAvailable ? 'offline-translator-diag-badge-available' : 'offline-translator-diag-badge-unavailable'}`}
                    >
                      {p.isAvailable ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  <div className="offline-translator-diag-version">{p.version}</div>
                  <p className="offline-translator-diag-desc">{p.description}</p>
                </div>

                <div className="offline-translator-diag-footer">
                  {p.unavailabilityReason && (
                    <div className="offline-translator-diag-reason">
                      ℹ️ {p.unavailabilityReason}
                    </div>
                  )}
                  <div className="offline-translator-diag-platforms">
                    Platforms: <span className="offline-translator-diag-platforms-value">{p.platform.join(', ')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
};

OfflineTranslatorSettingsTab.displayName = 'OfflineTranslatorSettingsTab'