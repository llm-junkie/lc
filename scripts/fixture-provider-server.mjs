/**
 * Provider product-validation fixture.
 *
 * - `/lm/v1/*` is a CORS-safe pass-through to an already-running LM Studio
 *   OpenAI-compatible server. It never calls the model load/unload APIs.
 * - `/openai/v1/*`, `/anthropic/v1/*`, and `/responses/v1/*` provide small,
 *   deterministic tool-call streams for rebuilt-browser validation.
 * - An OpenAI prompt containing `AUDIT_LONG_REASONING` emits a deterministic
 *   256 KiB reasoning stream for preview-overlay performance checks.
 * - AUDIT_LONG_REASONING_UNBROKEN emits an 8 MiB single-block stream for
 *   live splitter and frame-delay checks.
 * - AUDIT_LONG_REASONING_UNBROKEN_HOLD sends the same bytes, then holds the
 *   stream open for 60 seconds to separate live accumulation from completion.
 * - AUDIT_LONG_REASONING_BOUNDARY_1024 emits 8 MiB as repeated 1,024-character
 *   runs separated by spaces to exercise the tokenizer guard boundary.
 * - `AUDIT_CONCURRENCY` emits a two-minute text stream so browser acceptance
 *   can observe three live chats, fourth-chat refusal, and targeted cancel.
 *
 * Run with:
 *   LC_AUDIT_LM_STUDIO_URL=http://127.0.0.1:1234 node scripts/fixture-provider-server.mjs
 */
import { createServer } from 'node:http';

const port = Number(process.env.LC_AUDIT_FIXTURE_PORT || 4786);
const lmStudioUrl = (process.env.LC_AUDIT_LM_STUDIO_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const lmStudioModel = process.env.LC_AUDIT_LM_STUDIO_MODEL || 'qwen/qwen3.6-35b-a3b';

function corsHeaders(contentType = 'application/json') {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': '*',
    'cache-control': 'no-store',
    'content-type': contentType,
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(value));
}

function openSse(res) {
  res.writeHead(200, corsHeaders('text/event-stream; charset=utf-8'));
}

function writeSse(res, value, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function hasOpenAiToolResult(body) {
  return Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'tool');
}

