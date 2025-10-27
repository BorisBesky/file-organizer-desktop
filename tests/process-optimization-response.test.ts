/**
 * Unit tests for processOptimizationResponse function
 * 
 * This test suite validates the processOptimizationResponse function's ability to:
 * 1. Parse LLM responses from different providers (OpenAI, Ollama, Anthropic, Gemini)
 * 2. Extract optimization suggestions from various response formats
 * 3. Handle thinking blocks and other LLM-specific response patterns
 * 4. Gracefully handle malformed JSON with fallback behavior
 * 5. Correctly parse optimization details (from, to, reason, priority, file_count)
 * 
 * Test data is loaded from optimizedCategoriesOutput.data which contains a sample
 * LLM response with 10 optimization suggestions across different priority levels.
 */

import { processOptimizationResponse, LLMConfig, safeParseJson } from '../src/api.ts';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the sample response data
const jsonContent = readFileSync(
  join(__dirname, 'optimizedCategoriesOutput.data'),
  'utf-8'
);


// Mock LLM config for testing
const mockConfig: LLMConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4-turbo-preview',
};

// Test 1: Process a valid OpenAI-style response
console.log('Test 1: Processing valid OpenAI-style response...');
const openAIResponse = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    choices: [
      {
        message: {
          content: jsonContent,
        },
      },
    ],
  }),
};

const result1 = processOptimizationResponse(mockConfig, openAIResponse);

// Validate structure
if (!result1.optimizations || !Array.isArray(result1.optimizations)) {
  throw new Error('Expected optimizations array in result');
}

// Validate content
if (result1.optimizations.length !== 10) {
  throw new Error(`Expected 10 optimizations, got ${result1.optimizations.length}`);
}

// Check first optimization
const firstOpt = result1.optimizations[0];
if (firstOpt.from !== 'Personal/Documents/new_worker_letter_2025-05-31.pdf') {
  throw new Error(`Expected first optimization 'from' to be 'Personal/Documents/new_worker_letter_2025-05-31.pdf', got ${firstOpt.from}`);
}
if (firstOpt.to !== 'Personal/Documents/New Worker Letter 2025-05-31.pdf') {
  throw new Error(`Expected first optimization 'to' to be 'Personal/Documents/New Worker Letter 2025-05-31.pdf', got ${firstOpt.to}`);
}
if (firstOpt.reason !== 'Consistent naming for a duplicate document') {
  throw new Error(`Expected first optimization reason to be 'Consistent naming for a duplicate document', got ${firstOpt.reason}`);
}

console.log('✓ Test 1 passed: OpenAI-style response processed correctly');

// Test 2: Process Ollama-style response
console.log('\nTest 2: Processing Ollama-style response...');
const ollamaConfig: LLMConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'deepseek-r1:8b',
};

const ollamaResponse = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    message: {
      content: jsonContent,
    },
  }),
};

const result2 = processOptimizationResponse(ollamaConfig, ollamaResponse);

if (!result2.optimizations || result2.optimizations.length !== 10) {
  throw new Error(`Expected 10 optimizations from Ollama response, got ${result2.optimizations?.length || 0}`);
}

console.log('✓ Test 2 passed: Ollama-style response processed correctly');

// Test 3: Process Anthropic-style response
console.log('\nTest 3: Processing Anthropic-style response...');
const anthropicConfig: LLMConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-3-5-sonnet-20241022',
};

const anthropicResponse = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    content: [
      {
        text: jsonContent,
      },
    ],
  }),
};

const result3 = processOptimizationResponse(anthropicConfig, anthropicResponse);

if (!result3.optimizations || result3.optimizations.length !== 10) {
  throw new Error(`Expected 10 optimizations from Anthropic response, got ${result3.optimizations?.length || 0}`);
}

console.log('✓ Test 3 passed: Anthropic-style response processed correctly');

// Test 4: Handle response with thinking blocks
console.log('\nTest 4: Processing response with thinking blocks...');
const responseWithThinking = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    choices: [
      {
        message: {
          content: `<think>Let me analyze these categories and suggest optimizations...</think>\n${jsonContent}`,
        },
      },
    ],
  }),
};

const result4 = processOptimizationResponse(mockConfig, responseWithThinking);

if (!result4.optimizations || result4.optimizations.length !== 10) {
  throw new Error(`Expected thinking blocks to be stripped, got ${result4.optimizations?.length || 0} optimizations`);
}

console.log('✓ Test 4 passed: Thinking blocks stripped correctly');

// Test 5: Handle malformed JSON (fallback to empty array)
console.log('\nTest 5: Processing malformed JSON response...');
const malformedResponse = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    choices: [
      {
        message: {
          content: 'This is not valid JSON at all!',
        },
      },
    ],
  }),
};

const result5 = processOptimizationResponse(mockConfig, malformedResponse);

if (!result5.optimizations || !Array.isArray(result5.optimizations)) {
  throw new Error('Expected fallback to empty optimizations array');
}
if (result5.optimizations.length !== 0) {
  throw new Error(`Expected empty array fallback, got ${result5.optimizations.length} items`);
}

console.log('✓ Test 5 passed: Malformed JSON handled with fallback');

// Test 6: Gemini-style response
console.log('\nTest 6: Processing Gemini-style response...');
const geminiConfig: LLMConfig = {
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  model: 'gemini-2.0-flash-exp',
};

const geminiResponse = {
  ok: true,
  status: 200,
  data: JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text: jsonContent,
            },
          ],
        },
      },
    ],
  }),
};

const result6 = processOptimizationResponse(geminiConfig, geminiResponse);

if (!result6.optimizations || result6.optimizations.length !== 10) {
  throw new Error(`Expected 10 optimizations from Gemini response, got ${result6.optimizations?.length || 0}`);
}

console.log('✓ Test 6 passed: Gemini-style response processed correctly');

console.log('\n✅ All tests passed successfully!');
