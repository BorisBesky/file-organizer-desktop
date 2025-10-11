import React, { useState, useEffect, useCallback } from 'react';
import {
  LLMConfig,
  LLMProviderType,
  DEFAULT_CONFIGS,
  listOllamaModels,
  listLMStudioModels,
  getEmbeddedLLMStatus,
  loadEmbeddedModel,
  EmbeddedServiceStatus,
  EmbeddedLLMOptions,
  EmbeddedDownloadState,
  startEmbeddedDownload,
} from '../api';

interface LLMConfigPanelProps {
  config: LLMConfig;
  onChange: (config: LLMConfig) => void;
  onTest?: () => Promise<void>;
  disabled?: boolean;
  providerConfigs?: Record<string, LLMConfig>;
  onLoadProviderConfig?: (provider: string) => void;
}

const PROVIDER_INFO: Record<LLMProviderType, { name: string; description: string; requiresApiKey: boolean }> = {
  lmstudio: {
    name: 'LM Studio',
    description: 'Local LLM server via LM Studio',
    requiresApiKey: false,
  },
  ollama: {
    name: 'Ollama',
    description: 'Local LLM server via Ollama',
    requiresApiKey: false,
  },
  embedded: {
    name: 'Embedded (beta)',
    description: 'Built-in llama.cpp runtime managed by File Organizer',
    requiresApiKey: false,
  },
  openai: {
    name: 'OpenAI',
    description: 'Cloud AI service (GPT models)',
    requiresApiKey: true,
  },
  anthropic: {
    name: 'Anthropic',
    description: 'Cloud AI service (Claude models)',
    requiresApiKey: true,
  },
  groq: {
    name: 'Groq',
    description: 'Fast cloud inference service',
    requiresApiKey: true,
  },
  gemini: {
    name: 'Google',
    description: 'Cloud AI service (Gemini models)',
    requiresApiKey: true,
  },
  custom: {
    name: 'Custom',
    description: 'Custom OpenAI-compatible endpoint',
    requiresApiKey: false,
  },
};

