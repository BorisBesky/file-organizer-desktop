import { classifyViaLLM } from '../src/api.ts';
import type { LLMConfig } from '../src/api.ts';

const BASE_URL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234';
const MODEL = process.env.LMSTUDIO_MODEL ?? 'gemma-3n-e4b';
const TIMEOUT_MS = Number(process.env.LMSTUDIO_TIMEOUT ?? 15_000);

function buildEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
}

async function runConnectionCheck(): Promise<void> {
  const endpoint = buildEndpoint(BASE_URL);

  console.log(`\n🔍 LM Studio connection diagnostic`);
  console.log(`   • Endpoint: ${endpoint}`);
  console.log(`   • Model: ${MODEL}`);
  console.log(`   • Timeout: ${TIMEOUT_MS}ms`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are a diagnostics agent that replies with JSON.' },
          { role: 'user', content: 'Respond with {"status":"ok"}.' },
        ],
        temperature: 0,
        stream: false,
        max_tokens: 128,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`   • HTTP Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Non-OK response. Body: ${text}`);
    }

    const payload = await response.json();

    const choices = payload?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error(`Unexpected response shape: ${JSON.stringify(payload, null, 2)}`);
    }

    const messageContent = choices[0]?.message?.content ?? '(empty)';

    console.log('   • Model reported:', payload?.model ?? '(unknown)');
    console.log('   • First choice content:', messageContent);

    const classifyConfig: LLMConfig = {
      provider: 'lmstudio',
      baseUrl: BASE_URL,
      model: MODEL,
    };

    console.log('   • Running classifyViaLLM smoke test...');
    const classifyResult = await classifyViaLLM({
      config: classifyConfig,
      text: 'Diagnostic classification sample',
      originalName: 'diagnostic.txt',
      categoriesHint: [],
    });
    console.log('   • classifyViaLLM response:', JSON.stringify(classifyResult));

    console.log('\n✅ LM Studio connection diagnostic passed.');
  } catch (error) {
    clearTimeout(timeout);

    const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('\n❌ LM Studio connection diagnostic failed.');
    console.error(`   • ${details}`);

    if (error instanceof Error && error.stack) {
      console.error(error.stack.split('\n').slice(1).join('\n'));
    }

    throw error;
  }
}

await runConnectionCheck();
