import { invoke } from '@tauri-apps/api/tauri';
import { debugLogger } from './debug-logger';
import { ManagedLLMServerInfo, ManagedLLMConfig } from './types';

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
export type LLMProviderType = 'lmstudio' | 'ollama' | 'openai' | 'anthropic' | 'groq' | 'gemini' | 'custom' | 'managed-local';

export interface LLMConfig {
  provider: LLMProviderType;
  baseUrl: string;
  apiKey?: string; // Optional for local providers
  model: string;
  maxTokens?: number;
  maxTextLength?: number; // Maximum characters to send to LLM for classification
  systemMessage?: string;
  customPrompt?: string; // Custom prompt template for file classification
  customCategoryPrompt?: string; // Custom prompt template for category optimization
  customHeaders?: Record<string, string>;
  supportsVision?: boolean; // Whether the model supports image inputs
}

export interface FileContent {
  text?: string;
  image_base64?: string;
  mime_type?: string;
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
  'managed-local': {
    provider: 'managed-local',
    baseUrl: 'http://127.0.0.1:8000',
    model: 'local-model',
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
    case 'managed-local':
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

function buildRequestBody(config: LLMConfig, prompt: string, systemMessage: string, imageData?: { base64: string; mimeType: string }): any {
  const finalSystemMessage = config.systemMessage ?? systemMessage;

  switch (config.provider) {
    case 'ollama':
      {
        const userMessage: any = { role: 'user', content: prompt };
        
        // Add image if present and model supports vision
        if (imageData && config.supportsVision) {
          userMessage.images = [imageData.base64];
        }
        
        return {
          model: config.model,
          messages: [
            { role: 'system', content: finalSystemMessage },
            userMessage,
          ],
          stream: false,
        };
      }
    
    case 'anthropic':
      {
        const contentParts: any[] = [];
        
        // Add image first if present and model supports vision
        if (imageData && config.supportsVision) {
          contentParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageData.mimeType,
              data: imageData.base64,
            },
          });
        }
        
        // Add text prompt
        contentParts.push({
          type: 'text',
          text: prompt,
        });
        
        return {
          model: config.model,
          max_tokens: config.maxTokens ?? 4096,
          system: finalSystemMessage,
          messages: [
            { role: 'user', content: contentParts },
          ],
        };
      }
    
    case 'gemini':
      {
        const parts: any[] = [];
        
        // Add image if present and model supports vision
        if (imageData && config.supportsVision) {
          parts.push({
            inline_data: {
              mime_type: imageData.mimeType,
              data: imageData.base64,
            },
          });
        }
        
        // Add text (combine system message and prompt for Gemini)
        parts.push({ text: `${finalSystemMessage}\n\n${prompt}` });
        
        return {
          contents: [
            { parts }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: config.maxTokens ?? 4096,
          },
        };
      }
    
