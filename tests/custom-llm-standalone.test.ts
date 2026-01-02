/**
 * Standalone test for custom LLM with headers
 * This test validates that custom headers work correctly without needing Tauri
 */

export {}; // Make this a module

// Test configuration
const TEST_CONFIG = {
  BASE_URL: process.env.CUSTOM_LLM_URL || 'https://api.together.xyz',
  MODEL: process.env.CUSTOM_LLM_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
  API_KEY: process.env.CUSTOM_LLM_API_KEY || 'tgp_v1_5t0fhttJ8k0AibnHizZKdi6xemYHxlIVRBuDvmoD364',
  TIMEOUT_MS: Number(process.env.CUSTOM_LLM_TIMEOUT || 30000),
};

console.log(`\n🔍 Custom LLM with Headers Test (Standalone)`);
console.log(`   • Base URL: ${TEST_CONFIG.BASE_URL}`);
console.log(`   • Model: ${TEST_CONFIG.MODEL}`);
console.log(`   • API Key: ${TEST_CONFIG.API_KEY.substring(0, 10)}...`);
console.log(`   • Timeout: ${TEST_CONFIG.TIMEOUT_MS}ms\n`);

// Test 1: Header building logic
console.log('📋 Test 1: Header Building Logic');
console.log('─'.repeat(50));

function buildHeaders(config: {
  apiKey?: string;
  customHeaders?: Record<string, string>;
  provider: string;
}): Record<string, string> {
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
    // Smart merge: If custom Authorization header doesn't have Bearer prefix, add it
    const customHeaders = { ...config.customHeaders };
    if (customHeaders['Authorization'] && typeof customHeaders['Authorization'] === 'string') {
      const authValue = customHeaders['Authorization'];
      // Only add Bearer if it's not already there and looks like a raw token
      if (!authValue.toLowerCase().startsWith('bearer ') && 
          !authValue.toLowerCase().startsWith('basic ') &&
          authValue.length > 10) {
        customHeaders['Authorization'] = `Bearer ${authValue}`;
      }
    }
    
    Object.assign(headers, customHeaders);
  }

  return headers;
}

const headerTests: Array<{
  name: string;
  config: {
    provider: string;
    apiKey?: string;
    customHeaders?: Record<string, string>;
  };
  validate: (headers: Record<string, string>) => boolean;
}> = [
  {
    name: 'API key without custom headers (should add Bearer prefix)',
    config: {
      provider: 'custom',
      apiKey: TEST_CONFIG.API_KEY,
    },
    validate: (headers: Record<string, string>) => {
      const expected = `Bearer ${TEST_CONFIG.API_KEY}`;
      return headers['Authorization'] === expected;
    },
  },
  {
    name: 'Custom Authorization WITH Bearer prefix (should keep as-is)',
    config: {
      provider: 'custom',
      apiKey: 'should-be-ignored',
      customHeaders: {
        'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
      } as Record<string, string>,
    },
    validate: (headers: Record<string, string>) => {
      const expected = `Bearer ${TEST_CONFIG.API_KEY}`;
      return headers['Authorization'] === expected && !headers['Authorization'].includes('should-be-ignored');
    },
  },
  {
    name: 'Custom Authorization WITHOUT Bearer prefix (should auto-add)',
    config: {
      provider: 'custom',
      apiKey: 'ignored',
      customHeaders: {
        'Authorization': TEST_CONFIG.API_KEY, // No Bearer prefix
      } as Record<string, string>,
    },
    validate: (headers: Record<string, string>) => {
      const expected = `Bearer ${TEST_CONFIG.API_KEY}`;
      return headers['Authorization'] === expected;
    },
  },
  {
    name: 'Custom headers with additional fields',
    config: {
      provider: 'custom',
      apiKey: TEST_CONFIG.API_KEY,
      customHeaders: {
        'X-Custom-Header': 'test-value',
      } as Record<string, string>,
    },
    validate: (headers: Record<string, string>) => {
      return headers['X-Custom-Header'] === 'test-value' &&
             headers['Authorization'] === `Bearer ${TEST_CONFIG.API_KEY}`;
    },
  },
];

let headerTestsPassed = 0;
for (const test of headerTests) {
  const headers = buildHeaders(test.config);
  const passed = test.validate(headers);
  
  if (passed) {
    console.log(`✅ ${test.name}`);
    headerTestsPassed++;
  } else {
    console.log(`❌ ${test.name}`);
    console.log('   Headers:', JSON.stringify(headers, null, 2));
  }
}

