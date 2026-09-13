import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMessage, LLMClient } from './client.ts';
import { LMStudioRestAdapter } from './adapters/lmstudio-rest.ts';
import { ToolCallAccumulator } from './tool-accumulator.ts';
import {
  META_MESSAGES_MAX_400_MESSAGE,
  META_MESSAGES_NONE_400_MESSAGE,
  metaMessagesErrorBody,
} from './meta-messages-first-party-fixtures.ts';
import {
  META_RESPONSES_MAX_400_MESSAGE,
  META_RESPONSES_NONE_400_MESSAGE,
  metaResponsesErrorBody,
} from './meta-responses-first-party-fixtures.ts';

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test('signal-bearing chatOnce uses the cancellable transport', async () => {
  const controller = new AbortController();
  let ordinaryFetchCalls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const client = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl: async () => {
      ordinaryFetchCalls += 1;
      throw new Error('non-cancellable transport used');
    },
    streamFetchImpl: async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.responseTimeoutMs, 300_000);
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
  });

  const request = client.chatOnce({
    model: 'research-model',
    messages: [{ role: 'user', content: 'topic' }],
    stream: false,
    reasoningEnabled: false,
  }, { signal: controller.signal });
  await started;
  controller.abort();

  await assert.rejects(request, (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  assert.equal(ordinaryFetchCalls, 0);
});

test('signal-bearing model discovery uses the cancellable transport', async () => {
  const controller = new AbortController();
  let ordinaryFetchCalls = 0;
  let receivedSignal: AbortSignal | null | undefined;
  const client = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl: async () => {
      ordinaryFetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: 'ordinary' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    streamFetchImpl: async (_input, init) => {
      receivedSignal = init?.signal;
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    },
  });

  await assert.rejects(client.listModels(controller.signal), /Aborted/);
  assert.equal(ordinaryFetchCalls, 0);
  assert.equal(receivedSignal, controller.signal);
});

test('profile request headers follow both progressive-disclosure gates', async () => {
  const captured: Headers[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(new Headers(init?.headers));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const enabled = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl,
    includeLcIdentifierHeader: true,
    includeAdditionalRequestHeaders: true,
    requestHeaders: [{ name: 'X-Profile-Name', value: 'profile-a' }],
  });
  await enabled.chatOnce({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    reasoningEnabled: false,
  });

  assert.equal(captured[0]?.get('user-agent'), 'LC/1.0.0');
  assert.equal(captured[0]?.get('x-profile-name'), 'profile-a');

  const identifierOnly = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl,
    includeLcIdentifierHeader: true,
    includeAdditionalRequestHeaders: false,
    requestHeaders: [{ name: 'X-Profile-Name', value: 'must-not-send' }],
  });
  await identifierOnly.chatOnce({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    reasoningEnabled: false,
  });

  assert.equal(captured[1]?.get('user-agent'), 'LC/1.0.0');
  assert.equal(captured[1]?.has('x-profile-name'), false);

  const customIdentifier = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl,
    includeLcIdentifierHeader: true,
    lcIdentifierHeader: { name: 'X-Agent-Identity', value: 'LC/custom' },
  });
  await customIdentifier.chatOnce({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    reasoningEnabled: false,
  });

  assert.equal(captured[2]?.has('user-agent'), false);
  assert.equal(captured[2]?.get('x-agent-identity'), 'LC/custom');

  const parentDisabled = new LLMClient({
    baseUrl: 'https://example.test/v1',
    routing: 'direct',
    fetchImpl,
    includeLcIdentifierHeader: false,
    includeAdditionalRequestHeaders: true,
    requestHeaders: [{ name: 'X-Profile-Name', value: 'must-not-send' }],
  });
  await parentDisabled.chatOnce({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    reasoningEnabled: false,
  });

  assert.equal(captured[3]?.has('user-agent'), false);
  assert.equal(captured[3]?.has('x-profile-name'), false);
});

