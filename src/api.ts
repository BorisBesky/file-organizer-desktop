// LLM Provider Configuration Types
export type LLMProviderType = 'lmstudio' | 'ollama' | 'openai' | 'anthropic' | 'groq' | 'custom';

export interface LLMConfig {
  provider: LLMProviderType;
  baseUrl: string;
  apiKey?: string; // Optional for local providers
  model: string;
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
    model: 'llama2',
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
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  return headers;
}

function buildRequestBody(config: LLMConfig, prompt: string, systemMessage: string): any {
  switch (config.provider) {
    case 'ollama':
      return {
        model: config.model,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt },
        ],
        stream: false,
      };
    
    case 'anthropic':
      return {
        model: config.model,
        max_tokens: 4096,
        system: systemMessage,
        messages: [
          { role: 'user', content: prompt },
        ],
      };
    
    default: // OpenAI-compatible (openai, groq, lmstudio, custom)
      return {
        model: config.model,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: -1,
        stream: false,
      };
  }
}

function extractContent(config: LLMConfig, data: any): string {
  switch (config.provider) {
    case 'ollama':
      return data?.message?.content ?? '{}';
    case 'anthropic':
      return data?.content?.[0]?.text ?? '{}';
    default:
      return data?.choices?.[0]?.message?.content ?? '{}';
  }
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

  const systemMessage = 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).';
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, prompt, systemMessage);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`${config.provider} API error: ${resp.status} ${resp.statusText}\n${errorText}`);
  }

  const data = await resp.json();
  const content = extractContent(config, data);
  
  try {
    return JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { category_path: 'uncategorized', suggested_filename: originalName.replace(/\.[^/.]+$/, ''), confidence: 0 };
  }
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

  const systemMessage = 'Return only valid JSON (no markdown), with key "optimizations" containing an array of optimization suggestions.';
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, promptTemplate, systemMessage);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`${config.provider} API error: ${resp.status} ${resp.statusText}\n${errorText}`);
  }
  
  const data = await resp.json();
  const content = extractContent(config, data);
  
  try {
    return JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { optimizations: [] };
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