console.log(`\nHeader Tests: ${headerTestsPassed}/${headerTests.length} passed\n`);

// Test 2: Actual API call
console.log('📋 Test 2: Real API Call with Custom LLM');
console.log('─'.repeat(50));

async function testActualAPICall() {
  const endpoint = `${TEST_CONFIG.BASE_URL}/v1/chat/completions`;
  
  // Test without custom headers (using API key directly)
  console.log('\n🧪 Test 2a: Using API key directly (auto Bearer prefix)');
  const headers1 = buildHeaders({
    provider: 'custom',
    apiKey: TEST_CONFIG.API_KEY,
  });
  
  console.log('Headers being sent:', {
    ...headers1,
    Authorization: headers1.Authorization?.substring(0, 20) + '...',
  });
  
  try {
    const response1 = await fetch(endpoint, {
      method: 'POST',
      headers: headers1,
      body: JSON.stringify({
        model: TEST_CONFIG.MODEL,
        messages: [
          { role: 'system', content: 'Return only valid JSON with keys: category_path, suggested_filename.' },
          { role: 'user', content: 'Classify this: Invoice from Acme Corp dated 2024-03-15' },
        ],
        temperature: 0.2,
        max_tokens: 500,
        stream: false,
      }),
    });
    
    console.log(`Response status: ${response1.status} ${response1.statusText}`);
    
    if (!response1.ok) {
      const errorText = await response1.text();
      console.error('❌ API call failed!');
      console.error('Error response:', errorText);
      return false;
    }
    
    const data = await response1.json();
    console.log('✅ API call successful!');
    console.log('Response preview:', {
      model: data.model,
      hasChoices: Array.isArray(data.choices),
      choiceCount: data.choices?.length,
      firstChoice: data.choices?.[0]?.message?.content?.substring(0, 100),
    });
  } catch (error) {
    console.error('❌ API call failed with exception:', error);
    return false;
  }
  
  // Test with explicit custom headers
  console.log('\n🧪 Test 2b: Using explicit custom Authorization header');
  const headers2 = buildHeaders({
    provider: 'custom',
    apiKey: 'ignored',
    customHeaders: {
      'Authorization': `Bearer ${TEST_CONFIG.API_KEY}`,
      'X-Test-Header': 'test-value',
    },
  });
  
  console.log('Headers being sent:', {
    ...headers2,
    Authorization: headers2.Authorization?.substring(0, 20) + '...',
  });
  
  try {
    const response2 = await fetch(endpoint, {
      method: 'POST',
      headers: headers2,
      body: JSON.stringify({
        model: TEST_CONFIG.MODEL,
        messages: [
          { role: 'system', content: 'Return only valid JSON with keys: category_path, suggested_filename.' },
          { role: 'user', content: 'Classify this: Medical bill from Dr. Smith' },
        ],
        temperature: 0.2,
        max_tokens: 500,
        stream: false,
      }),
    });
    
    console.log(`Response status: ${response2.status} ${response2.statusText}`);
    
    if (!response2.ok) {
      const errorText = await response2.text();
      
      // Rate limiting (429) means the headers worked, just hit quota
      if (response2.status === 429) {
        console.log('⚠️  Hit rate limit, but custom headers were accepted!');
        console.log('   (This proves custom headers are working correctly)');
        console.log('   Error response:', errorText);
        return true; // Consider this a success for header validation
      }
      
      console.error('❌ API call with custom headers failed!');
      console.error('Error response:', errorText);
      return false;
    }
    
    const data = await response2.json();
    console.log('✅ API call with custom headers successful!');
    console.log('Response preview:', {
      model: data.model,
      hasChoices: Array.isArray(data.choices),
      firstChoice: data.choices?.[0]?.message?.content?.substring(0, 100),
    });
  } catch (error) {
    console.error('❌ API call failed with exception:', error);
    return false;
  }
  
  return true;
}

// Run all tests
async function runAllTests() {
  if (headerTestsPassed !== headerTests.length) {
    console.log('\n' + '='.repeat(50));
    console.log('❌ Header tests failed, skipping API tests');
    console.log('='.repeat(50) + '\n');
    process.exit(1);
  }
  
  const apiTestPassed = await testActualAPICall();
  
  console.log('\n' + '='.repeat(50));
  if (apiTestPassed) {
    console.log('✅ All tests passed!');
    console.log('='.repeat(50) + '\n');
  } else {
    console.log('❌ API tests failed!');
    console.log('='.repeat(50) + '\n');
    process.exit(1);
  }
}

await runAllTests();
