// Direct Node smoke test against the live LM Studio server.
// Bypasses the browser (no CORS) and exercises the real SSE streaming path.
const BASE = process.argv[2] || 'http://192.168.31.7:1234/v1';

async function main() {
  console.log(`[smoke] target: ${BASE}`);

  // 1) list models
  const r1 = await fetch(`${BASE}/models`, { headers: { Authorization: 'Bearer lm-studio' } });
  if (!r1.ok) throw new Error(`models: ${r1.status}`);
  const j1 = await r1.json();
  console.log(`[smoke] models (${j1.data.length}):`);
  for (const m of j1.data) console.log(`         - ${m.id}`);

  // 2) pick the first non-embedding model for chat
  const chatModel = j1.data.find((m) => !m.id.includes('embed')) ?? j1.data[0];
  console.log(`[smoke] using model: ${chatModel.id}`);

  // 3) non-streaming chat
  const r2 = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' },
    body: JSON.stringify({
      model: chatModel.id,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      temperature: 0.2,
      max_tokens: 32,
    }),
  });
  if (!r2.ok) {
    const t = await r2.text();
    throw new Error(`chat: ${r2.status} ${t}`);
  }
  const j2 = await r2.json();
  console.log(`[smoke] non-stream reply: ${JSON.stringify(j2.choices?.[0]?.message?.content).slice(0, 120)}`);

  // 4) streaming chat — confirm SSE wire format
  console.log(`[smoke] streaming 1 token at a time…`);
  const r3 = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' },
    body: JSON.stringify({
      model: chatModel.id,
      messages: [{ role: 'user', content: 'Count: 1 2 3' }],
      stream: true,
      temperature: 0.2,
      max_tokens: 512,
    }),
  });
  if (!r3.ok || !r3.body) throw new Error(`stream: ${r3.status}`);
  const reader = r3.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let deltas = 0;
  let sawReasoning = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of evt.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const c = chunk.choices?.[0]?.delta?.content;
          if (c) {
            deltas += 1;
            content += c;
            process.stdout.write(c);
          }
          if (chunk.choices?.[0]?.delta?.reasoning_content) sawReasoning = true;
        } catch { /* ignore */ }
      }
    }
  }
  process.stdout.write('\n');
  console.log(`[smoke] stream done — ${deltas} delta(s), ${content.length} chars, reasoning=${sawReasoning}`);
  if (content.length === 0) throw new Error('stream produced no content');
  console.log(`[smoke] OK`);
}

main().catch((e) => {
  console.error(`[smoke] FAIL:`, e?.message ?? e);
  process.exit(1);
});