    default: // OpenAI-compatible (openai, groq, lmstudio, custom)
      {
        const userContent: any[] = [];
        
        // Add image if present and model supports vision
        if (imageData && config.supportsVision) {
          userContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${imageData.mimeType};base64,${imageData.base64}`,
            },
          });
        }
        
        // Add text prompt
        userContent.push({
          type: 'text',
          text: prompt,
        });
        
        const body: Record<string, any> = {
          model: config.model,
          messages: [
            { role: 'system', content: finalSystemMessage },
            { role: 'user', content: userContent.length === 1 ? userContent[0].text : userContent },
          ],
          temperature: 0.2,
          stream: false,
        };
        body.max_tokens = config.maxTokens ?? 4096;
        return body;
      }
  }
}


/**
 * Normalizes heterogeneous "content" structures returned by different LLM providers
 * into a single plain string. It:
 * - Recursively extracts textual content from strings, arrays, and objects
 * - Skips known "thinking/reasoning/metadata" parts that shouldn't be surfaced
 * - Strips provider-specific <think>...</think> blocks (e.g., DeepSeek R1 style)
 * - Returns "{}" as a safe non-empty fallback (useful when the caller expects JSON)
 */
export function normalizeLLMContent(rawContent: unknown): string {
  /**
   * Recursively extract text from possible shapes:
   * - string: return as-is
   * - array: flatten by concatenation
   * - object: prefer .text; otherwise recurse into .content; or use .value
   * Skips objects whose .type is known to hold internal reasoning or metadata
   */
  const extractText = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
      // Flatten arrays of mixed content by concatenating their extracted text
      return value.map((item) => extractText(item)).join('');
    }

    if (typeof value === 'object') {
      const maybeRecord = value as Record<string, unknown>;

      // If object declares a content "type", filter out hidden/internal sections
      const type = typeof maybeRecord.type === 'string' ? maybeRecord.type.toLowerCase() : undefined;
      if (type && ['thinking', 'reasoning', 'metadata'].includes(type)) {
        return '';
      }

      // Common content carriers used by providers
      if (typeof maybeRecord.text === 'string') return maybeRecord.text;
      if (maybeRecord.content !== undefined) return extractText(maybeRecord.content);
      if (typeof maybeRecord.value === 'string') return maybeRecord.value;
    }

    return '';
  };

  /**
   * Remove provider-specific hidden reasoning blocks: <think> ... </think>
   * Seen in some reasoning models (e.g., DeepSeek R1). Case-insensitive, multiline-safe.
   */
  const stripThinking = (value: string): string =>
    value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 1) Flatten the raw provider content into a single string
  const flattened = extractText(rawContent);

  // 2) Strip any embedded hidden reasoning tags
  const cleaned = stripThinking(flattened);

  // 3) Provide a safe non-empty fallback to keep downstream JSON parsing paths stable
  return cleaned || '{}';
}

export function safeParseJson<T>(payload: string, fallback: () => T): T {
  try {
    return JSON.parse(payload) as T;
  } catch (primaryError) {
    try {
      const trimmed = payload.replace(/^```json\s*/, '') // Remove opening markdown
        .replace(/```[\s\S]*$/, '') // Remove closing markdown and everything after
        .replace(/\\"/g, '"') // Unescape quotes
        .trim();
      // Secondary attempt: extract JSON object from string. This handles cases where LLMs wrap JSON in extra text.
      const match = trimmed.match(/\{[\s\S]*\}/);
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

  return normalizeLLMContent(rawContent);
}

// Unified function that works with any LLM provider
export async function classifyViaLLM(opts: {
  config: LLMConfig,
  text: string,
  originalName: string,
  categoriesHint: string[],
  fileContent?: FileContent,
}): Promise<{ category_path: string; suggested_filename: string; confidence: number; raw?: any }>{
  const { config, text, originalName, categoriesHint, fileContent } = opts;
  
  // Check if we have an image but the model doesn't support vision
  if (fileContent?.image_base64 && !config.supportsVision) {
    // Skip image files if model doesn't support vision
    return {
      category_path: 'uncategorized/images',
      suggested_filename: originalName.replace(/\.[^/.]+$/, ''),
      confidence: 0,
      raw: { skipped: 'Model does not support vision' },
    };
  }
  
  const hint = categoriesHint?.length ? `\n\nIMPORTANT: You MUST classify the file into one of the following existing categories. Do NOT create new categories.\nExisting categories:\n- ${categoriesHint.join('\n- ')}` : '';
  const maxTextLength = config.maxTextLength || 4096;
  
  // Build prompt based on content type
  let prompt: string;
  
  if (config.customPrompt) {
    // Use custom prompt template with placeholder replacement
    const contentType = fileContent?.image_base64 ? 'image' : 'text';
    const contentPreview = fileContent?.image_base64 
      ? '[Image data - see attached image]' 
      : text.slice(0, maxTextLength);
    
    prompt = config.customPrompt
      .replace(/\{filename\}/g, originalName)
      .replace(/\{content\}/g, contentPreview)
      .replace(/\{type\}/g, contentType)
      .replace(/\{categories\}/g, categoriesHint.join(', '));
    
    // Add hint if not already included in custom prompt
    if (hint && !config.customPrompt.includes('{categories}')) {
      prompt += hint;
    }
  } else {
    if (categoriesHint?.length) {
      // Strict mode with existing categories
      const strictPromptTemplate =
 `You are a file organizer. Analyze the ${fileContent?.image_base64 ? 'image' : 'text content'} and provide classification and naming suggestions.

  **Task 1: Category Classification**
  - You MUST classify the file into one of the following existing categories.
  - Do NOT create new categories.
  - Do NOT modify the category names (preserve case and path).
  - If the file does not fit any of the categories, use "Uncategorized".

  **Allowed Categories:**
  - ${categoriesHint.join('\n  - ')}
  - Uncategorized

  **Task 2: Filename Suggestion**
  - Provide a descriptive filename base (no file extension) using lowercase with underscores
  - Format: {primary_topic}_{entity}_{date_or_identifier}
    - primary_topic: main subject (1-2 words, e.g., "invoice", "meeting_notes", "project_proposal")
    - entity: company/person/organization if identifiable (e.g., "acme_corp", "john_smith")
    - date_or_identifier: date in YYYY-MM-DD or unique identifier if present
  - If any component is missing, omit it (minimum: just primary_topic)
  - Examples: "invoice_acme_corp_2024-03-15", "recipe_chocolate_cake", "contract_freelance_2024"
  - Keep total length under 50 characters
  ${fileContent?.image_base64 ? '\n**For images**: Describe visible content, text, objects, or documents to determine category and filename.' : ''}

  **Output Format**: Return ONLY valid JSON with these exact keys:
  {
    "category_path": "one/of/the/existing/categories",
    "suggested_filename": "descriptive_name_here",
    "confidence": 0.85
  }

  Original filename: ${originalName}`;

      if (fileContent?.image_base64) {
        prompt = `${strictPromptTemplate}\n\nOriginal filename: ${originalName}`;
      } else {
        prompt = `${strictPromptTemplate}\n\nOriginal filename: ${originalName}\nContent (truncated to ${maxTextLength} chars):\n${text.slice(0, maxTextLength)}`;
        debugLogger.debug('CLASSIFY_VIA_LLM', 'Built prompt for text content with existing categories', { promptPreview: prompt.slice(0, 500) });
      }
    } else {
      // Default mode (no existing categories enforced)
      const defaultPromptTemplate =
 `You are a file organizer. Analyze the ${fileContent?.image_base64 ? 'image' : 'text content'} and provide classification and naming suggestions.

  **Task 1: Category Classification**
  - Create a category path with EXACTLY 2 levels separated by forward slash (/)
  - Use Title Case for all category levels (e.g., "Personal/Medical Records")
  - First level should be ONE of these broad categories:
    Business, Personal, Finance, Health, Education, Entertainment, Work, Travel, Legal, Technology, Science, Art, Music, Sports, Media, Documents, Archives
  - Second level should be a specific subcategory relevant to content:
    Examples: Invoices, Reports, Photos, Recipes, Projects, Research, Contracts, Receipts, Presentations, Notes
  - If content doesn't fit clearly, use "Uncategorized/General"
  - Never create categories deeper than 2 levels

  **Task 2: Filename Suggestion**
  - Provide a descriptive filename base (no file extension) using lowercase with underscores
  - Format: {primary_topic}_{entity}_{date_or_identifier}
    - primary_topic: main subject (1-2 words, e.g., "invoice", "meeting_notes", "project_proposal")
    - entity: company/person/organization if identifiable (e.g., "acme_corp", "john_smith")
    - date_or_identifier: date in YYYY-MM-DD or unique identifier if present
  - If any component is missing, omit it (minimum: just primary_topic)
  - Examples: "invoice_acme_corp_2024-03-15", "recipe_chocolate_cake", "contract_freelance_2024"
  - Keep total length under 50 characters
  ${fileContent?.image_base64 ? '\n**For images**: Describe visible content, text, objects, or documents to determine category and filename.' : ''}

  **Output Format**: Return ONLY valid JSON with these exact keys:
  {
    "category_path": "Category/Subcategory",
    "suggested_filename": "descriptive_name_here",
    "confidence": 0.85
  }

  Original filename: ${originalName}`;

      if (fileContent?.image_base64) {
        prompt = `${defaultPromptTemplate}\n\nOriginal filename: ${originalName}${hint}`;
      } else {
        prompt = `${defaultPromptTemplate}\n\nOriginal filename: ${originalName}\nContent (truncated to ${maxTextLength} chars):\n${text.slice(0, maxTextLength)}${hint}`;
        debugLogger.debug('CLASSIFY_VIA_LLM', 'Built prompt for text content without existing categories', { promptPreview: prompt.slice(0, 500) });
      }
    }
  }

  const systemMessage = config.systemMessage || 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).';
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  
  // Prepare image data if available
  const imageData = fileContent?.image_base64 && fileContent?.mime_type && config.supportsVision
    ? { base64: fileContent.image_base64, mimeType: fileContent.mime_type }
    : undefined;
  
  const body = buildRequestBody(config, prompt, systemMessage, imageData);

  // Comprehensive debug logging
  debugLogger.info('LLM_REQUEST', 'Preparing LLM request', {
    provider: config.provider,
    endpoint,
    model: config.model,
    hasApiKey: !!config.apiKey,
    hasCustomHeaders: !!config.customHeaders,
    customHeaderKeys: config.customHeaders ? Object.keys(config.customHeaders) : [],
    hasImage: !!imageData,
    supportsVision: config.supportsVision,
  });

  debugLogger.debug('LLM_REQUEST', 'Request headers', { headers });
  debugLogger.debug('LLM_REQUEST', 'Request body preview', {
    model: body.model,
    messageCount: body.messages?.length,
    systemMessage: body.messages?.[0]?.content?.substring(0, 100),
    hasImageData: !!imageData,
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
  return safeParseJson(content, () => ({
    category_path: 'uncategorized',
    suggested_filename: originalName.replace(/\.[^/.]+$/, ''),
    confidence: 0,
  }));
}

export async function optimizeCategoriesViaLLM(opts: {
  config: LLMConfig,
  directoryTree: { [category: string]: string[] },
}): Promise<{ optimizations: { from: string; to: string; reason: string }[] }> {
  const { config, directoryTree } = opts;
  
  const treeText = Object.entries(directoryTree)
    .map(([category, files]) => `${category}/ (${files.length} files)`)
    .join('\n\n');

  const defaultPromptTemplate = 
`You are a file organization optimizer. Analyze this directory structure and suggest optimizations.

**Category Structure Rules**:
- All categories MUST follow 2-level format: "FirstLevel/SecondLevel"
- Example first level broad categories: Finance, Health, Education, Entertainment, Work, Travel, Legal, Technology, Science, Art, Music, Sports, Media, Shopping

**Optimization Goals**:
1. **Merge similar categories**: Combine categories with overlapping meanings
   - Example: "Work/Meeting Notes" + "Work/Meeting Minutes" → "Work/Notes"
2. **Consolidate granular subcategories**: Simplify overly specific second-level categories
   - Example: "Finance/Tax Returns 2023" + "Finance/Tax Returns 2024" → "Finance/Tax Returns"
3. **Correct naming inconsistencies**: Standardize category names for uniformity

**Output Format**: Return ONLY valid JSON with this structure:
{
  "optimizations": [
    {
      "from": "Current category path",
      "to": "Suggested category path",
      "reason": "Brief explanation (max 100 chars)",
    }
  ]
}

**Current directory structure**:
${treeText}

Analyze and suggest optimizations. Focus on similar categories that could be merged, naming inconsistencies changes first. Limit to 10 most important optimizations.`;

  // Use custom prompt if provided, otherwise use default
  let prompt: string;
  if (config.customCategoryPrompt) {
    // Replace placeholders in custom prompt
    prompt = config.customCategoryPrompt
      .replace(/\{directory_tree\}/g, treeText)
      .replace(/\{tree\}/g, treeText)
      .replace(/\{categories\}/g, treeText);
  } else {
    prompt = defaultPromptTemplate;
  }

  const systemMessage = config.systemMessage || 'Return only valid JSON (no markdown), with key "optimizations" containing an array of optimization suggestions.';
  
  const endpoint = getCompletionEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, prompt, systemMessage);

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

  return processOptimizationResponse(config, resp);
}

export function processOptimizationResponse(config: LLMConfig, resp: { ok: boolean; status: number; data: string }): 
  { optimizations: { from: string; to: string; reason: string }[] } {
  
  // Parse the response text as JSON
  let data;
  try {
    data = JSON.parse(resp.data);
  } catch (parseError: any) {
    throw new Error(`Failed to parse response from ${config.provider}: ${parseError.message}`);
  }

  const content = extractContent(config, data);
  const jsonResult = safeParseJson<{ optimizations: { from: string; to: string; reason: string }[] }>(content, () => ({ optimizations: [] }));
  // Validate structure
  if (Array.isArray(jsonResult.optimizations)) {
    // Further validate each optimization entry
    // only keep those with valid from, to, reason strings
    // from should be a valid category path (e.g., "Finance/Invoices"), any trailing forward or backward slashes will be trimmed
    const trimTrailingSlash = (path: string) => path.replace(/[\/\\]+$/, '');
    
    const validOptimizations = jsonResult.optimizations
      .filter(opt =>
        typeof opt.from === 'string' &&
        typeof opt.to === 'string' &&
        typeof opt.reason === 'string'
      )
      .map(opt => ({
        from: trimTrailingSlash(opt.from),
        to: trimTrailingSlash(opt.to),
        reason: opt.reason,
      }));
    return { optimizations: validOptimizations };
  }
  return jsonResult;
}

// Open a file using the operating system's default application
export async function openFile(path: string): Promise<void> {
  try {
    await invoke('open_file', { path });
  } catch (error: any) {
    throw new Error(`Failed to open file: ${error.message || String(error)}`);
  }
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
    debugLogger.warn('API', 'Failed to list Ollama models', { error: e });
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
    debugLogger.warn('API', 'Failed to list LM Studio models', { error: e });
    return [];
  }
}

// Managed LLM Server API functions

export async function getManagedLLMServerStatus(): Promise<ManagedLLMServerInfo> {
  try {
    return await invoke<ManagedLLMServerInfo>('get_llm_server_status');
  } catch (error: any) {
    throw new Error(`Failed to get server status: ${error.message || String(error)}`);
  }
}

export async function downloadManagedLLMServer(
  version: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  try {
    // Call the download command - progress tracking would need to be implemented with events
    // For now, we'll simulate progress in the UI and call the actual download
    const result = await invoke<string>('download_llm_server', { version });
    
    // Ensure progress reaches 100% when download completes
    if (onProgress) {
      onProgress(100);
    }
    
    return result;
  } catch (error: any) {
    throw new Error(`Failed to download server: ${error.message || String(error)}`);
  }
}

export async function startManagedLLMServer(config: ManagedLLMConfig): Promise<string> {
  try {
    return await invoke<string>('start_llm_server', { config });
  } catch (error: any) {
    throw new Error(`Failed to start server: ${error.message || String(error)}`);
  }
}

export async function stopManagedLLMServer(): Promise<string> {
  try {
    return await invoke<string>('stop_llm_server');
  } catch (error: any) {
    throw new Error(`Failed to stop server: ${error.message || String(error)}`);
  }
}

export async function getManagedLLMServerInfo(): Promise<ManagedLLMServerInfo> {
  try {
    return await invoke<ManagedLLMServerInfo>('get_llm_server_info');
  } catch (error: any) {
    throw new Error(`Failed to get server info: ${error.message || String(error)}`);
  }
}