test('chatOnce never repurposes Responses reasoning as visible output', async () => {
  const client = new LLMClient({
    baseUrl: 'https://example.test/v1',
    apiStyle: 'responses',
    routing: 'direct',
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'internal-only synthetic reasoning' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  const visible = await client.chatOnce({
    model: 'reasoning-model',
    messages: [{ role: 'user', content: 'summarize this' }],
    stream: false,
    reasoningEnabled: true,
    reasoningEffort: 'medium',
  });

  assert.equal(visible, '');
  assert.ok(!visible.includes('internal-only'));
});

test('chatStream resolves the embedded contract and does not remap provider-owned effort', async () => {
  let body: Record<string, unknown> | undefined;
  const client = new LLMClient({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    routing: 'direct',
    streamFetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sseBody('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), {
        status: 200,
      });
    },
  });
  await client.chatStream({
    model: 'gemini-future',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    reasoningEnabled: true,
    reasoningEffort: 'max',
  }, { onDelta: () => {} });
  assert.equal(body?.reasoning_effort, 'max');
  assert.equal(body?.reasoning, undefined);
});

test('unmatched providers and unregistered exact models do not borrow provider semantics', async () => {
  const requestBody = async (baseUrl: string, model: string) => {
    let body: Record<string, unknown> | undefined;
    const client = new LLMClient({
      baseUrl,
      routing: 'direct',
      streamFetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(sseBody('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      },
    });
    await client.chatStream({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }, { onDelta: () => {} });
    return body!;
  };

  const relay = await requestBody('https://relay.example/deepseek/v1', 'deepseek-chat');
  assert.equal(relay.reasoning, undefined);
  assert.equal(relay.thinking, undefined);
  assert.equal(relay.reasoning_effort, undefined);

  const unregisteredModel = await requestBody('https://api.moonshot.ai/v1', 'kimi-future');
  assert.equal(unregisteredModel.reasoning, undefined);
  assert.equal(unregisteredModel.reasoning_effort, undefined);
  assert.equal(unregisteredModel.thinking, undefined);
});

test('unlisted endpoints receive protocol-core requests without guessed reasoning controls', async () => {
  const capture = async (options: ConstructorParameters<typeof LLMClient>[0]) => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const client = new LLMClient({
      ...options,
      routing: 'direct',
      streamFetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        headers = new Headers(init?.headers);
        return new Response(sseBody('data: [DONE]\n\n'));
      },
    });
    await client.chatStream({
      model: 'future-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      maxTokens: 1234,
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      repeatPenalty: 1.1,
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }, { onDelta: () => {} });
    return { body: body!, headers: headers! };
  };

  const chat = await capture({ baseUrl: 'https://relay.example/v1' });
  assert.equal(chat.body.max_tokens, 1234);
  assert.equal(chat.body.temperature, 0.2);
  assert.equal(chat.body.top_p, 0.9);
  assert.equal(chat.body.top_k, undefined);
  assert.equal(chat.body.repeat_penalty, undefined);
  assert.equal(chat.body.repetition_penalty, undefined);
  assert.equal(chat.body.reasoning, undefined);
  assert.equal(chat.body.reasoning_effort, undefined);
  assert.equal(chat.body.thinking, undefined);

  const responses = await capture({
    baseUrl: 'https://responses-relay.example/v1',
    apiStyle: 'responses',
  });
  assert.equal(responses.body.max_output_tokens, 1234);
  assert.equal(responses.body.store, false);
  assert.equal(responses.body.reasoning, undefined);

  const messages = await capture({
    baseUrl: 'https://messages-relay.example/v1',
    apiVariant: 'anthropic',
  });
  assert.equal(messages.body.max_tokens, 1234);
  assert.equal(messages.body.thinking, undefined);
  assert.equal(messages.body.output_config, undefined);
  assert.equal(messages.body.cache_control, undefined);
  assert.equal(messages.headers.has('anthropic-version'), false);
});

