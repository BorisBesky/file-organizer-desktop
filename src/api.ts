// LLM Provider Configuration Types
export type LLMProviderType = 'lmstudio' | 'ollama' | 'openai' | 'anthropic' | 'groq' | 'gemini' | 'custom';

export interface LLMConfig {
  provider: LLMProviderType;
  baseUrl: string;
  apiKey?: string; // Optional for local providers
  model: string;
  maxTokens?: number;
  systemMessage?: string;
  customHeaders?: Record<string, string>;
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
};

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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.customHeaders,
  };

  if (config.apiKey) {
    if (config.provider === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (config.provider === 'gemini') {
      // Gemini uses API key in URL, not in headers
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

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
  const prompt = `${promptTemplate}\n\nOriginal filename: ${originalName}\nContent (truncated to 4000 chars):\n${text.slice(0, 4000)}${hint}`;

  const systemMessage = config.systemMessage || 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).';
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, prompt, systemMessage);

  // Debug logging
  console.log('LLM Request:', {
    provider: config.provider,
    endpoint,
    headers,
    bodyPreview: { model: config.model, messageCount: body.messages?.length }
  });

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (fetchError: any) {
    console.error('Fetch error:', fetchError);
    throw new Error(`Network error connecting to ${config.provider} at ${endpoint}: ${fetchError.message || 'Connection failed'}`);
  }

  console.log('LLM Response:', { status: resp.status, ok: resp.ok });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`${config.provider} API error: ${resp.status} ${resp.statusText}\n${errorText}`);
  }

  // Parse the response text as JSON
  let data;
  try {
    data = await resp.json();
  } catch (parseError: any) {
    throw new Error(`Failed to parse response from ${config.provider}: ${parseError.message}`);
  }

  const content = extractContent(config, data);
  return safeParseJson(content, () => ({
    category_path: 'uncategorized',
    suggested_filename: originalName.replace(/\.[^/.]+$/, ''),
    confidence: 0,
  }));
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
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, promptTemplate, systemMessage);

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (fetchError: any) {
    throw new Error(`Network error connecting to ${config.provider} at ${endpoint}: ${fetchError.message || 'Connection failed'}`);
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`${config.provider} API error: ${resp.status} ${resp.statusText}\n${errorText}`);
  }
  
  // Parse the response text as JSON
  let data;
  try {
    data = await resp.json();
  } catch (parseError: any) {
    throw new Error(`Failed to parse response from ${config.provider}: ${parseError.message}`);
  }

  const content = extractContent(config, data);
  return safeParseJson(content, () => ({ optimizations: [] }));
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
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Ollama error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
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
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LM Studio error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
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
