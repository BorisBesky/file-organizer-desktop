import React, { useState, useEffect } from 'react';
import { LLMConfig, LLMProviderType, DEFAULT_CONFIGS, listOllamaModels, listLMStudioModels } from '../api';

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

  useEffect(() => {
    const newHeadersText = config.customHeaders ? JSON.stringify(config.customHeaders, null, 2) : '';
    setCustomHeadersText(newHeadersText);
  }, [config.customHeaders]);

  const currentProviderInfo = PROVIDER_INFO[config.provider];

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
                <span style={{ color: '#007aff', fontWeight: '500' }}> • Saved configuration</span>
              )}
            </div>
          </div>

          {/* Configuration Fields */}
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