test('LM Studio native named events preserve output, reasoning, and terminal metadata', async () => {
  const output: string[] = [];
  const reasoning: string[] = [];
  const result = await new LMStudioRestAdapter().parseStream(
    sseBody([
      'event: chat.start',
      'data: {"type":"chat.start"}',
      '',
      'event: reasoning.delta',
      'data: {"content":"plan"}',
      '',
      'event: message.delta',
      'data: {"content":"answer"}',
      '',
      'event: chat.end',
      'data: {"result":{"response_id":"native-response","stats":{"input_tokens":3,"total_output_tokens":5,"reasoning_output_tokens":1,"tokens_per_second":8,"time_to_first_token_seconds":0.2}}}',
      '',
      '',
    ].join('\n')),
    {
      onDelta: (chunk) => output.push(chunk),
      onReasoning: (chunk) => reasoning.push(chunk),
    },
    1_000,
    new ToolCallAccumulator(),
  );

  assert.deepEqual(output, ['answer']);
  assert.deepEqual(reasoning, ['plan']);
  assert.equal(result.content, 'answer');
  assert.equal(result.finish_reason, 'stop');
  assert.equal(result.provider_finish_reason, 'chat.end');
  assert.equal(result.lmstudio_response_id, 'native-response');
  assert.equal(result.stats?.reasoning_output_tokens, 1);
});

test('LM Studio native error events keep an error terminal state without chat.end', async () => {
  const result = await new LMStudioRestAdapter().parseStream(
    sseBody([
      'event: error',
      'data: {"error":{"message":"native stream failed"}}',
      '',
      '',
    ].join('\n')),
    { onDelta: () => {} },
    1_000,
    new ToolCallAccumulator(),
  );

  assert.equal(result.finish_reason, 'error');
  assert.equal(result.error_message, 'native stream failed');
});

test('errorMessage identifies stale dynamic imports without blaming LM Studio', () => {
  const message = errorMessage(new TypeError(
    'Failed to fetch dynamically imported module: http://localhost:5173/node_modules/.vite/deps/mermaid.js',
  ));

  assert.match(message, /Reload LC/);
  assert.doesNotMatch(message, /LM Studio|CORS/);
});

test('errorMessage keeps connection guidance for ordinary fetch failures', () => {
  const message = errorMessage(new TypeError('Failed to fetch'));

  assert.match(message, /LM Studio/);
});

test('Meta Messages resolves the exact contract: adaptive effort, Bearer auth, no rejected fields', async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const client = new LLMClient({
    baseUrl: 'https://api.meta.ai/v1',
    apiVariant: 'anthropic',
    routing: 'direct',
    apiKey: 'meta-key',
    streamFetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return new Response(sseBody('data: [DONE]\n\n'));
    },
  });
  await client.chatStream({
    model: 'muse-spark-1.3',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    maxTokens: 2048,
    reasoningEnabled: true,
    reasoningEffort: 'max',
  }, { onDelta: () => {} });
  // https://ai.developer.meta.com/docs/protocols/messages
  assert.deepEqual(body?.thinking, { type: 'adaptive' });
  assert.deepEqual(body?.output_config, { effort: 'max' });
  assert.equal(body?.top_k, undefined);
  assert.equal(body?.stop_sequences, undefined);
  assert.equal(headers?.get('authorization'), 'Bearer meta-key');
  assert.equal(headers?.has('x-api-key'), false);
  assert.equal(headers?.has('anthropic-version'), false);
});

test('Meta Messages none sends disabled and surfaces the provider 400 unchanged without retry', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  // Exact archive error body from the direct first-party Messages session.
  const errorBody = metaMessagesErrorBody(META_MESSAGES_NONE_400_MESSAGE);
  const client = new LLMClient({
    baseUrl: 'https://api.meta.ai/v1',
    apiVariant: 'anthropic',
    routing: 'direct',
    apiKey: 'meta-key',
    streamFetchImpl: async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(errorBody, { status: 400, statusText: 'Bad Request' });
    },
  });
  // Selecting none produces Meta's real request and real validation result:
  // LC must not omit the field, remap the effort, or retry the rejection.
  await assert.rejects(
    client.chatStream({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'none',
    }, { onDelta: () => {} }),
    (error: unknown) => error instanceof Error
      && /400/.test(error.message)
      && error.message.includes(errorBody),
  );
  assert.equal(calls, 1);
  assert.deepEqual(bodies[0]?.thinking, { type: 'disabled' });
  assert.equal(bodies[0]?.output_config, undefined);
});