export default function LLMConfigPanel({ config, onChange, onTest, disabled, providerConfigs = {}, onLoadProviderConfig }: LLMConfigPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [customHeadersText, setCustomHeadersText] = useState(
    config.customHeaders ? JSON.stringify(config.customHeaders, null, 2) : ''
  );
  const [isCustomHeadersValid, setIsCustomHeadersValid] = useState(true);
  const [embeddedStatus, setEmbeddedStatus] = useState<EmbeddedServiceStatus | null>(null);
  const [embeddedStatusLoading, setEmbeddedStatusLoading] = useState(false);
  const [embeddedStatusError, setEmbeddedStatusError] = useState<string | null>(null);
  const [embeddedActionState, setEmbeddedActionState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [embeddedActionMessage, setEmbeddedActionMessage] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadTargetName, setDownloadTargetName] = useState('');
  const [downloadSha256, setDownloadSha256] = useState('');
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [downloadMessage, setDownloadMessage] = useState('');

  useEffect(() => {
    const newHeadersText = config.customHeaders ? JSON.stringify(config.customHeaders, null, 2) : '';
    setCustomHeadersText(newHeadersText);
  }, [config.customHeaders]);

  const embeddedOptions: EmbeddedLLMOptions = config.embeddedOptions || { modelPath: '' };

  const updateEmbeddedOptions = (changes: Partial<EmbeddedLLMOptions>) => {
    onChange({
      ...config,
      embeddedOptions: {
        ...embeddedOptions,
        ...changes,
      },
    });
  };

  const refreshEmbeddedStatus = useCallback(async () => {
    if (config.provider !== 'embedded') return;

    setEmbeddedStatusLoading(true);
    try {
      const status = await getEmbeddedLLMStatus();
      if (status) {
        setEmbeddedStatus(status);
        setEmbeddedStatusError(null);
      } else {
        setEmbeddedStatus(null);
        setEmbeddedStatusError('Embedded service is not running yet. It will start automatically when needed.');
      }
    } catch (error: any) {
      setEmbeddedStatus(null);
      setEmbeddedStatusError(error?.message || String(error));
    } finally {
      setEmbeddedStatusLoading(false);
    }
  }, [config.provider]);

  useEffect(() => {
    if (config.provider !== 'embedded') {
      setEmbeddedStatus(null);
      setEmbeddedStatusError(null);
      setEmbeddedActionState('idle');
      setEmbeddedActionMessage('');
      setDownloadState('idle');
      setDownloadMessage('');
      setDownloadUrl('');
      setDownloadTargetName('');
      setDownloadSha256('');
      return;
    }

    refreshEmbeddedStatus();
  }, [config.provider, refreshEmbeddedStatus]);

  const handleEmbeddedLoad = async () => {
    if (!embeddedOptions.modelPath) {
      setEmbeddedActionState('error');
      setEmbeddedActionMessage('Provide a GGUF model path before loading.');
      return;
    }

    setEmbeddedActionState('loading');
    setEmbeddedActionMessage('Loading model into embedded runtime...');
    try {
      await loadEmbeddedModel(embeddedOptions);
      setEmbeddedActionState('success');
      setEmbeddedActionMessage('Model loaded successfully.');
      await refreshEmbeddedStatus();
      // setTimeout(() => {
      //   setEmbeddedActionState('idle');
      //   setEmbeddedActionMessage('');
      // }, 3000);
    } catch (error: any) {
      setEmbeddedActionState('error');
      setEmbeddedActionMessage(error?.message || String(error));
    }
  };

  const formatUptime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const formatBytes = (value?: number | null) => {
    if (value == null || value < 0) return 'unknown size';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const magnitude = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
    const scaled = value / Math.pow(1000, magnitude);
    return `${scaled.toFixed(scaled >= 10 || magnitude === 0 ? 0 : 1)} ${units[magnitude]}`;
  };

  const handleUseDownloadAsModel = (download: EmbeddedDownloadState) => {
    updateEmbeddedOptions({ modelPath: download.target_path });
    setEmbeddedActionState('success');
    setEmbeddedActionMessage('Model path updated from completed download.');
    setTimeout(() => {
      setEmbeddedActionState('idle');
      setEmbeddedActionMessage('');
    }, 3000);
  };

  const handleStartDownload = async () => {
    if (!downloadUrl.trim()) {
      setDownloadState('error');
      setDownloadMessage('Enter a model download URL to start.');
      return;
    }

    setDownloadState('loading');
    setDownloadMessage('Starting model download...');
    try {
      await startEmbeddedDownload({
        url: downloadUrl.trim(),
        targetName: downloadTargetName.trim() || undefined,
        sha256: downloadSha256.trim() || undefined,
      });
      setDownloadState('success');
      setDownloadMessage('Download started! Progress will appear below.');
      setDownloadUrl('');
      setDownloadTargetName('');
      setDownloadSha256('');
      await refreshEmbeddedStatus();
      // setTimeout(() => {
      //   setDownloadState('idle');
      //   setDownloadMessage('');
      // }, 4000);
    } catch (error: any) {
      setDownloadState('error');
      setDownloadMessage(error?.message || String(error));
    }
  };

  const describeDownloadStatus = (download: EmbeddedDownloadState) => {
    const statusLabel = download.status.replace(/_/g, ' ');
    const parts = [`Status: ${statusLabel}`];
    if (download.total_bytes) {
      const remaining = download.total_bytes - download.bytes_downloaded;
      const percent = Math.min(100, Math.round((download.bytes_downloaded / download.total_bytes) * 100));
      parts.push(`Progress: ${formatBytes(download.bytes_downloaded)} of ${formatBytes(download.total_bytes)} (${percent}%)`);
      if (remaining > 0 && download.status === 'in_progress') {
        parts.push(`${formatBytes(remaining)} remaining`);
      }
    } else if (download.bytes_downloaded > 0) {
      parts.push(`Downloaded ${formatBytes(download.bytes_downloaded)}`);
    }
    if (download.status === 'failed' && download.error) {
      parts.push(`Error: ${download.error}`);
    }
    return parts.join(' • ');
  };

  const embeddedStatusText = (() => {
    if (embeddedStatusLoading) return 'Checking embedded service status...';
    if (embeddedStatusError) return embeddedStatusError;
    if (!embeddedStatus) return 'Service will start automatically on first use.';

    return embeddedStatus.ready
      ? `Ready • Model: ${embeddedStatus.model || 'not loaded'} • Uptime: ${formatUptime(embeddedStatus.uptime_s)}`
      : `Starting • Last model: ${embeddedStatus.model || 'none'}`;
  })();

  const downloads: EmbeddedDownloadState[] = embeddedStatus?.downloads ?? [];
  const hasActiveDownloads = downloads.some((download) =>
    download.status === 'pending' || download.status === 'in_progress'
  );

  const embeddedActionClassName = embeddedActionState !== 'idle'
    ? `embedded-service-message ${embeddedActionState}`
    : 'embedded-service-message';

  useEffect(() => {
    if (config.provider !== 'embedded') return;
    if (!isExpanded && !hasActiveDownloads) return;

    refreshEmbeddedStatus();

    let intervalId: number | undefined;
    // if (typeof window !== 'undefined') {
    //   const intervalMs = hasActiveDownloads ? 2000 : 6000;
    //   intervalId = window.setInterval(() => {
    //     refreshEmbeddedStatus();
    //   }, intervalMs);
    // }

    return () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [config.provider, isExpanded, hasActiveDownloads, refreshEmbeddedStatus]);

  const currentProviderInfo = PROVIDER_INFO[config.provider];

  const handleProviderChange = (provider: LLMProviderType) => {
    // Check if we have a saved config for this provider
    const savedConfig = providerConfigs[provider];
    
    if (savedConfig && onLoadProviderConfig) {
      // Load the saved config for this provider
      onLoadProviderConfig(provider);
    } else {
      // Use default config for this provider
      const defaultConfig = DEFAULT_CONFIGS[provider] || {};
      onChange({
        ...config,
        provider,
        baseUrl: defaultConfig.baseUrl ?? '',
        model: defaultConfig.model ?? '',
        apiKey: provider === config.provider ? config.apiKey : defaultConfig.apiKey,
        maxTokens: defaultConfig.maxTokens ?? config.maxTokens,
        maxTextLength: defaultConfig.maxTextLength ?? config.maxTextLength,
        systemMessage: defaultConfig.systemMessage ?? config.systemMessage,
        customHeaders: defaultConfig.customHeaders,
        embeddedOptions:
          provider === 'embedded'
            ? { ...(defaultConfig.embeddedOptions || { modelPath: '' }) }
            : defaultConfig.embeddedOptions,
      });
    }
  };

  // Fetch available local models when provider or baseUrl changes
  useEffect(() => {
    let mounted = true;
    async function fetchModels() {
      setAvailableModels([]);
      setModelsError(null);
      if (config.provider !== 'ollama' && config.provider !== 'lmstudio') return;
      if (!config.baseUrl) return;
      setModelsLoading(true);
      try {
        const models = config.provider === 'ollama'
          ? await listOllamaModels(config.baseUrl)
          : await listLMStudioModels(config.baseUrl);
        if (!mounted) return;
        setAvailableModels(models || []);
      } catch (err: any) {
        if (!mounted) return;
        setModelsError(err?.message || 'Failed to fetch models');
      } finally {
        if (mounted) setModelsLoading(false);
      }
    }

    fetchModels();
    return () => { mounted = false; };
  }, [config.provider, config.baseUrl]);

  const handleTestConnection = async () => {
    if (!onTest) return;
    
    setTestStatus('testing');
    setTestMessage('Testing connection...');
    
    try {
      await onTest();
      setTestStatus('success');
      setTestMessage('✓ Connection successful!');
      setTimeout(() => {
        setTestStatus('idle');
        setTestMessage('');
      }, 3000);
    } catch (error: any) {
      setTestStatus('error');
      setTestMessage(`✗ Connection failed: ${error.message || String(error)}`);
    }
  };

  return (
    <div className="llm-config-panel">
      <div className="llm-config-header">
        <button
          type="button"
          className="llm-config-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
          disabled={disabled}
        >
          <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
          <strong>LLM Provider:</strong> {currentProviderInfo.name}
          {config.model && ` (${config.model})`}
        </button>
      </div>

      {isExpanded && (
        <div className="llm-config-content">
          {/* Provider Selection */}
          <div className="config-section">
            <label className="config-label">
              Provider
              <select
                className="config-input"
                value={config.provider}
                onChange={(e) => handleProviderChange(e.target.value as LLMProviderType)}
                disabled={disabled}
              >
                {(Object.keys(PROVIDER_INFO) as LLMProviderType[]).map((provider) => {
                  const info = PROVIDER_INFO[provider];
                  return (
                    <option key={provider} value={provider}>
                      {info.name}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="config-hint">
              {currentProviderInfo.description}
              {providerConfigs[config.provider] && (
                <span className="saved-config-tag"> • Saved configuration</span>
              )}
            </div>
          </div>

          {/* Configuration Fields */}
          {config.provider === 'embedded' ? (
            <div className="config-section">
              <label className="config-label">
                Embedded Service
                <div className="config-hint">{embeddedStatusText}</div>
              </label>
              <div className="embedded-service-controls">
                <button
                  type="button"
                  className="test-button"
                  onClick={refreshEmbeddedStatus}
                  disabled={disabled || embeddedStatusLoading}
                >
                  {embeddedStatusLoading ? 'Checking…' : 'Refresh Status'}
                </button>
                <button
                  type="button"
                  className="test-button"
                  onClick={handleEmbeddedLoad}
                  disabled={disabled || embeddedActionState === 'loading'}
                >
                  {embeddedActionState === 'loading' ? 'Loading…' : 'Load Model'}
                </button>
              </div>
              {embeddedActionMessage && (
                <div className={embeddedActionClassName}>
                  {embeddedActionMessage}
                </div>
              )}

              <div className="embedded-download-section">
                <h4>Model downloads</h4>
                <div className="config-hint">
                  Download GGUF models directly into File Organizer's models directory. Leave "Save as" blank to use the filename from the URL.
                </div>

                <label className="config-label">
                  Download URL
                  <input
                    type="text"
                    className="config-input"
                    value={downloadUrl}
                    onChange={(e) => setDownloadUrl(e.target.value)}
                    placeholder="https://huggingface.co/.../model.q4_k.gguf"
                    disabled={disabled || downloadState === 'loading'}
                  />
                </label>

                <label className="config-label">
                  Save as (optional)
                  <input
                    type="text"
                    className="config-input"
                    value={downloadTargetName}
                    onChange={(e) => setDownloadTargetName(e.target.value)}
                    placeholder="qwen2.5-0.5b-instruct-q4.gguf"
                    disabled={disabled || downloadState === 'loading'}
                  />
                </label>

                <label className="config-label">
                  SHA-256 checksum (optional)
                  <input
                    type="text"
                    className="config-input"
                    value={downloadSha256}
                    onChange={(e) => setDownloadSha256(e.target.value)}
                    placeholder="Provide to verify the download"
                    disabled={disabled || downloadState === 'loading'}
                  />
                </label>

                <div className="embedded-service-controls">
                  <button
                    type="button"
                    className="test-button"
                    onClick={handleStartDownload}
                    disabled={disabled || downloadState === 'loading' || !downloadUrl.trim()}
                  >
                    {downloadState === 'loading' ? 'Starting…' : 'Start Download'}
                  </button>
                </div>

                {downloadMessage && (
                  <div className={`embedded-download-message ${downloadState}`}>
                    {downloadMessage}
                  </div>
                )}

                <div className="embedded-download-list">
                  {downloads.length === 0 ? (
                    <div className="config-hint">No downloads yet. Start one above to populate this list.</div>
                  ) : (
                    <ul>
                      {downloads.map((download) => {
                        const percent = download.total_bytes
                          ? Math.min(100, Math.round((download.bytes_downloaded / download.total_bytes) * 100))
                          : null;
                        const isComplete = download.status === 'completed';
                        const isFailed = download.status === 'failed';
                        return (
                          <li key={download.id} className={`embedded-download-item status-${download.status}`}>
                            <div className="download-primary">
                              <strong>{download.target_path}</strong>
                              <div className="config-hint">{describeDownloadStatus(download)}</div>
                            </div>
                            {percent !== null && (
                              <progress value={percent} max={100} />
                            )}
                            <div className="download-actions">
                              <span className="download-size">
                                {download.total_bytes
                                  ? `${formatBytes(download.total_bytes)} total`
                                  : download.bytes_downloaded > 0
                                    ? `${formatBytes(download.bytes_downloaded)} downloaded`
                                    : 'Size pending'}
                              </span>
                              {isComplete && (
                                <button
                                  type="button"
                                  className="test-button"
                                  onClick={() => handleUseDownloadAsModel(download)}
                                  disabled={disabled}
                                >
                                  Use as model path
                                </button>
                              )}
                              {isFailed && download.error && (
                                <span className="download-error">{download.error}</span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="config-section">
              <label className="config-label">
                Base URL
                <input
                  type="text"
                  className="config-input"
                  value={config.baseUrl}
                  onChange={(e) => onChange({ ...config, baseUrl: e.target.value })}
                  placeholder="e.g., http://localhost:1234"
                  disabled={disabled}
                />
              </label>
            </div>
          )}

          <div className="config-section">
            <label className="config-label">
              Model
              {config.provider === 'embedded' ? (
                <input
                  type="text"
                  className="config-input"
                  value={embeddedOptions.modelPath}
                  onChange={(e) => updateEmbeddedOptions({ modelPath: e.target.value })}
                  placeholder="/Users/you/.file-organizer/models/qwen2.5-0.5b-instruct-q4.gguf"
                  disabled={disabled}
                />
              ) : config.provider === 'ollama' || config.provider === 'lmstudio' ? (
                <>
                  <select
                    className="config-input"
                    value={config.model}
                    onChange={(e) => onChange({ ...config, model: e.target.value })}
                    disabled={disabled || modelsLoading}
                  >
                    <option value="">Select a model{modelsLoading ? ' (loading...)' : ''}</option>
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  {modelsError && <div className="config-hint model-error">{modelsError}</div>}
                </>
              ) : (
                <input
                  type="text"
                  className="config-input"
                  value={config.model}
                  onChange={(e) => onChange({ ...config, model: e.target.value })}
                  placeholder="e.g., gpt-4-turbo-preview"
                  disabled={disabled}
                />
              )}
            </label>
            <div className="config-hint">
              {config.provider === 'openai' && 'Examples: gpt-4-turbo-preview, gpt-3.5-turbo'}
              {config.provider === 'anthropic' && 'Examples: claude-3-5-sonnet-20241022, claude-3-opus-20240229'}
              {config.provider === 'ollama' && 'Examples: llama2, mistral, codellama'}
              {config.provider === 'groq' && 'Examples: llama-3.1-70b-versatile, mixtral-8x7b-32768'}
              {config.provider === 'gemini' && 'Examples: gemini-2.0-flash-exp, gemini-1.5-pro, gemini-1.5-flash'}
              {config.provider === 'lmstudio' && 'Use the model name from your LM Studio server'}
                {config.provider === 'embedded' && 'Provide the full path to a local GGUF model file (e.g., ~/.file-organizer/models/qwen2.5-0.5b-instruct-q4.gguf)'}
            </div>
          </div>

          {currentProviderInfo.requiresApiKey && (
            <div className="config-section">
              <label className="config-label">
                API Key
                <input
                  type="password"
                  className="config-input"
                  value={config.apiKey || ''}
                  onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
                  placeholder="Enter your API key"
                  disabled={disabled}
                />
              </label>
              <div className="config-hint">
                {config.provider === 'openai' && 'Get your API key from platform.openai.com'}
                {config.provider === 'anthropic' && 'Get your API key from console.anthropic.com'}
                {config.provider === 'groq' && 'Get your API key from console.groq.com'}
                {config.provider === 'gemini' && 'Get your API key from ai.google.dev'}
              </div>
            </div>
          )}

          {/* Advanced Settings */}
          <div className="config-section">
            <button
              type="button"
              className="advanced-settings-toggle"
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              disabled={disabled}
            >
              <span className="toggle-icon">{advancedExpanded ? '▼' : '▶'}</span>
              Advanced Settings
            </button>
          </div>

          {advancedExpanded && (
            <div className="config-advanced">
              <div className="config-section">
                <label className="config-label">
                  Max Tokens
                  <input
                    type="number"
                    className="config-input"
                    value={config.maxTokens || ''}
                    onChange={(e) => onChange({ ...config, maxTokens: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                    placeholder="e.g., 4096"
                    disabled={disabled}
                  />
                </label>
              </div>
              <div className="config-section">
                <label className="config-label">
                  Max Text Length
                  <input
                    type="number"
                    className="config-input"
                    value={config.maxTextLength || ''}
                    onChange={(e) => onChange({ ...config, maxTextLength: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                    placeholder="e.g., 4096"
                    disabled={disabled}
                  />
                </label>
                <div className="config-hint">
                  Maximum characters to send to LLM for file classification
                </div>
              </div>
              {config.provider === 'embedded' && (
                <>
                  <div className="config-section">
                    <label className="config-label">
                      Context Length
                      <input
                        type="number"
                        className="config-input"
                        value={embeddedOptions.contextLength ?? ''}
                        onChange={(e) =>
                          updateEmbeddedOptions({
                            contextLength: e.target.value ? parseInt(e.target.value, 10) : undefined,
                          })
                        }
                        placeholder="e.g., 512 (max 2048 for stability)"
                        disabled={disabled}
                      />
                    </label>
                    <div className="config-hint">
                      Lower values (512-1024) use less memory and are more stable. Max 2048.
                    </div>
                  </div>
                  <div className="config-section">
                    <label className="config-label">
                      GPU Layers ⚡ (IMPORTANT for speed!)
                      <input
                        type="number"
                        className="config-input"
                        value={embeddedOptions.gpuLayers ?? ''}
                        onChange={(e) =>
                          updateEmbeddedOptions({
                            gpuLayers: e.target.value ? parseInt(e.target.value, 10) : undefined,
                          })
                        }
                        placeholder="e.g., 33 for full GPU"
                        disabled={disabled}
                      />
                    </label>
                    <div className="config-hint">
                      ⚠️ CPU-only (0) is VERY slow (~3s per token). Use 33+ for GPU acceleration on Apple Silicon/NVIDIA. 
                      Recommended: 33 for 0.5B models, adjust based on your GPU memory.
                    </div>
                  </div>
                  <div className="config-section">
                    <label className="config-label">
                      Seed (optional)
                      <input
                        type="number"
                        className="config-input"
                        value={embeddedOptions.seed ?? ''}
                        onChange={(e) =>
                          updateEmbeddedOptions({
                            seed: e.target.value ? parseInt(e.target.value, 10) : undefined,
                          })
                        }
                        placeholder="Random if omitted"
                        disabled={disabled}
                      />
                    </label>
                  </div>
                  <div className="config-section">
                    <label className="config-label">
                      Temperature
                      <input
                        type="number"
                        step="0.05"
                        className="config-input"
                        value={embeddedOptions.temperature ?? ''}
                        onChange={(e) =>
                          updateEmbeddedOptions({
                            temperature: e.target.value ? parseFloat(e.target.value) : undefined,
                          })
                        }
                        placeholder="e.g., 0.2"
                        disabled={disabled}
                      />
                    </label>
                  </div>
                  <div className="config-section">
                    <label className="config-label">
                      Top P
                      <input
                        type="number"
                        step="0.05"
                        className="config-input"
                        value={embeddedOptions.topP ?? ''}
                        onChange={(e) =>
                          updateEmbeddedOptions({
                            topP: e.target.value ? parseFloat(e.target.value) : undefined,
                          })
                        }
                        placeholder="e.g., 0.9"
                        disabled={disabled}
                      />
                    </label>
                  </div>
                </>
              )}
              <div className="config-section">
                <label className="config-label">
                  System Message
                  <textarea
                    className="config-textarea"
                    value={config.systemMessage || ''}
                    onChange={(e) => onChange({ ...config, systemMessage: e.target.value })}
                    placeholder="e.g., You are a helpful assistant."
                    rows={3}
                    disabled={disabled}
                  />
                </label>
              </div>
              <div className="config-section">
                <label className="config-label">
                  Custom Headers (JSON)
                  <textarea
                    className={`config-textarea ${!isCustomHeadersValid ? 'input-error' : ''}`}
                    value={customHeadersText}
                    onChange={(e) => {
                      const newText = e.target.value;
                      setCustomHeadersText(newText);
                      try {
                        const headers = newText ? JSON.parse(newText) : undefined;
                        onChange({ ...config, customHeaders: headers });
                        setIsCustomHeadersValid(true);
                      } catch {
                        setIsCustomHeadersValid(false);
                      }
                    }}
                    placeholder='{"Authorization": "Bearer token"}'
                    rows={3}
                    disabled={disabled}
                  />
                </label>
              </div>
            </div>
          )}

          {/* Test Connection */}
          {onTest && (
            <div className="config-section">
              <button
                type="button"
                className="test-button"
                onClick={handleTestConnection}
                disabled={disabled || testStatus === 'testing'}
              >
                {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
              </button>
              {testMessage && (
                <div className={`test-message ${testStatus}`}>
                  {testMessage}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
