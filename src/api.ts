// Minimal type for LM Studio OpenAI compatible API
export async function classifyViaLMStudio(opts: {
  baseUrl: string,
  model: string,
  text: string,
  originalName: string,
  categoriesHint: string[],
}): Promise<{ category_path: string; suggested_filename: string; confidence: number; raw?: any }>{
  const { baseUrl, model, text, originalName, categoriesHint } = opts
  const promptTemplate =
    "You are a file organizer. Given the text content of a file, 1) classify it into a category path with up to 3 levels like 'medical/bills' or 'finance/taxes'. 2) suggest a concise filename base (no extension) that includes provider/company and date if present. Reply in strict JSON with keys: category_path, suggested_filename, confidence (0-1)."

  const hint = categoriesHint?.length ? `\n\nExisting categories (prefer one of these if appropriate):\n- ${categoriesHint.join('\n- ')}` : ''
  const prompt = `${promptTemplate}\n\nOriginal filename: ${originalName}\nContent (truncated to 4000 chars):\n${text.slice(0, 4000)}${hint}`

  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: -1,
      stream: false,
    }),
  })

  if (!resp.ok) {
    throw new Error(`${resp.status} ${resp.statusText}`)
  }
  const data = await resp.json()
  const content = data?.choices?.[0]?.message?.content ?? '{}'
  try {
    return JSON.parse(content)
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : { category_path: 'uncategorized', suggested_filename: originalName.replace(/\.[^/.]+$/, ''), confidence: 0 }
  }
}
