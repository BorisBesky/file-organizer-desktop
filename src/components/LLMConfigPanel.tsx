import React, { useState, useEffect } from 'react';
import { LLMConfig, LLMProviderType, DEFAULT_CONFIGS, listOllamaModels, listLMStudioModels, getManagedLLMServerStatus, startManagedLLMServer, stopManagedLLMServer, getManagedLLMServerInfo } from '../api';
import { ManagedLLMServerInfo, ManagedLLMConfig } from '../types';
import ManagedLLMDialog from './ManagedLLMDialog';
import { debugLogger } from '../debug-logger';
import { platform } from '@tauri-apps/api/os';

interface LLMConfigPanelProps {
  config: LLMConfig;
  onChange: (config: LLMConfig) => void;
  onTest?: () => Promise<void>;
  disabled?: boolean;
  providerConfigs?: Record<string, LLMConfig>;
  onLoadProviderConfig?: (provider: string) => void;
  managedLLMConfig?: ManagedLLMConfig;
  onManagedLLMConfigChange?: (config: ManagedLLMConfig) => void;
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
  'managed-local': {
    name: 'Managed Local LLM',
    description: 'Embedded local LLM server (auto-downloaded)',
    requiresApiKey: false,
  },
};

export default function LLMConfigPanel({ config, onChange, onTest, disabled, providerConfigs = {}, onLoadProviderConfig, managedLLMConfig, onManagedLLMConfigChange }: LLMConfigPanelProps) {
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
  
  // Managed LLM state
  const [managedLLMStatus, setManagedLLMStatus] = useState<ManagedLLMServerInfo | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [serverConfigExpanded, setServerConfigExpanded] = useState(false);
  const [envVars, setEnvVars] = useState<Array<{key: string, value: string}>>([]);

  useEffect(() => {
    const newHeadersText = config.customHeaders ? JSON.stringify(config.customHeaders, null, 2) : '';
    setCustomHeadersText(newHeadersText);
  }, [config.customHeaders]);

  const currentProviderInfo = PROVIDER_INFO[config.provider];
  const defaultModel = (navigator.userAgent.includes('Mac') ? 'mlx-community/Phi-3.5-mini-instruct-4bit' : 'MaziyarPanahi/gemma-3-1b-it-GGUF');

  // Initialize managed LLM config if not provided
  const defaultManagedConfig: ManagedLLMConfig = {
    port: 8000,
    host: '127.0.0.1',
    model: defaultModel,
    log_level: 'info',
    env_vars: {}
  };

  const currentManagedConfig = managedLLMConfig || defaultManagedConfig;

  const loadManagedLLMStatus = React.useCallback(async () => {
    try {
      const status = await getManagedLLMServerStatus();
      setManagedLLMStatus(status);
      
      // Show download dialog if not downloaded
      if (status.status === 'not_downloaded') {
        setShowDownloadDialog(true);
      }
    } catch (error) {
      debugLogger.error('MANAGED_LLM', 'Failed to load managed LLM status', { error });
    }
  }, []);

  // Load managed LLM status when provider is managed-local and panel is expanded
  useEffect(() => {
    if (config.provider === 'managed-local' && isExpanded) {
      loadManagedLLMStatus();
      
      // Set up periodic status refresh to keep UI in sync
      const intervalId = setInterval(() => {
        loadManagedLLMStatus();
      }, 5000); // Refresh every 5 seconds
      
      // Cleanup: stop polling when provider changes, panel collapses, or component unmounts
      return () => {
        clearInterval(intervalId);
        debugLogger.debug('MANAGED_LLM', 'Stopped managed LLM status polling', {});
      };
    }
  }, [config.provider, isExpanded, loadManagedLLMStatus]);

  // Initialize env vars from config
  useEffect(() => {
    if (currentManagedConfig.env_vars) {
      const envArray = Object.entries(currentManagedConfig.env_vars).map(([key, value]) => ({ key, value }));
      setEnvVars(envArray);
    }
  }, [currentManagedConfig.env_vars]);

  const handleStartServer = async () => {
    try {
      await startManagedLLMServer(currentManagedConfig);
      await loadManagedLLMStatus();
    } catch (error: any) {
      debugLogger.error('MANAGED_LLM', 'Failed to start server', { error });
      setTestMessage(`Failed to start server: ${error.message}`);
    }
  };

  const handleStopServer = async () => {
    try {
      await stopManagedLLMServer();
      await loadManagedLLMStatus();
    } catch (error: any) {
      debugLogger.error('MANAGED_LLM', 'Failed to stop server', { error });
      setTestMessage(`Failed to stop server: ${error.message}`);
    }
  };

  const updateManagedConfig = (updates: Partial<ManagedLLMConfig>) => {
    if (onManagedLLMConfigChange) {
      onManagedLLMConfigChange({ ...currentManagedConfig, ...updates });
    }
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }]);
  };

  const removeEnvVar = (index: number) => {
    const newEnvVars = envVars.filter((_, i) => i !== index);
    setEnvVars(newEnvVars);
    updateManagedConfig({ 
      env_vars: Object.fromEntries(newEnvVars.map(env => [env.key, env.value]).filter(([key]) => key)) 
    });
  };

  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    const newEnvVars = [...envVars];
    newEnvVars[index][field] = value;
    setEnvVars(newEnvVars);
    updateManagedConfig({ 
      env_vars: Object.fromEntries(newEnvVars.map(env => [env.key, env.value]).filter(([key]) => key)) 
    });
  };

  const handleProviderChange = (provider: LLMProviderType) => {
    // Check if we have a saved config for this provider
    const savedConfig = providerConfigs[provider];
    
    if (savedConfig && onLoadProviderConfig) {
      // Load the saved config for this provider
      onLoadProviderConfig(provider);
    } else {
      // Use default config for this provider
      const defaultConfig = DEFAULT_CONFIGS[provider];
      onChange({
        ...config,
        provider,
        baseUrl: defaultConfig.baseUrl || config.baseUrl,
        model: defaultConfig.model || config.model,
        apiKey: provider === config.provider ? config.apiKey : undefined,
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
    <div className={`llm-config-panel ${isExpanded ? 'expanded' : ''}`}>
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
                <span style={{ color: '#007aff', fontWeight: '500' }}> • Saved configuration</span>
              )}
            </div>
          </div>

          {/* Configuration Fields */}
          {config.provider !== 'managed-local' && (
            <>
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

            <div className="config-section">
              <label className="config-label">
                Model
                {config.provider === 'ollama' || config.provider === 'lmstudio' ? (
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
            </>
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
              <div className="config-section">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={config.supportsVision || false}
                    onChange={(e) => onChange({ ...config, supportsVision: e.target.checked })}
                    disabled={disabled}
                  />
                  Supports Vision (Image Analysis)
                </label>
                <div className="config-hint">
                  Enable if your model supports image inputs (e.g., GPT-4 Vision, Claude 3, Gemini Vision)
                </div>
              </div>
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

          {/* Managed LLM Server Controls */}
          {config.provider === 'managed-local' && (
            <>
              {/* Server Status and Controls */}
              <div className="config-section">
                <h4>Server Status</h4>
                {managedLLMStatus && (
                  <div className="server-status">
                    <div className="status-indicator">
                      <span className={`status-badge status-${managedLLMStatus.status}`}>
                        {managedLLMStatus.status === 'running' ? '🟢 Running' : 
                         managedLLMStatus.status === 'stopped' ? '⚪ Stopped' :
                         managedLLMStatus.status === 'not_downloaded' ? '❌ Not Installed' :
                         managedLLMStatus.status === 'error' ? '🔴 Error' : '⚪ Unknown'}
                      </span>
                      {managedLLMStatus.version && (
                        <span className="version-info">v{managedLLMStatus.version}</span>
                      )}
                    </div>
                    {managedLLMStatus.port && (
                      <div className="server-info">
                        <strong>Port:</strong> {managedLLMStatus.port}
                        {managedLLMStatus.path && (
                          <>
                            <br />
                            <strong>Path:</strong> {managedLLMStatus.path}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                
                <div className="server-controls">
                  {managedLLMStatus?.status === 'not_downloaded' ? (
                    <button 
                      className="download-button"
                      onClick={() => setShowDownloadDialog(true)}
                      disabled={disabled}
                    >
                      Download Server
                    </button>
                  ) : (
                    <>
                      <button 
                        className="start-button"
                        onClick={handleStartServer}
                        disabled={disabled || managedLLMStatus?.status === 'running'}
                      >
                        Start Server
                      </button>
                      <button 
                        className="stop-button"
                        onClick={handleStopServer}
                        disabled={disabled || managedLLMStatus?.status !== 'running'}
                      >
                        Stop Server
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Server Configuration */}
              {managedLLMStatus?.status !== 'not_downloaded' && (
                <div className="config-section">
                  <button
                    type="button"
                    className="advanced-settings-toggle"
                    onClick={() => setServerConfigExpanded(!serverConfigExpanded)}
                    disabled={disabled}
                  >
                    <span className="toggle-icon">{serverConfigExpanded ? '▼' : '▶'}</span>
                    Server Configuration
                  </button>
                </div>
              )}

              {serverConfigExpanded && managedLLMStatus?.status !== 'not_downloaded' && (
                <div className="config-advanced">
                  <div className="config-section">
                    <label className="config-label">
                      Port
                      <input
                        type="number"
                        className="config-input"
                        value={currentManagedConfig.port}
                        onChange={(e) => {updateManagedConfig({ port: parseInt(e.target.value) || 8000 });
                          onChange({ ...config, baseUrl: "http://" + currentManagedConfig.host + ":" + (parseInt(e.target.value) || 8000) });
                        }}
                        disabled={disabled}
                      />
                    </label>
                  </div>
                  
                  <div className="config-section">
                    <label className="config-label">
                      Host
                      <input
                        type="text"
                        className="config-input"
                        value={currentManagedConfig.host}
                        onChange={(e) => {updateManagedConfig({ host: e.target.value });
                          onChange({ ...config, baseUrl: "http://" + e.target.value + ":" + currentManagedConfig.port });
                        }}
                        disabled={disabled}
                      />
                    </label>
                  </div>

                  <div className="config-section">
                    <label className="config-label">
                      Model
                      <input
                        type="text"
                        className="config-input"
                        value={currentManagedConfig.model || ''}
                        onChange={(e) => {updateManagedConfig({ model: e.target.value || undefined });
                          onChange({ ...config, model: e.target.value || '' });
                        }}
                        placeholder={`e.g., ${defaultModel}`}
                        disabled={disabled}
                      />
                    </label>
                    <div className="config-hint">
                      Hugging Face model ID to download automatically
                    </div>
                  </div>

                  <div className="config-section">
                    <label className="config-label">
                      Model Path (Optional)
                      <input
                        type="text"
                        className="config-input"
                        value={currentManagedConfig.model_path || ''}
                        onChange={(e) => updateManagedConfig({ model_path: e.target.value || undefined })}
                        placeholder="Path to local model file"
                        disabled={disabled}
                      />
                    </label>
                    <div className="config-hint">
                      Override model download with local file path
                    </div>
                  </div>

                  <div className="config-section">
                    <label className="config-label">
                      Log Level
                      <select
                        className="config-input"
                        value={currentManagedConfig.log_level}
                        onChange={(e) => updateManagedConfig({ log_level: e.target.value })}
                        disabled={disabled}
                      >
                        <option value="debug">Debug</option>
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="error">Error</option>
                      </select>
                    </label>
                  </div>

                </div>
              )}
            </>
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

      {/* Download Dialog */}
      <ManagedLLMDialog
        isOpen={showDownloadDialog}
        onClose={() => setShowDownloadDialog(false)}
        onDownloadComplete={() => {
          loadManagedLLMStatus();
        }}
      />
    </div>
  );
}
