// Mock the Tauri API for Node.js testing environment
// This must be done BEFORE importing any modules that use @tauri-apps/api
const mockTauriApi = {
  invoke: async (command: string, args: any) => {
    if (command === 'http_request') {
      const { url, method, headers, body } = args;
      const response = await fetch(url, {
        method,
        headers,
        body,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      return await response.text();
    }
    throw new Error(`Unknown Tauri command: ${command}`);
  }
};

// Set up module mock
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Mock @tauri-apps/api/tauri module
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === '@tauri-apps/api/tauri') {
    return { invoke: mockTauriApi.invoke };
  }
  return originalRequire.apply(this, arguments);
};

// Now we can import the API functions
import { classifyViaLLM } from '../src/api.ts';
import type { LLMConfig } from '../src/api.ts';

// Test configuration - customize these values
const TEST_CONFIG = {
  BASE_URL: process.env.CUSTOM_LLM_URL ?? 'https://api.together.xyz',
  MODEL: process.env.CUSTOM_LLM_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
  API_KEY: process.env.CUSTOM_LLM_API_KEY ?? 'tgp_v1_5t0fhttJ8k0AibnHizZKdi6xemYHxlIVRBuDvmoD364',
  TIMEOUT_MS: Number(process.env.CUSTOM_LLM_TIMEOUT ?? 30_000),
};

console.log(`\n🔍 Custom LLM with Headers Test`);
console.log(`   • Base URL: ${TEST_CONFIG.BASE_URL}`);
console.log(`   • Model: ${TEST_CONFIG.MODEL}`);
console.log(`   • API Key: ${TEST_CONFIG.API_KEY.substring(0, 10)}...`);
console.log(`   • Timeout: ${TEST_CONFIG.TIMEOUT_MS}ms\n`);

// Test 1: Verify header building logic
console.log('📋 Test 1: Header Building Logic');
console.log('─'.repeat(50));

const testConfigs: Array<{ name: string; config: LLMConfig; expectedHeaders: Record<string, string> }> = [
  {
    name: 'Custom provider with API key (no custom headers)',
    config: {
      provider: 'custom',
      baseUrl: TEST_CONFIG.BASE_URL,
      model: TEST_CONFIG.MODEL,
      apiKey: TEST_CONFIG.API_KEY,
    },
    expectedHeaders: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
    },
  },
  {
    name: 'Custom provider with custom Authorization header',
    config: {
      provider: 'custom',
      baseUrl: TEST_CONFIG.BASE_URL,
      model: TEST_CONFIG.MODEL,
      apiKey: 'should-be-overridden',
      customHeaders: {
        'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
      },
    },
    expectedHeaders: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
    },
  },
  {
    name: 'Custom provider with custom headers and extra fields',
    config: {
      provider: 'custom',
      baseUrl: TEST_CONFIG.BASE_URL,
      model: TEST_CONFIG.MODEL,
      apiKey: TEST_CONFIG.API_KEY,
      customHeaders: {
        'X-Custom-Header': 'custom-value',
        'X-Request-ID': '123456',
      },
    },
    expectedHeaders: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
      'X-Custom-Header': 'custom-value',
      'X-Request-ID': '123456',
    },
  },
  {
    name: 'Custom provider overriding Authorization completely',
    config: {
      provider: 'custom',
      baseUrl: TEST_CONFIG.BASE_URL,
      model: TEST_CONFIG.MODEL,
      apiKey: 'ignored-key',
      customHeaders: {
        'Authorization': 'CustomAuth MyToken123',
      },
    },
    expectedHeaders: {
      'Content-Type': 'application/json',
      'Authorization': 'CustomAuth MyToken123',
    },
  },
];

let headerTestsPassed = 0;
let headerTestsFailed = 0;