test('Meta Messages max surfaces the provider 400 unchanged without retry', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  // Exact archive error body: `max` is not a Messages effort value and Meta
  // rejects it; LC sends it verbatim after a single attempt.
  const errorBody = metaMessagesErrorBody(META_MESSAGES_MAX_400_MESSAGE);
  const client = new LLMClient({
    baseUrl: 'https://api.meta.ai/v1',
    apiVariant: 'anthropic',
    routing: 'direct',
    apiKey: 'meta-key',
    streamFetchImpl: async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(errorBody, { status: 400, statusText: 'Bad Request' });
    },
  });
  await assert.rejects(
    client.chatStream({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }, { onDelta: () => {} }),
    (error: unknown) => error instanceof Error
      && /400/.test(error.message)
      && error.message.includes(errorBody),
  );
  assert.equal(calls, 1);
  assert.deepEqual(bodies[0]?.output_config, { effort: 'max' });
});

test('Meta Chat and Responses send every effort unchanged, including none', async () => {
  const requestBody = async (options: ConstructorParameters<typeof LLMClient>[0], effort: string) => {
    let body: Record<string, unknown> | undefined;
    const client = new LLMClient({
      ...options,
      routing: 'direct',
      streamFetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(sseBody('data: [DONE]\n\n'));
      },
    });
    await client.chatStream({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: effort,
    }, { onDelta: () => {} });
    return body!;
  };

  const chatMax = await requestBody({ baseUrl: 'https://api.meta.ai/v1' }, 'max');
  assert.equal(chatMax.reasoning_effort, 'max');
  const chatNone = await requestBody({ baseUrl: 'https://api.meta.ai/v1' }, 'none');
  assert.equal(chatNone.reasoning_effort, 'none');

  const responsesNone = await requestBody({ baseUrl: 'https://api.meta.ai/v1', apiStyle: 'responses' }, 'none');
  assert.deepEqual(responsesNone.reasoning, { effort: 'none', summary: 'auto' });
  assert.deepEqual(responsesNone.include, ['reasoning.encrypted_content']);
  assert.equal(responsesNone.store, false);
});

test('lookalike origins and relays never receive Meta behavior', async () => {
  const requestBody = async (baseUrl: string, apiVariant?: 'anthropic') => {
    let body: Record<string, unknown> | undefined;
    const client = new LLMClient({
      baseUrl,
      ...(apiVariant ? { apiVariant } : {}),
      routing: 'direct',
      streamFetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(sseBody('data: [DONE]\n\n'));
      },
    });
    await client.chatStream({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }, { onDelta: () => {} });
    return body!;
  };

  const lookalike = await requestBody('https://foo.meta.ai/v1', 'anthropic');
  assert.equal(lookalike.thinking, undefined);
  assert.equal(lookalike.output_config, undefined);

  const zen = await requestBody('https://opencode.ai/zen/v1');
  assert.equal(zen.reasoning_effort, undefined);
  assert.equal(zen.reasoning, undefined);
  assert.equal(zen.thinking, undefined);

  // The bare origin resolves only where endpoint joining is verified.
  const bareMessages = await requestBody('https://api.meta.ai', 'anthropic');
  assert.deepEqual(bareMessages.thinking, { type: 'adaptive' });
  const bareChat = await requestBody('https://api.meta.ai');
  assert.equal(bareChat.reasoning_effort, undefined);
});

test('Meta Responses surfaces the first-party none/max validation errors unchanged without retry', async () => {
  // Exact archive error shapes from the direct first-party session: LC sends
  // the selected effort verbatim and surfaces Meta's real 400 after one
  // attempt — no omission, no remap to xhigh, no retry.
  for (const [effort, message] of [
    ['none', META_RESPONSES_NONE_400_MESSAGE],
    ['max', META_RESPONSES_MAX_400_MESSAGE],
  ] as const) {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const client = new LLMClient({
      baseUrl: 'https://api.meta.ai/v1',
      apiStyle: 'responses',
      routing: 'direct',
      apiKey: 'meta-key',
      streamFetchImpl: async (_input, init) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(metaResponsesErrorBody(message), { status: 400, statusText: 'Bad Request' });
      },
    });
    await assert.rejects(
      client.chatStream({
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        reasoningEnabled: true,
        reasoningEffort: effort,
      }, { onDelta: () => {} }),
      (error: unknown) => error instanceof Error
        && /400/.test(error.message)
        && error.message.includes(metaResponsesErrorBody(message)),
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      (bodies[0]?.reasoning as Record<string, unknown> | undefined)?.effort,
      effort,
    );
  }
});
