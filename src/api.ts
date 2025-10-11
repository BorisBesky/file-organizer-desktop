import { invoke } from '@tauri-apps/api/tauri';
import { debugLogger } from './debug-logger';

// Helper function to make HTTP requests via Tauri backend (bypasses CORS)
async function tauriFetch(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body?: any;
}): Promise<{ ok: boolean; status: number; data: string }> {
  try {
    const bodyString = options.body ? JSON.stringify(options.body) : undefined;
    const text = await invoke<string>('http_request', {
      url,
      method: options.method,
      headers: options.headers,
      body: bodyString,
    });
    return { ok: true, status: 200, data: text };
  } catch (error: any) {
    // Parse error message to extract status code if present
    const errorMessage = error?.toString() || String(error);
    const statusMatch = errorMessage.match(/HTTP (\d+):/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 500;
    return { ok: false, status, data: errorMessage };
  }
}

// LLM Provider Configuration Types
export type LLMProviderType =
  | 'lmstudio'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'gemini'
  | 'custom'
  | 'embedded';

export interface EmbeddedLLMOptions {
  modelPath: string;
  contextLength?: number;
  gpuLayers?: number;
  seed?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface LLMConfig {
  provider: LLMProviderType;
  baseUrl: string;
  apiKey?: string; // Optional for local providers
  model: string;
  maxTokens?: number;
  maxTextLength?: number; // Maximum characters to send to LLM for classification
  systemMessage?: string;
  customHeaders?: Record<string, string>;
  embeddedOptions?: EmbeddedLLMOptions;
}

export const DEFAULT_CONFIGS: Record<LLMProviderType, Partial<LLMConfig>> = {
  lmstudio: {
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    model: 'local-model',
  },
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-r1:8b',
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4-turbo-preview',
  },
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
  },
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai',
    model: 'llama-3.1-70b-versatile',
  },
  gemini: {
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash-exp',
  },
  custom: {
    provider: 'custom',
    baseUrl: '',
    model: '',
  },
  embedded: {
    provider: 'embedded',
    baseUrl: 'embedded://local',
    model: 'qwen2.5-0.5b-instruct',
    embeddedOptions: {
      modelPath: '',
      contextLength: 512,  // Small context for single-file classification (not accumulating)
      gpuLayers: 999,      // Offload all layers to GPU (use 999 for "all available")
      maxTokens: 150,      // Enough for JSON response with category/filename
      temperature: 0.2,
      topP: 0.9,
    },
    maxTokens: 150,
  },
};

export interface EmbeddedDownloadState {
  id: string;
  url: string;
  target_path: string;
  bytes_downloaded: number;
  total_bytes: number | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string | null;
}

export interface EmbeddedServiceStatus {
  base_url: string;
  ready: boolean;
  model?: string | null;
  uptime_s: number;
  downloads: EmbeddedDownloadState[];
}

export interface EmbeddedLoadResponse {
  loaded: boolean;
  model_path: string;
  stats: {
    load_ms: number;
    context_length?: number | null;
  };
}

export interface EmbeddedInferResponse {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
}