function hasAnthropicToolResult(body) {
  return Array.isArray(body.messages) && body.messages.some((message) =>
    Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result'));
}

function hasResponsesToolResult(body) {
  return Array.isArray(body.input) && body.input.some((item) => item?.type === 'function_call_output');
}

function requestText(body) {
  if (typeof body.input === 'string') return body.input;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((message) => {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content.map((part) => part?.text || part?.content || '').join(' ');
  }).join(' ');
}

function openAiToolStream(res) {
  openSse(res);
  writeSse(res, {
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_audit_openai',
          type: 'function',
          function: { name: 'lc_get_current_time', arguments: '{"tz":"UTC"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  writeSse(res, '[DONE]');
  res.end();
}

function openAiTextStream(res, text = 'OpenAI Chat tool round completed.') {
  openSse(res);
  writeSse(res, {
    id: 'chatcmpl-fixture-final',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  });
  writeSse(res, '[DONE]');
  res.end();
}

async function openAiFreezeStream(res, chunkCount = 80) {
  openSse(res);
  for (let index = 0; index < chunkCount && !res.destroyed; index += 1) {
    writeSse(res, {
      id: 'chatcmpl-fixture-freeze',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: `${index} ` }, finish_reason: null }],
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  if (!res.destroyed) {
    writeSse(res, {
      id: 'chatcmpl-fixture-freeze',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    writeSse(res, '[DONE]');
    res.end();
  }
}

const LONG_REASONING_CHARS = 256 * 1_024;
const LONG_REASONING_CHUNK_CHARS = 4_096;
const UNBROKEN_REASONING_CHARS = 8 * 1_024 * 1_024;
const BOUNDARY_REASONING_BLOCK = `${'x'.repeat(1_024)} `;
const BOUNDARY_REASONING = BOUNDARY_REASONING_BLOCK
  .repeat(Math.ceil(UNBROKEN_REASONING_CHARS / BOUNDARY_REASONING_BLOCK.length))
  .slice(0, UNBROKEN_REASONING_CHARS);

function makeReasoningChunk(index, size) {
  const line = `Reasoning segment ${String(index).padStart(4, '0')} explores a distinct branch, checks evidence, and records a bounded conclusion.\n\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

async function openAiLongReasoningStream(res) {
  openSse(res);
  let sent = 0;
  let index = 0;
  while (sent < LONG_REASONING_CHARS && !res.destroyed) {
    const size = Math.min(LONG_REASONING_CHUNK_CHARS, LONG_REASONING_CHARS - sent);
    writeSse(res, {
      id: 'chatcmpl-fixture-long-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { reasoning_content: makeReasoningChunk(index, size) },
        finish_reason: null,
      }],
    });
    sent += size;
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!res.destroyed) {
    writeSse(res, {
      id: 'chatcmpl-fixture-long-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: 'Long-reasoning fixture completed.' },
        finish_reason: 'stop',
      }],
    });
    writeSse(res, '[DONE]');
    res.end();
  }
}

async function openAiUnbrokenReasoningStream(res, holdAfterStream = false) {
  openSse(res);
  let sent = 0;
  while (sent < UNBROKEN_REASONING_CHARS && !res.destroyed) {
    const size = Math.min(
      LONG_REASONING_CHUNK_CHARS,
      UNBROKEN_REASONING_CHARS - sent,
    );
    writeSse(res, {
      id: 'chatcmpl-fixture-unbroken-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { reasoning_content: 'x'.repeat(size) },
        finish_reason: null,
      }],
    });
    sent += size;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  if (holdAfterStream && !res.destroyed) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  if (!res.destroyed) {
    writeSse(res, {
      id: 'chatcmpl-fixture-unbroken-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: 'Unbroken reasoning fixture completed.' },
        finish_reason: 'stop',
      }],
    });
    writeSse(res, '[DONE]');
    res.end();
  }
}

async function openAiBoundaryReasoningStream(res) {
  openSse(res);
  let sent = 0;
  while (sent < BOUNDARY_REASONING.length && !res.destroyed) {
    const end = Math.min(
      sent + LONG_REASONING_CHUNK_CHARS,
      BOUNDARY_REASONING.length,
    );
    writeSse(res, {
      id: 'chatcmpl-fixture-boundary-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { reasoning_content: BOUNDARY_REASONING.slice(sent, end) },
        finish_reason: null,
      }],
    });
    sent = end;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  if (!res.destroyed) {
    console.log(`Boundary reasoning terminal sent at ${Date.now()}`);
    writeSse(res, {
      id: 'chatcmpl-fixture-boundary-reasoning',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: 'Boundary reasoning fixture completed.' },
        finish_reason: 'stop',
      }],
    });
    writeSse(res, '[DONE]');
    res.end();
  }
}

function anthropicToolStream(res) {
  openSse(res);
  writeSse(res, {
    type: 'message_start',
    message: {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'audit-anthropic',
      content: [], usage: { input_tokens: 5, output_tokens: 0 },
    },
  }, 'message_start');
  writeSse(res, {
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'call_audit_anthropic', name: 'lc_get_current_time', input: {} },
  }, 'content_block_start');
  writeSse(res, {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"tz":"UTC"}' },
  }, 'content_block_delta');
  writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  writeSse(res, {
    type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 5 },
  }, 'message_delta');
  writeSse(res, { type: 'message_stop' }, 'message_stop');
  res.end();
}

function anthropicTextStream(res) {
  openSse(res);
  writeSse(res, {
    type: 'message_start',
    message: {
      id: 'msg_fixture_final', type: 'message', role: 'assistant', model: 'audit-anthropic',
      content: [], usage: { input_tokens: 8, output_tokens: 0 },
    },
  }, 'message_start');
  writeSse(res, {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' },
  }, 'content_block_start');
  writeSse(res, {
    type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: 'Anthropic tool round completed.' },
  }, 'content_block_delta');
  writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  writeSse(res, {
    type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 6 },
  }, 'message_delta');
  writeSse(res, { type: 'message_stop' }, 'message_stop');
  res.end();
}

function responsesToolStream(res) {
  openSse(res);
  const item = {
    id: 'fc_fixture', type: 'function_call', status: 'in_progress',
    call_id: 'call_audit_responses', name: 'lc_get_current_time', arguments: '',
  };
  writeSse(res, { type: 'response.output_item.added', output_index: 0, item });
  writeSse(res, {
    type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0,
    delta: '{"tz":"UTC"}',
  });
  writeSse(res, {
    type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0,
    name: item.name, arguments: '{"tz":"UTC"}',
  });
  const completedItem = { ...item, status: 'completed', arguments: '{"tz":"UTC"}' };
  writeSse(res, { type: 'response.output_item.done', output_index: 0, item: completedItem });
  writeSse(res, {
    type: 'response.completed',
    response: {
      id: 'resp_fixture', status: 'completed', output: [completedItem],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    },
  });
  res.end();
}

function responsesTextStream(res) {
  openSse(res);
  const item = {
    id: 'msg_fixture_final', type: 'message', role: 'assistant', status: 'in_progress',
    content: [{ type: 'output_text', text: '', annotations: [] }],
  };
  writeSse(res, { type: 'response.output_item.added', output_index: 0, item });
  writeSse(res, {
    type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0,
    delta: 'Responses tool round completed.',
  });
  const completedItem = {
    ...item, status: 'completed',
    content: [{ type: 'output_text', text: 'Responses tool round completed.', annotations: [] }],
  };
  writeSse(res, { type: 'response.output_item.done', output_index: 0, item: completedItem });
  writeSse(res, {
    type: 'response.completed',
    response: {
      id: 'resp_fixture_final', status: 'completed', output: [completedItem],
      usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
    },
  });
  res.end();
}

async function proxyLmStudio(req, res, pathname) {
  const upstreamPath = pathname.replace(/^\/lm/, '');
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Buffer.from(JSON.stringify(await readJson(req)));
  }
  const upstream = await fetch(`${lmStudioUrl}${upstreamPath}`, init);
  res.writeHead(upstream.status, corsHeaders(upstream.headers.get('content-type') || 'application/json'));
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, lmStudioUrl, lmStudioModel });
      return;
    }
    if (pathname === '/lm/v1/models') {
      sendJson(res, 200, { data: [{ id: lmStudioModel, object: 'model', owned_by: 'lm-studio' }] });
      return;
    }
    if (pathname === '/lm/v1/chat/completions') {
      await proxyLmStudio(req, res, '/lm/v1/chat/completions');
      return;
    }

    if (pathname.endsWith('/models')) {
      const model = pathname.startsWith('/anthropic/')
        ? 'audit-anthropic'
        : pathname.startsWith('/responses/')
          ? 'audit-responses'
          : 'audit-openai-chat';
      sendJson(res, 200, { data: [{ id: model, object: 'model', owned_by: 'lc-fixture' }] });
      return;
    }

    if (pathname === '/openai/v1/chat/completions') {
      const body = await readJson(req);
      if (requestText(body).includes('AUDIT_LONG_REASONING_BOUNDARY_1024')) {
        await openAiBoundaryReasoningStream(res);
      } else if (requestText(body).includes('AUDIT_LONG_REASONING_UNBROKEN_HOLD')) {
        await openAiUnbrokenReasoningStream(res, true);
      } else if (requestText(body).includes('AUDIT_LONG_REASONING_UNBROKEN')) {
        await openAiUnbrokenReasoningStream(res);
      } else if (requestText(body).includes('AUDIT_LONG_REASONING')) {
        await openAiLongReasoningStream(res);
      } else if (requestText(body).includes('AUDIT_CONCURRENCY')) {
        await openAiFreezeStream(res, 1_600);
      } else if (requestText(body).includes('AUDIT_FREEZE')) {
        await openAiFreezeStream(res);
      } else if (hasOpenAiToolResult(body)) {
        openAiTextStream(res);
      } else {
        openAiToolStream(res);
      }
      return;
    }
    if (pathname === '/anthropic/v1/messages') {
      const body = await readJson(req);
      if (hasAnthropicToolResult(body)) anthropicTextStream(res);
      else anthropicToolStream(res);
      return;
    }
    if (pathname === '/responses/v1/responses') {
      const body = await readJson(req);
      if (hasResponsesToolResult(body)) responsesTextStream(res);
      else responsesToolStream(res);
      return;
    }

    sendJson(res, 404, { error: `No fixture route for ${pathname}` });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    else res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Provider fixture listening at http://127.0.0.1:${port}`);
  console.log(`LM Studio pass-through: ${lmStudioUrl} (${lmStudioModel}; no load/unload calls)`);
});
