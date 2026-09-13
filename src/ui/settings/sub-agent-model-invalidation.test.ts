/**
 * Workspace sub-agent selection invalidation — the rule that resets
 * `tools.vision_model` to '' ("Same as chat model") when the configured
 * model is no longer an active, visible, vision-capable candidate.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubAgentSelections, type SubAgentSelectionInput } from './sub-agent-model-invalidation.ts';

function input(over: Partial<SubAgentSelectionInput> = {}): SubAgentSelectionInput {
  return {
    visionModel: 'p1::model-a',
    webResearchModel: '',
    pdfSummarizeModel: '',
    activeProfileIds: new Set(['p1']),
    knownProfileIds: new Set(['p1']),
    visionCandidateKeys: new Set(['p1::model-a']),
    modelsLoading: false,
    ...over,
  };
}

describe('vision model invalidation', () => {
  test('keeps a selection that is still an active, visible vision candidate', () => {
    const result = resolveSubAgentSelections(input());
    assert.equal(result.changed, false);
    assert.equal(result.visionModel, 'p1::model-a');
  });

  test('clears a selection whose effective vision became false', () => {
    const result = resolveSubAgentSelections(input({ visionCandidateKeys: new Set() }));
    assert.equal(result.changed, true);
    assert.equal(result.visionModel, '');
  });

  test('clears a selection whose model was hidden', () => {
    // Hiding removes the model from the candidate list while the profile
    // still has other models in the registry.
    const result = resolveSubAgentSelections(input({
      visionCandidateKeys: new Set(['p1::model-b']),
    }));
    assert.equal(result.changed, true);
    assert.equal(result.visionModel, '');
  });

  test('clears a selection whose profile was deactivated', () => {
    const result = resolveSubAgentSelections(input({ activeProfileIds: new Set() }));
    assert.equal(result.changed, true);
    assert.equal(result.visionModel, '');
  });

  test('does not clear while model discovery is still running', () => {
    const result = resolveSubAgentSelections(input({
      visionCandidateKeys: new Set(),
      modelsLoading: true,
    }));
    assert.equal(result.changed, false);
    assert.equal(result.visionModel, 'p1::model-a');
  });

  test('does not clear when the profile has no models in the registry yet', () => {
    // An unreachable server with no cache: "unknown", not "invalid".
    const result = resolveSubAgentSelections(input({
      knownProfileIds: new Set(),
      visionCandidateKeys: new Set(),
    }));
    assert.equal(result.changed, false);
    assert.equal(result.visionModel, 'p1::model-a');
  });

  test('leaves an unqualified legacy model id alone', () => {
    const result = resolveSubAgentSelections(input({
      visionModel: 'model-a',
      visionCandidateKeys: new Set(),
    }));
    assert.equal(result.changed, false);
    assert.equal(result.visionModel, 'model-a');
  });

  test('leaves an empty selection alone', () => {
    const result = resolveSubAgentSelections(input({ visionModel: '', visionCandidateKeys: new Set() }));
    assert.equal(result.changed, false);
    assert.equal(result.visionModel, '');
  });

  test('a model id containing "::" only splits at the first separator', () => {
    const result = resolveSubAgentSelections(input({
      visionModel: 'p1::vendor::model',
      visionCandidateKeys: new Set(['p1::vendor::model']),
    }));
    assert.equal(result.changed, false);
  });
});

describe('web-research model invalidation', () => {
  test('clears only when its profile is no longer active', () => {
    const deactivated = resolveSubAgentSelections(input({
      visionModel: '',
      webResearchModel: 'p2::model-b',
      activeProfileIds: new Set(['p1']),
    }));
    assert.equal(deactivated.changed, true);
    assert.equal(deactivated.webResearchModel, '');

    const stillActive = resolveSubAgentSelections(input({
      visionModel: '',
      webResearchModel: 'p1::model-b',
      visionCandidateKeys: new Set(),
    }));
    assert.equal(stillActive.changed, false);
    assert.equal(stillActive.webResearchModel, 'p1::model-b');
  });

  test('both selections can be cleared in one pass', () => {
    const result = resolveSubAgentSelections(input({
      visionModel: 'p9::model-a',
      webResearchModel: 'p9::model-b',
      activeProfileIds: new Set(['p1']),
    }));
    assert.equal(result.changed, true);
    assert.equal(result.visionModel, '');
    assert.equal(result.webResearchModel, '');
  });
});

describe('pdf-summarize model invalidation', () => {
  test('clears only when its profile is no longer active', () => {
    const deactivated = resolveSubAgentSelections(input({
      visionModel: '',
      pdfSummarizeModel: 'p2::model-b',
      activeProfileIds: new Set(['p1']),
    }));
    assert.equal(deactivated.changed, true);
    assert.equal(deactivated.pdfSummarizeModel, '');

    const stillActive = resolveSubAgentSelections(input({
      visionModel: '',
      pdfSummarizeModel: 'p1::model-b',
      visionCandidateKeys: new Set(),
    }));
    assert.equal(stillActive.changed, false);
    assert.equal(stillActive.pdfSummarizeModel, 'p1::model-b');
  });

  test('a non-vision model stays selected — this picker summarizes text', () => {
    // The vision picker releases a selection that fails the vision filter.
    // This one must not: it never receives an image.
    const result = resolveSubAgentSelections(input({
      visionModel: '',
      pdfSummarizeModel: 'p1::model-b',
      knownProfileIds: new Set(['p1']),
      visionCandidateKeys: new Set(['p1::model-a']),
    }));
    assert.equal(result.changed, false);
    assert.equal(result.pdfSummarizeModel, 'p1::model-b');
  });

  test('all three selections can be cleared in one pass', () => {
    const result = resolveSubAgentSelections(input({
      visionModel: 'p9::model-a',
      webResearchModel: 'p9::model-b',
      pdfSummarizeModel: 'p9::model-c',
      activeProfileIds: new Set(['p1']),
    }));
    assert.equal(result.changed, true);
    assert.equal(result.visionModel, '');
    assert.equal(result.webResearchModel, '');
    assert.equal(result.pdfSummarizeModel, '');
  });
});
