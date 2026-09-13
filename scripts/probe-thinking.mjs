/**
 * Probe an LLM endpoint to determine which thinking/reasoning params
 * are actually honored. Works with LM Studio (local), OpenAI, DeepSeek,
 * Anthropic, and any OpenAI-compatible endpoint.
 *
 * Usage:
 *   node probe-thinking.mjs [--host URL] [--model ID] [--key KEY] [--api openai|anthropic|both]
 *
 * Examples:
 *   # Local LM Studio (no key needed)
 *   node probe-thinking.mjs
 *   node probe-thinking.mjs --host http://192.168.31.7:1234 --model qwen/qwen3.6-35b-a3b
 *
 *   # DeepSeek cloud API
 *   node probe-thinking.mjs --host https://api.deepseek.com --model deepseek-v4-pro --key $env:DEEPSEEK_API_KEY --api openai
 *
 *   # OpenAI cloud API
 *   node probe-thinking.mjs --host https://api.openai.com --model gpt-4o --key $env:OPENAI_API_KEY --api openai
 *
 *   # Anthropic cloud API
 *   node probe-thinking.mjs --host https://api.anthropic.com --model claude-sonnet-4-6 --key $env:ANTHROPIC_API_KEY --api anthropic
 *
 *   # Probe only Anthropic-compat on local LM Studio
 *   node probe-thinking.mjs --api anthropic
 *
 * API key fallback order: --key arg → DEEPSEEK_API_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY
 */

// ── CLI args ────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const HOST = args.host || 'http://192.168.31.7:1234';
const MODEL = args.model || '__first__';
const API_KEY = args.key
  || process.env.DEEPSEEK_API_KEY
  || process.env.OPENAI_API_KEY
  || process.env.ANTHROPIC_API_KEY
  || '';
const API = args.api || 'both'; // 'openai' | 'anthropic' | 'both'
const isCloud = HOST.includes('api.openai.com') || HOST.includes('api.deepseek.com') || HOST.includes('api.anthropic.com');

