/**
 * Title rules — unit assertions plus the 50-sample context sweep revived
 * from the old `scripts/title-test.mjs`. The old script rated titles
 * GOOD/OK/BAD by eye and embedded a copy of the rules that drifted; this
 * imports the production module the store applies and asserts it.
 *
 * Run with:
 *   node --experimental-strip-types --test src/utils/conversation-title.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONVERSATION_TITLE,
  initialConversationTitle,
  conversationTitleAfterAppend,
} from './conversation-title.ts';

const firstUser = (content: string) =>
  conversationTitleAfterAppend(DEFAULT_CONVERSATION_TITLE, 'user', content);

test('initial title: explicit titles are trimmed, absent/blank becomes the default', () => {
  assert.equal(initialConversationTitle(), DEFAULT_CONVERSATION_TITLE);
  assert.equal(initialConversationTitle('   '), DEFAULT_CONVERSATION_TITLE);
  assert.equal(initialConversationTitle('  My audit  '), 'My audit');
});

test('rename: only from the default title, only on user messages', () => {
  assert.equal(conversationTitleAfterAppend('kept title', 'user', 'hi'), 'kept title');
  assert.equal(
    conversationTitleAfterAppend(DEFAULT_CONVERSATION_TITLE, 'assistant', 'hi'),
    DEFAULT_CONVERSATION_TITLE,
  );
  assert.equal(
    conversationTitleAfterAppend(DEFAULT_CONVERSATION_TITLE, 'tool', '{}'),
    DEFAULT_CONVERSATION_TITLE,
  );
});

test('rename: first line, trimmed, hard-cut at 60', () => {
  assert.equal(firstUser('ok'), 'ok');
  assert.equal(firstUser('  x  '), 'x');
  assert.equal(firstUser('line one\nline two'), 'line one');
  assert.equal(firstUser('a'.repeat(60)), 'a'.repeat(60));
  assert.equal(firstUser('a'.repeat(61)), 'a'.repeat(60));
  assert.equal(
    firstUser('how do i reverse a linked list in python'),
    'how do i reverse a linked list in python',
  );
});

test('rename: whitespace-only content keeps the default', () => {
  assert.equal(firstUser(''), DEFAULT_CONVERSATION_TITLE);
  assert.equal(firstUser('   \n  '), DEFAULT_CONVERSATION_TITLE);
});

// The old sweep corpus — one sample per context class. Under the current
// rules every non-blank sample becomes its first line at ≤60 chars; the
// sweep asserts those invariants instead of the old script's subjective
// rating.
const SWEEP: Array<[string, string]> = [
  // URL-focused
  ['hi check https://platform.minimax.io/subscribe/token-plan?tab=individual and give me a summary', 'URL'],
  ['can you look at https://github.com/rust-lang/regex/issues and tell me what happened', 'URL'],
  ['https://arxiv.org/abs/2312.11805 summarize this paper pls', 'URL'],
  ['fetch https://docs.python.org/3/library/asyncio.html and explain', 'URL'],
  ['what does https://crates.io/crates/serde say about version 2.0', 'URL'],
  // Short questions
  ['how do i reverse a linked list in python', 'coding'],
  ['what is the capital of france', 'factual'],
  ['explain the theory of relativity in simple terms', 'explain'],
  ['write a dockerfile for a node.js app with postgres', 'coding'],
  ['can you help me debug this rust borrow checker error', 'debug'],
  // Commands
  ['list all files in my home directory', 'command'],
  ['create a new react component for a login form', 'coding'],
  ['run git status and show me what changed', 'command'],
  ['install python dependencies from requirements.txt', 'command'],
  // Conversational
  ['hi there how are you today', 'greeting'],
  ['thanks that really helped a lot', 'thanks'],
  ['good morning can you review my code', 'review'],
  ['hey i have a question about your capabilities', 'meta'],
  // Long messages
  ['i need to build a full stack app with react frontend, node backend, postgres database, and deploy it to aws', 'long'],
  ['my authentication system keeps failing when users reset their password. the email link works but token expires immediately', 'long'],
  // Mixed URL + task
  ['check this url https://example.com and tell me if the css is accessible', 'URL+'],
  ['please help me understand monads in haskell with practical examples', 'concept'],
  ['write a python script that scrapes reddit and stores posts in sqlite', 'script'],
  // Edge cases
  ['ok', 'short'],
  ['', 'empty'],
  ['please please please help me i am stuck on this problem for 3 days', 'edge'],
  ['how does jwt authentication work and why should i use it over session cookies', 'compare'],
  // News/research
  ['what are the latest developments in quantum computing 2026', 'news'],
  ['compare gpt-5 vs claude 4 for coding tasks with benchmarks', 'compare'],
  ['explain the new eu ai act regulations and how they affect startups', 'legal'],
  // Code review
  ['review this pr diff for security vulnerabilities please', 'review'],
  ['can you refactor this function to use async await instead of promises', 'refactor'],
  ['find the memory leak in my c++ code', 'debug'],
  // System/ops
  ['my docker containers keep crashing with exit code 137 what does that mean', 'ops'],
  ['how to optimize postgres query that takes 30 seconds to run', 'db'],
  ['setup ci/cd pipeline with github actions for a monorepo', 'devops'],
  // Creative
  ['write a short story about a robot learning to paint', 'creative'],
  ['generate a poem about machine learning in the style of shakespeare', 'creative'],
  ['create a database schema for an e-commerce platform with products orders and users', 'schema'],
  // Platform-specific
  ['powershell script to find all files larger than 100mb recursively', 'shell'],
  ['how to fix npm install errors on windows 11', 'help'],
  // Tool-related
  ['search the web for the latest typescript 6 features', 'search'],
  ['read the file C:\\projects\\config.json and show me the contents', 'file'],
  ['run cmd /c dir D:\\DEV\\home and list all folders', 'shell'],
  // Multi-URL
  ['compare these two docs: https://react.dev/reference/react/useEffect and https://vuejs.org/api/reactivity-core.html#watch', 'multiURL'],
  ['can you check https://news.ycombinator.com and give me the top 5 stories', 'URL'],
  // Advice
  ['i am learning rust what should i build first', 'advice'],
  ['how to become a better programmer in 2026', 'advice'],
  ['what are some good open source projects to contribute to', 'advice'],
  // Technical
  ['implement a bloom filter in go with configurable false positive rate', 'algo'],
  ['explain the difference between protobuf and flatbuffers with performance numbers', 'compare'],
  ['write unit tests for this react custom hook using vitest', 'test'],
];

test('sweep: every context class produces a usable bounded title', () => {
  assert.equal(SWEEP.length, 52, 'the revived corpus is 52 samples');
  for (const [msg, cat] of SWEEP) {
    const title = firstUser(msg);
    assert.ok(title.length > 0, `${cat}: empty title`);
    assert.ok(title.length <= 60, `${cat}: title exceeds 60 chars: "${title}"`);
    assert.equal(title, title.trim(), `${cat}: title has edge whitespace`);
    assert.ok(!title.includes('\n'), `${cat}: title spans lines`);
    if (msg.trim()) {
      assert.equal(title, msg.trim().split('\n')[0].slice(0, 60).trim(), `${cat}: first-line rule violated`);
    } else {
      assert.equal(title, DEFAULT_CONVERSATION_TITLE, `${cat}: blank input must keep the default`);
    }
  }
});
