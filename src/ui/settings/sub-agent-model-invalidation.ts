/**
 * When a configured sub-agent model can no longer be honoured, release it.
 *
 * Pure so the rule can be tested without mounting Settings. `SettingsPage`
 * feeds it the reactive registry projection and calls `setTools` when the
 * result says something changed.
 *
 * The image-analysis picker is the strict one: its candidate list is
 * `vision === true` over EFFECTIVE metadata, so a user override that turns
 * vision off has to release the selection exactly the way deactivating the
 * profile does. Keeping a known-non-vision model configured would route
 * image analysis at a model LC already knows will reject it.
 */

import { unpackModelRef } from './SubAgentModelPicker.tsx';

export interface SubAgentSelectionInput {
  /** Currently configured packed reference, or '' for "same as chat model". */
  visionModel: string;
  webResearchModel: string;
  pdfSummarizeModel: string;
  /** Profile ids that are currently active. */
  activeProfileIds: ReadonlySet<string>;
  /** Profile ids that have at least one entry in the active projection. */
  knownProfileIds: ReadonlySet<string>;
  /** Packed `profileId::modelId` refs that pass the vision filter. */
  visionCandidateKeys: ReadonlySet<string>;
  /** True while discovery is still running. */
  modelsLoading: boolean;
}

export interface SubAgentSelectionResult {
  visionModel: string;
  webResearchModel: string;
  pdfSummarizeModel: string;
  changed: boolean;
}

function packed(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

export function resolveSubAgentSelections(input: SubAgentSelectionInput): SubAgentSelectionResult {
  let visionModel = input.visionModel;
  let webResearchModel = input.webResearchModel;
  let pdfSummarizeModel = input.pdfSummarizeModel;
  let changed = false;

  if (visionModel) {
    // A bare model ID is a legacy unqualified value; it is not a packed
    // reference to a specific profile, so there is nothing to invalidate.
    const ref = unpackModelRef(visionModel);
    if (ref) {
      if (!input.activeProfileIds.has(ref.profileId)) {
        visionModel = '';
        changed = true;
      } else if (!input.modelsLoading && input.knownProfileIds.has(ref.profileId)
        && !input.visionCandidateKeys.has(packed(ref.profileId, ref.modelId))) {
        // Only judged once the profile actually has models in the registry.
        // While discovery is running — or a server is unreachable with no
        // cache — an empty candidate list means "unknown", not "invalid",
        // and must not clear a working selection.
        visionModel = '';
        changed = true;
      }
    }
  }

  if (webResearchModel) {
    const ref = unpackModelRef(webResearchModel);
    if (ref && !input.activeProfileIds.has(ref.profileId)) {
      webResearchModel = '';
      changed = true;
    }
  }

  // Same rule as web research, and deliberately not the vision rule: this
  // picker summarizes text, so a model losing its vision capability is no
  // reason to release it. Only a deactivated profile is.
  if (pdfSummarizeModel) {
    const ref = unpackModelRef(pdfSummarizeModel);
    if (ref && !input.activeProfileIds.has(ref.profileId)) {
      pdfSummarizeModel = '';
      changed = true;
    }
  }

  return { visionModel, webResearchModel, pdfSummarizeModel, changed };
}