function parseArgs(argv) {
  const m = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) { m.host = argv[++i]; }
    else if (argv[i] === '--model' && argv[i + 1]) { m.model = argv[++i]; }
    else if (argv[i] === '--key' && argv[i + 1]) { m.key = argv[++i]; }
    else if (argv[i] === '--api' && argv[i + 1]) { m.api = argv[++i]; }
    else if (!argv[i].startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${argv[i]}. Use --host or --model.`);
    }
  }
  return m;
}

// ── auth headers ────────────────────────────────────────────────
const authHeaders = {};
if (API_KEY) {
  if (HOST.includes('anthropic.com')) {
    authHeaders['x-api-key'] = API_KEY;
    authHeaders['anthropic-version'] = '2023-06-01';
  } else {
    authHeaders['Authorization'] = `Bearer ${API_KEY}`;
  }
}

async function main() {
  console.log(`🔍 Probing ${HOST} ...`);
  if (API_KEY) console.log(`🔑 Using API key (${API_KEY.slice(0, 6)}...)`);
  if (isCloud) console.log(`☁️  Cloud API detected`);
  console.log('');

  let modelId = MODEL;
  if (modelId === '__first__' && !isCloud) {
    try {
      const res = await fetch(`${HOST}/v1/models`, { headers: authHeaders });
      const data = await res.json();
      modelId = data.data?.[0]?.id;
      if (!modelId) throw new Error('No models found');
    } catch (e) {
      console.error('❌ Failed to fetch models:', e.message);
      process.exit(1);
    }
  } else if (modelId === '__first__') {
    console.error('❌ --model is required for cloud APIs');
    process.exit(1);
  }
  console.log(`📦 Model: ${modelId}\n`);

  // ── OpenAI-compat ────────────────────────────────────────────
  if (API === 'both' || API === 'openai') {
    console.log('=== OpenAI-compat (/v1/chat/completions) ===\n');

    const oaiBaseline = await testOpenAICompat(modelId, {});
    console.log(formatOAI('baseline (no params)', oaiBaseline));

    const oaiTests = [
      { name: 'thinking disabled           ', body: { thinking: { type: 'disabled' } } },
      { name: 'reasoning_effort: none      ', body: { reasoning_effort: 'none' } },
      { name: 'reasoning_effort: low       ', body: { reasoning_effort: 'low' } },
      { name: 'reasoning_effort: medium    ', body: { reasoning_effort: 'medium' } },
      { name: 'reasoning_effort: high      ', body: { reasoning_effort: 'high' } },
      { name: 'reasoning_effort: xhigh     ', body: { reasoning_effort: 'xhigh' } },
      { name: 'reasoning_effort: max       ', body: { reasoning_effort: 'max' } },
    ];

    const oaiHonors = [];
    for (const t of oaiTests) {
      const r = await testOpenAICompat(modelId, t.body);
      const changed = r.hasReasoning !== oaiBaseline.hasReasoning;
      const icon = r.ok ? '✅' : '❌';
      const thinkIcon = r.hasReasoning ? '🧠' : '💬';
      console.log(`  ${icon} ${thinkIcon} ${t.name} → ${r.detail}`);
      if (changed && r.ok) oaiHonors.push(t.name.trim());
    }

    console.log(`\nOpenAI-compat baseline: ${oaiBaseline.hasReasoning ? '🧠 model reasons by default' : '💬 model does NOT reason by default'}`);
    if (oaiHonors.length === 0) {
      console.log('  ❌ All thinking params silently ignored.\n');
    } else {
      console.log('  ✅ Params that CHANGED behavior:');
      for (const h of oaiHonors) console.log(`     - ${h}`);
      console.log('');
    }
  }

  // ── Anthropic-compat ─────────────────────────────────────────
  if (API === 'both' || API === 'anthropic') {
    console.log('=== Anthropic-compat (/v1/messages) ===\n');

    const anthBaseline = await testAnthropicCompat(modelId, {});
    console.log(formatAnth('baseline (no params)', anthBaseline));

    const anthTests = [
      { name: 'thinking disabled           ', body: { thinking: { type: 'disabled' } } },
      { name: 'thinking enabled (budget)   ', body: { thinking: { type: 'enabled', budget_tokens: 200 } } },
      { name: 'thinking adaptive           ', body: { thinking: { type: 'adaptive' } } },
      { name: 'effort: low                 ', body: { output_config: { effort: 'low' } } },
      { name: 'effort: medium              ', body: { output_config: { effort: 'medium' } } },
      { name: 'effort: high                ', body: { output_config: { effort: 'high' } } },
      { name: 'effort: xhigh               ', body: { output_config: { effort: 'xhigh' } } },
      { name: 'effort: max                 ', body: { output_config: { effort: 'max' } } },
    ];

    const anthHonors = [];
    for (const t of anthTests) {
      const r = await testAnthropicCompat(modelId, t.body);
      const changed = r.hasThinking !== anthBaseline.hasThinking;
      const icon = r.ok ? '✅' : '❌';
      const thinkIcon = r.hasThinking ? '🧠' : '💬';
      console.log(`  ${icon} ${thinkIcon} ${t.name} → ${r.detail}`);
      if (changed && r.ok) anthHonors.push(t.name.trim());
    }

    console.log(`\nAnthropic-compat baseline: ${anthBaseline.hasThinking ? '🧠 model thinks by default' : '💬 model does NOT think by default'}`);
    if (anthHonors.length === 0) {
      console.log('  ❌ All thinking params silently ignored.\n');
    } else {
      console.log('  ✅ Params that CHANGED behavior:');
      for (const h of anthHonors) console.log(`     - ${h}`);
      console.log('');
    }
  }

  console.log('Done.\n');
}

/* ── helpers ─────────────────────────────────────────────────── */

async function testOpenAICompat(model, extraBody) {
  const body = {
    model, max_tokens: 30, stream: false,
    messages: [{ role: 'user', content: 'Say hi in one word' }],
    ...extraBody,
  };
  try {
    const res = await fetch(`${HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, hasReasoning: false, detail: `HTTP ${res.status}: ${err.slice(0, 80)}` };
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    const hasReasoning = !!(msg?.reasoning_content && msg.reasoning_content.length > 0);
    const txt = (msg?.content || '').slice(0, 30);
    return { ok: true, hasReasoning, detail: hasReasoning ? `reasoning_content + "${txt}"` : `"${txt}"` };
  } catch (e) {
    return { ok: false, hasReasoning: false, detail: `Error: ${e.message}` };
  }
}

async function testAnthropicCompat(model, extraBody) {
  const body = {
    model, max_tokens: 30,
    messages: [{ role: 'user', content: 'Say hi in one word' }],
    ...extraBody,
  };
  try {
    const headers = { 'Content-Type': 'application/json', ...authHeaders };
    if (isCloud && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';

    const res = await fetch(`${HOST}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, hasThinking: false, detail: `HTTP ${res.status}: ${err.slice(0, 80)}` };
    }
    const data = await res.json();
    const blocks = data.content || [];
    const hasThinking = blocks.some(b => b.type === 'thinking');
    const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 30);
    const tc = blocks.filter(b => b.type === 'thinking').length;
    const tx = blocks.filter(b => b.type === 'text').length;
    return { ok: true, hasThinking, detail: hasThinking ? `${tc} think + ${tx} text blocks` : `${blocks.length} text block(s), no thinking` };
  } catch (e) {
    return { ok: false, hasThinking: false, detail: `Error: ${e.message}` };
  }
}

function formatOAI(name, r) {
  const icon = r.ok ? '✅' : '❌';
  const t = r.hasReasoning ? '🧠' : '💬';
  return `  ${icon} ${t} ${name.padEnd(30)} → ${r.detail}`;
}

function formatAnth(name, r) {
  const icon = r.ok ? '✅' : '❌';
  const t = r.hasThinking ? '🧠' : '💬';
  return `  ${icon} ${t} ${name.padEnd(30)} → ${r.detail}`;
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
