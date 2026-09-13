import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_PARAMS, type GenerationParams } from '../types.ts';
import { PRESETS, detectPresetName, resolveParameterPreset } from './presets.ts';

function selected(name: string): GenerationParams {
  const preset = PRESETS.find((candidate) => candidate.name === name);
  assert.ok(preset);
  return {
    ...DEFAULT_PARAMS,
    ...preset.params,
    system_prompt: preset.systemPrompt,
  };
}

test('built-in presets retain their distinct generation recipes', () => {
  const dataModel = readFileSync(
    new URL('../../docs/data-model.md', import.meta.url),
    'utf8',
  );
  const expected = {
    Assistant: [0.4, 'medium'],
    Balanced: [0.7, 'medium'],
    Brainstorm: [0.9, 'low'],
    Code: [0.2, 'high'],
    Concise: [0.1, 'low'],
    Creative: [1, 'low'],
    Precise: [0.1, 'high'],
    Writer: [0.5, 'medium'],
  } as const;

  for (const preset of PRESETS) {
    const params = selected(preset.name);
    const [temperature, reasoning] =
      expected[preset.name as keyof typeof expected];
    assert.equal(params.temperature_enabled, true, preset.name);
    assert.equal(params.temperature, temperature, preset.name);
    assert.equal(params.top_p_enabled, false, preset.name);
    assert.equal(params.top_k_enabled, false, preset.name);
    assert.equal(params.max_tokens_enabled, false, preset.name);
    assert.equal(params.repeat_penalty_enabled, false, preset.name);
    assert.equal(params.reasoning_enabled, true, preset.name);
    assert.equal(params.reasoning_effort, reasoning, preset.name);
    assert.equal(params.system_prompt, preset.systemPrompt, preset.name);
    assert.ok(preset.systemPrompt.length > 20 && preset.systemPrompt.endsWith('.'), preset.name);
    assert.equal(detectPresetName(params), preset.name);
    assert.equal(resolveParameterPreset(params), preset);
    const temperatureText = temperature === 1 ? '1.0' : String(temperature);
    const documentedRow =
      `| ${preset.name} | \`${temperatureText}\` | — | — | — | — | ` +
      `\`${reasoning}\` | ${preset.systemPrompt} |`;
    assert.ok(
      dataModel.includes(documentedRow),
      `${preset.name} values and System prompt should match docs/data-model.md`,
    );
  }
});

test('system prompt edits stay visible and do not alter the generation recipe name', () => {
  const concise = selected('Concise');
  concise.system_prompt = 'Use my edited instruction.';
  assert.equal(detectPresetName(concise), 'Concise');
});

test('manual generation changes produce Custom while all-off is Server default', () => {
  const edited = { ...selected('Code'), temperature: 0.33 };
  assert.equal(detectPresetName(edited), 'Custom');
  assert.equal(detectPresetName({ ...DEFAULT_PARAMS }), 'Server default');
});

test('Parameters UI writes preset text into System prompt and Server default clears it', () => {
  const panel = readFileSync(new URL('../ui/chat/SidePanel.tsx', import.meta.url), 'utf8');
  const promptAssembly = readFileSync(
    new URL('../modules/chat-pipeline/system-prompt.ts', import.meta.url),
    'utf8',
  );
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const gettingStarted = readFileSync(
    new URL('../../docs/getting-started.md', import.meta.url),
    'utf8',
  );
  const serverDefaultBlock = panel.slice(
    panel.indexOf("className={cn('chip', isServer && 'active')}"),
    panel.indexOf('{PRESETS.map'),
  );

  assert.match(panel, /system_prompt: p\.systemPrompt/);
  assert.match(serverDefaultBlock, /system_prompt: ''/);
  assert.doesNotMatch(serverDefaultBlock, /draft\.system_prompt/);
  assert.ok(
    panel.indexOf('label="Override temperature"') <
      panel.indexOf('label="Override max output tokens"'),
    'Temperature should appear before Max output tokens',
  );
  assert.match(panel, /label="Temperature"[\s\S]*?magnets=\{\[0\.6\]\}/);
  assert.match(panel, /aria-label="Show recommended temperatures"/);
  assert.match(panel, /\['Qwen 3\.7', '0\.6 thinking · 0\.7 non-thinking'\]/);
  assert.match(panel, /left: rect\.left \+ rect\.width \/ 2/);
  assert.match(panel, /translate\(-50%, -100%\).*translateX\(-50%\)/s);
  const temperatureFamilies = [
    'Claude 5',
    'DeepSeek V4',
    'Gemini 3.x',
    'Gemma 4',
    'GLM 5.x',
    'GPT 5.x',
    'Kimi K2.7 / K3',
    'MiniMax M2.x / M3',
    'Qwen 3.5–3.6',
    'Qwen 3.7',
    'Qwen 3.8',
  ];
  for (const family of temperatureFamilies) {
    assert.ok(panel.includes(family), `${family} should appear in the temperature reference`);
  }
  for (let index = 1; index < temperatureFamilies.length; index += 1) {
    assert.ok(
      panel.indexOf(temperatureFamilies[index - 1]) < panel.indexOf(temperatureFamilies[index]),
      'Temperature recommendations should be sorted by family name',
    );
  }
  assert.match(
    panel,
    /const \[additionalParamsCollapsed, setAdditionalParamsCollapsed\] = useState\(true\)/,
  );
  assert.match(
    panel,
    /const \[primaryParamsCollapsed, setPrimaryParamsCollapsed\] = useState\(false\)/,
  );
  assert.match(panel, /<h3>Primary parameters<\/h3>/);
  assert.match(panel, /<h3>Additional parameters<\/h3>/);
  const primaryStart = panel.indexOf('<h3>Primary parameters</h3>');
  const additionalStart = panel.indexOf('<h3>Additional parameters</h3>');
  assert.ok(primaryStart < additionalStart, 'Primary parameters should appear first');
  const primaryBlock = panel.slice(primaryStart, additionalStart);
  for (const label of [
    'Thinking → reasoning effort/budget',
    'Temperature',
    'Max output tokens',
    'System prompt',
  ]) {
    assert.ok(primaryBlock.includes(label), `${label} should be in Primary parameters`);
  }
  const additionalBlock = panel.slice(additionalStart);
  for (const label of ['Top-p', 'Top-k', 'Repeat penalty', 'Stop sequences']) {
    assert.ok(additionalBlock.includes(label), `${label} should be in Additional parameters`);
  }
  assert.ok(
    additionalBlock.indexOf('Repeat penalty') < additionalBlock.indexOf('Top-p') &&
      additionalBlock.indexOf('Top-p') < additionalBlock.indexOf('Top-k') &&
      additionalBlock.indexOf('Top-k') < additionalBlock.indexOf('Stop sequences'),
    'Additional parameters should order Repeat penalty, Top-p, Top-k, then Stop sequences',
  );
  assert.match(css, /\.system-prompt \.slider-label \{\s*font-weight: 600;/);
  assert.match(gettingStarted, /temperature slider gently snaps to `0\.6`/);
  assert.match(gettingStarted, /expanded-by-default\s+\*\*Primary parameters\*\*/);
  assert.match(gettingStarted, /collapsed \*\*Additional parameters\*\*/);
  assert.doesNotMatch(panel, /preset-guidance|Preset guidance/);
  assert.doesNotMatch(promptAssembly, /Preset guidance|parameterPresetInstruction/);
  assert.doesNotMatch(css, /\.preset-guidance/);
});
