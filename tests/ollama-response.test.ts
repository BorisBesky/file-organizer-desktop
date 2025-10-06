import { normalizeOllamaContent } from '../src/api.ts';

const sampleStringResponse = `<think>
Okay, the user wants a simple friendly JSON greeting response with a greeting only, so I'll keep it concise and neutral and warm.
</think>
{"greetings":"Hello"}`;

const resultFromString = normalizeOllamaContent(sampleStringResponse);

if (resultFromString !== '{"greetings":"Hello"}') {
  throw new Error(`Expected sanitized string payload to equal {"greetings":"Hello"}, received: ${resultFromString}`);
}

const sampleArrayResponse = [
  { type: 'thinking', text: 'I am reasoning through the answer.' },
  { type: 'output', text: '{"answer":42}' },
];

const resultFromArray = normalizeOllamaContent(sampleArrayResponse);

if (resultFromArray !== '{"answer":42}') {
  throw new Error(`Expected sanitized array payload to equal {"answer":42}, received: ${resultFromArray}`);
}

const openAIStyleResponse = '{"status":"ok"}';

const resultFromOpenAI = normalizeOllamaContent(openAIStyleResponse);

if (resultFromOpenAI !== '{"status":"ok"}') {
  throw new Error(`Expected plain JSON payload to remain unchanged, received: ${resultFromOpenAI}`);
}

const anthropicStyleResponse = [
  { type: 'thinking', text: 'Let me double-check the directory suggestions.' },
  { type: 'reasoning', text: 'Comparing categories for overlap.' },
  { type: 'text', text: '<think>internal note</think>{"optimizations":[{"from":"finance","to":"finance/taxes","reason":"More specific"}]}' },
];

const resultFromAnthropic = normalizeOllamaContent(anthropicStyleResponse);

if (resultFromAnthropic !== '{"optimizations":[{"from":"finance","to":"finance/taxes","reason":"More specific"}]}') {
  throw new Error(`Expected anthropic-style payload to be sanitized correctly, received: ${resultFromAnthropic}`);
}

console.log('normalizeOllamaContent passed sample response checks.');
