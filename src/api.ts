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

export async function optimizeCategoriesViaLMStudio(opts: {
  baseUrl: string,
  model: string,
  directoryTree: { [category: string]: string[] },
}): Promise<{ optimizations: { from: string; to: string; reason: string }[] }> {
  const { baseUrl, model, directoryTree } = opts;
  
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

  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return only valid JSON (no markdown), with key "optimizations" containing an array of optimization suggestions.' },
        { role: 'user', content: promptTemplate },
      ],
      temperature: 0.3,
      max_tokens: -1,
      stream: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(`${resp.status} ${resp.statusText}`);
  }
  
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '{}';
  
  try {
    return JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { optimizations: [] };
  }
}