// Note: buildHeaders is not exported, so we'll need to test indirectly
// For now, let's create a local version to test the logic
function buildHeadersTest(config: LLMConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Set default authentication headers based on provider
  if (config.apiKey) {
    if (config.provider === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (config.provider === 'gemini') {
      // Gemini uses API key in URL, not in headers
    } else {
      // Default to Bearer token for OpenAI-compatible APIs
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  // Apply custom headers last so they can override defaults
  if (config.customHeaders) {
    Object.assign(headers, config.customHeaders);
  }

  return headers;
}

for (const test of testConfigs) {
  const actualHeaders = buildHeadersTest(test.config);
  let passed = true;
  const errors: string[] = [];

  for (const [key, expectedValue] of Object.entries(test.expectedHeaders)) {
    if (actualHeaders[key] !== expectedValue) {
      passed = false;
      errors.push(`  ❌ ${key}: expected "${expectedValue}", got "${actualHeaders[key]}"`);
    }
  }

  if (passed) {
    console.log(`✅ ${test.name}`);
    headerTestsPassed++;
  } else {
    console.log(`❌ ${test.name}`);
    errors.forEach(err => console.log(err));
    console.log('   Actual headers:', JSON.stringify(actualHeaders, null, 2));
    headerTestsFailed++;
  }
}

console.log(`\nHeader Tests: ${headerTestsPassed} passed, ${headerTestsFailed} failed\n`);

// Test 2: Actual API call with custom headers
console.log('📋 Test 2: Real API Call with Custom LLM');
console.log('─'.repeat(50));

async function testCustomLLMConnection(): Promise<void> {
  const config: LLMConfig = {
    provider: 'custom',
    baseUrl: TEST_CONFIG.BASE_URL,
    model: TEST_CONFIG.MODEL,
    apiKey: TEST_CONFIG.API_KEY,
    maxTokens: 4096,
    systemMessage: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).',
  };

  console.log('Testing configuration:');
  console.log(JSON.stringify({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: `${config.apiKey?.substring(0, 10)}...`,
    maxTokens: config.maxTokens,
  }, null, 2));

  try {
    console.log('\n🚀 Making API call...');
    const result = await classifyViaLLM({
      config,
      text: 'Invoice from Acme Corp dated 2024-03-15 for $1,234.56',
      originalName: 'document.pdf',
      categoriesHint: ['finance/invoices', 'business/receipts'],
    });

    console.log('✅ API call successful!');
    console.log('Response:', JSON.stringify(result, null, 2));

    // Validate response structure
    if (!result.category_path || !result.suggested_filename || typeof result.confidence !== 'number') {
      throw new Error('Invalid response structure');
    }

    console.log('\n✅ Response validation passed!');
  } catch (error) {
    console.error('\n❌ API call failed!');
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    } else {
      console.error('Error:', error);
    }
    throw error;
  }
}

// Test 3: Test with explicit custom headers
console.log('\n📋 Test 3: API Call with Explicit Custom Headers');
console.log('─'.repeat(50));

async function testWithExplicitHeaders(): Promise<void> {
  const config: LLMConfig = {
    provider: 'custom',
    baseUrl: TEST_CONFIG.BASE_URL,
    model: TEST_CONFIG.MODEL,
    apiKey: 'ignored', // This should be overridden by customHeaders
    customHeaders: {
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
      'X-Test-Header': 'test-value',
    },
    maxTokens: 4096,
  };

  console.log('Testing with explicit custom headers:');
  console.log(JSON.stringify({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    customHeaders: {
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY.substring(0, 10)}...`,
      'X-Test-Header': 'test-value',
    },
  }, null, 2));

  try {
    console.log('\n🚀 Making API call with custom headers...');
    const result = await classifyViaLLM({
      config,
      text: 'Medical bill from Dr. Smith dated January 2024',
      originalName: 'bill.pdf',
      categoriesHint: ['medical/bills', 'health/invoices'],
    });

    console.log('✅ API call with custom headers successful!');
    console.log('Response:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('\n❌ API call with custom headers failed!');
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    }
    throw error;
  }
}

// Run all tests
async function runAllTests() {
  try {
    if (headerTestsFailed > 0) {
      throw new Error(`Header building tests failed: ${headerTestsFailed} failures`);
    }

    await testCustomLLMConnection();
    await testWithExplicitHeaders();

    console.log('\n' + '='.repeat(50));
    console.log('✅ All tests passed!');
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    console.log('\n' + '='.repeat(50));
    console.log('❌ Tests failed!');
    console.log('='.repeat(50) + '\n');
    process.exit(1);
  }
}

await runAllTests();