export async function getEmbeddedLLMStatus(): Promise<EmbeddedServiceStatus | null> {
  try {
    const status = await invoke<EmbeddedServiceStatus>('embedded_llm_service_status');
    return status;
  } catch (error) {
    debugLogger.warn('EMBEDDED_STATUS', 'Failed to fetch embedded LLM status', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function loadEmbeddedModel(options: EmbeddedLLMOptions): Promise<EmbeddedLoadResponse> {
  if (!options.modelPath) {
    throw new Error('Embedded model path is required');
  }

  const payload: Record<string, unknown> = {
    model_path: options.modelPath,
  };

  if (options.contextLength !== undefined) {
    payload.context_length = options.contextLength;
  }
  if (options.gpuLayers !== undefined) {
    payload.gpu_layers = options.gpuLayers;
  }
  if (options.seed !== undefined) {
    payload.seed = options.seed;
  }

  return invoke<EmbeddedLoadResponse>('embedded_llm_load', { config: payload });
}

export async function inferEmbeddedModel(options: {
  prompt: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}): Promise<EmbeddedInferResponse> {
  const payload: Record<string, unknown> = {
    prompt: options.prompt,
  };

  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.topP !== undefined) {
    payload.top_p = options.topP;
  }
  if (options.maxTokens !== undefined) {
    payload.max_tokens = options.maxTokens;
  }

  return invoke<EmbeddedInferResponse>('embedded_llm_infer', { args: payload });
}

export interface EmbeddedDownloadRequest {
  url: string;
  targetName?: string;
  sha256?: string;
}

export interface EmbeddedDownloadResponse {
  id: string;
  started: boolean;
}

export async function startEmbeddedDownload(options: EmbeddedDownloadRequest): Promise<EmbeddedDownloadResponse> {
  return invoke<EmbeddedDownloadResponse>('embedded_llm_download', {
    request: {
      url: options.url,
      target_name: options.targetName,
      sha256: options.sha256,
    },
  });
}

// Cache for last loaded model path to avoid redundant checks
let lastLoadedModelPath: string | null = null;

// Export function to clear the cache when switching providers/models
export function clearEmbeddedModelCache(): void {
  lastLoadedModelPath = null;
  debugLogger.info('EMBEDDED_SERVICE', 'Cleared embedded model cache');
}

async function ensureEmbeddedModelLoaded(config: LLMConfig): Promise<EmbeddedLLMOptions> {
  const embedded = config.embeddedOptions;
  if (!embedded || !embedded.modelPath) {
    throw new Error('Embedded provider requires a model path');
  }

  // Normalize paths for comparison (resolve to absolute paths and normalize separators)
  const normalizeModelPath = (path: string | null | undefined): string => {
    if (!path) return '';
    // Remove trailing slashes and normalize path separators
    return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  };
  
  const configModelPath = normalizeModelPath(embedded.modelPath);
  
  // Fast path: if we've already loaded this exact model path, skip the status check
  if (lastLoadedModelPath && lastLoadedModelPath === configModelPath) {
    debugLogger.debug('EMBEDDED_SERVICE', 'Model already loaded (cached), skipping check', {
      modelPath: embedded.modelPath,
    });
    return embedded;
  }

  // Check actual status from backend
  const status = await getEmbeddedLLMStatus();
  const statusModelPath = normalizeModelPath(status?.model);
  
  debugLogger.info('EMBEDDED_CHECK', 'Checking embedded model status', {
    statusReady: status?.ready,
    statusModelPath,
    configModelPath,
    pathsMatch: statusModelPath === configModelPath,
    needsLoad: !status || !status.ready || statusModelPath !== configModelPath,
    cachedPath: lastLoadedModelPath,
  });
  
  if (!status || !status.ready || statusModelPath !== configModelPath) {
    debugLogger.info('EMBEDDED_SERVICE', 'Loading embedded model', {
      reason: !status ? 'no status' : !status.ready ? 'not ready' : 'path mismatch',
      modelPath: embedded.modelPath,
      contextLength: embedded.contextLength,
      gpuLayers: embedded.gpuLayers,
    });

    try {
      await loadEmbeddedModel(embedded);
      // Update cache after successful load
      lastLoadedModelPath = configModelPath;
      debugLogger.info('EMBEDDED_SERVICE', 'Model loaded successfully', {
        modelPath: embedded.modelPath,
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      debugLogger.error('EMBEDDED_SERVICE', 'Failed to load embedded model', { message });
      throw new Error(`Failed to load embedded model: ${message}`);
    }
  } else {
    // Model is already loaded in backend, update our cache
    lastLoadedModelPath = configModelPath;
    debugLogger.debug('EMBEDDED_SERVICE', 'Model already loaded in backend, skipping load', {
      modelPath: embedded.modelPath,
    });
  }

  return embedded;
}

async function runEmbeddedCompletion(
  config: LLMConfig,
  prompt: string,
  overrides?: { temperature?: number; topP?: number; maxTokens?: number },
): Promise<EmbeddedInferResponse> {
  const embedded = await ensureEmbeddedModelLoaded(config);
  const temperature = overrides?.temperature ?? embedded.temperature ?? 0.2;
  const topP = overrides?.topP ?? embedded.topP;
  const maxTokens = overrides?.maxTokens ?? embedded.maxTokens ?? config.maxTokens ?? 256;

  // Limit prompt length to prevent context overflow
  // Using conservative estimate: ~3 chars per token
  const contextLength = embedded.contextLength ?? 512;
  const maxPromptChars = Math.min(contextLength * 3, 4096);
  const truncatedPrompt = prompt.length > maxPromptChars 
    ? prompt.substring(0, maxPromptChars)
    : prompt;

  if (prompt.length > maxPromptChars) {
    debugLogger.warn('EMBEDDED_LLM', 'Prompt truncated', {
      originalLength: prompt.length,
      truncatedLength: truncatedPrompt.length,
      contextLength,
    });
  }

  return inferEmbeddedModel({
    prompt: truncatedPrompt,
    temperature,
    topP,
    maxTokens,
  });
}

// Helper functions for multi-provider support
function getCompletionEndpoint(config: LLMConfig): string {
  const base = config.baseUrl.replace(/\/$/, '');
  
  switch (config.provider) {
    case 'ollama':
      return `${base}/api/chat`;
    case 'anthropic':
      return `${base}/v1/messages`;
    case 'gemini':
      // Gemini uses API key in URL
      return `${base}/v1beta/models/${config.model}:generateContent?key=${config.apiKey || ''}`;
    case 'openai':
    case 'groq':
    case 'lmstudio':
    default:
      return `${base}/v1/chat/completions`;
  }
}

function buildHeaders(config: LLMConfig): Record<string, string> {
  debugLogger.debug('BUILD_HEADERS', 'Building headers', {
    provider: config.provider,
    hasApiKey: !!config.apiKey,
    hasCustomHeaders: !!config.customHeaders,
    customHeaderKeys: config.customHeaders ? Object.keys(config.customHeaders) : [],
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Set default authentication headers based on provider
  if (config.apiKey) {
    if (config.provider === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      debugLogger.debug('BUILD_HEADERS', 'Added Anthropic headers', {
        hasXApiKey: true,
        anthropicVersion: '2023-06-01',
      });
    } else if (config.provider === 'gemini') {
      // Gemini uses API key in URL, not in headers
      debugLogger.debug('BUILD_HEADERS', 'Gemini provider - API key in URL', {});
    } else {
      // Default to Bearer token for OpenAI-compatible APIs
      headers['Authorization'] = `Bearer ${config.apiKey}`;
      debugLogger.debug('BUILD_HEADERS', 'Added Bearer authorization', {
        authHeaderSet: true,
        authPrefix: 'Bearer',
      });
    }
  }

  // Apply custom headers last so they can override defaults
  if (config.customHeaders) {
    debugLogger.debug('BUILD_HEADERS', 'Applying custom headers', {
      customHeaderKeys: Object.keys(config.customHeaders),
      willOverrideAuth: 'Authorization' in config.customHeaders,
    });
    
    // Smart merge: If custom Authorization header doesn't have Bearer prefix, add it
    const customHeaders = { ...config.customHeaders };
    if (customHeaders['Authorization'] && typeof customHeaders['Authorization'] === 'string') {
      const authValue = customHeaders['Authorization'];
      // Only add Bearer if it's not already there and looks like a raw token
      if (!authValue.toLowerCase().startsWith('bearer ') && 
          !authValue.toLowerCase().startsWith('basic ') &&
          authValue.length > 10) {
        customHeaders['Authorization'] = `Bearer ${authValue}`;
        debugLogger.debug('BUILD_HEADERS', 'Auto-added Bearer prefix to custom Authorization', {
          originalLength: authValue.length,
          hadBearer: false,
        });
      }
    }
    
    Object.assign(headers, customHeaders);
  }

  debugLogger.debug('BUILD_HEADERS', 'Final headers built', {
    headers,
    headerKeys: Object.keys(headers),
  });

  return headers;
}

function buildRequestBody(config: LLMConfig, prompt: string, systemMessage: string): any {
  const finalSystemMessage = config.systemMessage ?? systemMessage;

  switch (config.provider) {
    case 'ollama':
      return {
        model: config.model,
        messages: [
          { role: 'system', content: finalSystemMessage },
          { role: 'user', content: prompt },
        ],
        stream: false,
      };
    
    case 'anthropic':
      return {
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        system: finalSystemMessage,
        messages: [
          { role: 'user', content: prompt },
        ],
      };
    
    case 'gemini':
      return {
        contents: [
          {
            parts: [
              { text: `${finalSystemMessage}\n\n${prompt}` }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: config.maxTokens ?? 4096,
        },
      };
    
    default: // OpenAI-compatible (openai, groq, lmstudio, custom)
      const body: Record<string, any> = {
        model: config.model,
        messages: [
          { role: 'system', content: finalSystemMessage },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        stream: false,
      };
      if (config.provider !== 'lmstudio') {
        body.max_tokens = config.maxTokens ?? 4096;
      }
      return body;
  }
}

export function normalizeOllamaContent(rawContent: unknown): string {
  const extractText = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map((item) => extractText(item)).join('');
    }
    if (typeof value === 'object') {
      const maybeRecord = value as Record<string, unknown>;
      const type = typeof maybeRecord.type === 'string' ? maybeRecord.type.toLowerCase() : undefined;
      if (type && ['thinking', 'reasoning', 'metadata'].includes(type)) {
        return '';
      }
      if (typeof maybeRecord.text === 'string') return maybeRecord.text;
      if (maybeRecord.content !== undefined) return extractText(maybeRecord.content);
      if (typeof maybeRecord.value === 'string') return maybeRecord.value;
    }
    return '';
  };

  const stripThinking = (value: string): string =>
    value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const flattened = extractText(rawContent);
  const cleaned = stripThinking(flattened);
  return cleaned || '{}';
}

function safeParseJson<T>(payload: string, fallback: () => T): T {
  try {
    return JSON.parse(payload) as T;
  } catch (primaryError) {
    try {
      const match = payload.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]) as T;
      }
    } catch (secondaryError) {
      // Intentionally swallow and use fallback
    }
  }
  return fallback();
}

function extractContent(config: LLMConfig, data: any): string {
  let rawContent: unknown;

  switch (config.provider) {
    case 'ollama':
      rawContent = data?.message?.content;
      break;
    case 'anthropic':
      rawContent = data?.content?.[0]?.text ?? data?.content;
      break;
    case 'gemini':
      rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      break;
    default:
      rawContent = data?.choices?.[0]?.message?.content;
      break;
  }

  return normalizeOllamaContent(rawContent);
}

// Unified function that works with any LLM provider
export async function classifyViaLLM(opts: {
  config: LLMConfig,
  text: string,
  originalName: string,
  categoriesHint: string[],
}): Promise<{ category_path: string; suggested_filename: string; confidence: number; raw?: any }>{
  const { config, text, originalName, categoriesHint } = opts;
  
  const promptTemplate =
    "You are a file organizer. Given the text content of a file, 1) classify it into a category path with up to 3 levels like 'medical/bills' or 'finance/taxes'. 2) suggest a concise filename base (no extension) that includes provider/company and date if present. Reply in strict JSON with keys: category_path, suggested_filename, confidence (0-1).";

  const hint = categoriesHint?.length ? `\n\nExisting categories (prefer one of these if appropriate):\n- ${categoriesHint.join('\n- ')}` : '';
  const maxTextLength = config.maxTextLength || 4096;
  const prompt = `${promptTemplate}\n\nOriginal filename: ${originalName}\nContent (truncated to ${maxTextLength} chars):\n${text.slice(0, maxTextLength)}${hint}`;

  const systemMessage = config.systemMessage || 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).';
  const fallback = () => ({
    category_path: 'uncategorized',
    suggested_filename: originalName.replace(/\.[^/.]+$/, ''),
    confidence: 0,
  });

  if (config.provider === 'embedded') {
    const combinedPrompt = `${systemMessage}\n\n${prompt}`;
    debugLogger.info('EMBEDDED_LLM', 'Running embedded classification', {
      modelPath: config.embeddedOptions?.modelPath,
      promptLength: combinedPrompt.length,
    });

    const result = await runEmbeddedCompletion(config, combinedPrompt, {
      temperature: config.embeddedOptions?.temperature,
      topP: config.embeddedOptions?.topP,
      maxTokens: config.maxTokens ?? config.embeddedOptions?.maxTokens,
    });

    const parsed = safeParseJson(result.content, fallback);
    return {
      ...parsed,
      raw: {
        provider: 'embedded',
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        latency_ms: result.latency_ms,
      },
    };
  }
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, prompt, systemMessage);

  // Comprehensive debug logging
  debugLogger.info('LLM_REQUEST', 'Preparing LLM request', {
    provider: config.provider,
    endpoint,
    model: config.model,
    hasApiKey: !!config.apiKey,
    hasCustomHeaders: !!config.customHeaders,
    customHeaderKeys: config.customHeaders ? Object.keys(config.customHeaders) : [],
  });

  debugLogger.debug('LLM_REQUEST', 'Request headers', { headers });
  debugLogger.debug('LLM_REQUEST', 'Request body preview', {
    model: body.model,
    messageCount: body.messages?.length,
    systemMessage: body.messages?.[0]?.content?.substring(0, 100),
  });

  let resp;
  try {
    debugLogger.debug('LLM_REQUEST', 'Calling tauriFetch', { endpoint, method: 'POST' });
    resp = await tauriFetch(endpoint, {
      method: 'POST',
      headers,
      body,
    });
    debugLogger.info('LLM_RESPONSE', 'Received response', { status: resp.status, ok: resp.ok });
  } catch (fetchError: any) {
    debugLogger.error('LLM_REQUEST', 'Fetch error', {
      error: fetchError?.message || String(fetchError),
      stack: fetchError?.stack,
    });
    throw new Error(`Network error connecting to ${config.provider} at ${endpoint}: ${fetchError.message || 'Connection failed'}`);
  }

  if (!resp.ok) {
    debugLogger.error('LLM_RESPONSE', 'API returned error status', {
      status: resp.status,
      provider: config.provider,
      errorData: resp.data,
    });
    throw new Error(`${config.provider} API error: ${resp.status}\n${resp.data}`);
  }

  // Parse the response text as JSON
  let data;
  try {
    debugLogger.debug('LLM_RESPONSE', 'Parsing response JSON', {
      dataPreview: resp.data.substring(0, 200),
    });
    data = JSON.parse(resp.data);
    debugLogger.debug('LLM_RESPONSE', 'Successfully parsed JSON', {
      hasChoices: Array.isArray(data?.choices),
      choiceCount: data?.choices?.length,
    });
  } catch (parseError: any) {
    debugLogger.error('LLM_RESPONSE', 'Failed to parse JSON', {
      error: parseError.message,
      rawData: resp.data.substring(0, 500),
    });
    throw new Error(`Failed to parse response from ${config.provider}: ${parseError.message}`);
  }

  const content = extractContent(config, data);
  return safeParseJson(content, fallback);
}

// Backward compatibility wrapper for LM Studio
export async function classifyViaLMStudio(opts: {
  baseUrl: string,
  model: string,
  text: string,
  originalName: string,
  categoriesHint: string[],
}): Promise<{ category_path: string; suggested_filename: string; confidence: number; raw?: any }>{
  return classifyViaLLM({
    config: {
      provider: 'lmstudio',
      baseUrl: opts.baseUrl,
      model: opts.model,
    },
    text: opts.text,
    originalName: opts.originalName,
    categoriesHint: opts.categoriesHint,
  });
}

export async function optimizeCategoriesViaLLM(opts: {
  config: LLMConfig,
  directoryTree: { [category: string]: string[] },
}): Promise<{ optimizations: { from: string; to: string; reason: string }[] }> {
  const { config, directoryTree } = opts;
  
  const treeText = Object.entries(directoryTree)
    .map(([category, files]) => `${category}/ (${files.length} files)\n  - ${files.slice(0, 5).join('\n  - ')}${files.length > 5 ? `\n  - ... and ${files.length - 5} more` : ''}`)
    .join('\n\n');

  const promptTemplate = `You are a file organization optimizer. Analyze this directory structure and suggest optimizations to merge similar categories or reorganize files for better structure.

Focus on:
1. Merging categories with similar meanings (e.g., "finance" and "financial", "medical" and "health")
2. Consolidating subcategories that are too granular
3. Improving category naming consistency
4. Reducing redundant categories

Reply in strict JSON with key "optimizations" containing an array of objects with keys: "from" (current category), "to" (suggested category), "reason" (explanation).

Current directory structure:
${treeText}`;

  const systemMessage = config.systemMessage || 'Return only valid JSON (no markdown), with key "optimizations" containing an array of optimization suggestions.';

  if (config.provider === 'embedded') {
    const combinedPrompt = `${systemMessage}\n\n${promptTemplate}`;
    const result = await runEmbeddedCompletion(config, combinedPrompt, {
      temperature: config.embeddedOptions?.temperature,
      topP: config.embeddedOptions?.topP,
      maxTokens: config.maxTokens ?? config.embeddedOptions?.maxTokens,
    });
    return safeParseJson(result.content, () => ({ optimizations: [] }));
  }
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, promptTemplate, systemMessage);

  let resp;
  try {
    resp = await tauriFetch(endpoint, {
      method: 'POST',
      headers,
      body,
    });
  } catch (fetchError: any) {
    throw new Error(`Network error connecting to ${config.provider} at ${endpoint}: ${fetchError.message || 'Connection failed'}`);
  }

  if (!resp.ok) {
    throw new Error(`${config.provider} API error: ${resp.status}\n${resp.data}`);
  }
  
  // Parse the response text as JSON
  let data;
  try {
    data = JSON.parse(resp.data);
  } catch (parseError: any) {
    throw new Error(`Failed to parse response from ${config.provider}: ${parseError.message}`);
  }

  const content = extractContent(config, data);
  return safeParseJson(content, () => ({ optimizations: [] }));
}

// Open a file using the operating system's default application
export async function openFile(path: string): Promise<void> {
  try {
    await invoke('open_file', { path });
  } catch (error: any) {
    throw new Error(`Failed to open file: ${error.message || String(error)}`);
  }
}

// Backward compatibility wrapper for LM Studio
export async function optimizeCategoriesViaLMStudio(opts: {
  baseUrl: string,
  model: string,
  directoryTree: { [category: string]: string[] },
}): Promise<{ optimizations: { from: string; to: string; reason: string }[] }> {
  return optimizeCategoriesViaLLM({
    config: {
      provider: 'lmstudio',
      baseUrl: opts.baseUrl,
      model: opts.model,
    },
    directoryTree: opts.directoryTree,
  });
}

// Helpers to list available local models for Ollama and LM Studio
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/$/, '') + '/api/tags';
  try {
    const resp = await tauriFetch(url, { method: 'GET', headers: {} });
    if (!resp.ok) {
      throw new Error(`Ollama error ${resp.status}: ${resp.data}`);
    }
    const data = JSON.parse(resp.data);
    // Ollama returns { models: [...] } where each model has a `name` property
    if (data && Array.isArray(data.models)) {
      return data.models.map((m: any) => m.name || String(m));
    }
    return [];
  } catch (e) {
    console.warn('Failed to list Ollama models', e);
    return [];
  }
}

export async function listLMStudioModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/$/, '') + '/v1/models';
  try {
    const resp = await tauriFetch(url, { method: 'GET', headers: {} });
    if (!resp.ok) {
      throw new Error(`LM Studio error ${resp.status}: ${resp.data}`);
    }
    const data = JSON.parse(resp.data);
    // LM Studio returns { data: [...] } where each model has an `id` property
    if (data && Array.isArray(data.data)) {
      return data.data.map((m: any) => m.id || String(m));
    }
    return [];
  } catch (e) {
    console.warn('Failed to list LM Studio models', e);
    return [];
  }
}
