import * as production from '../src/application/prompts.ts';
import { evidenceCatalog, parseCandidate, validateCandidateEvidence } from '../src/application/notice-candidate.ts';

function productionInput(input) {
  if (!input || typeof input.revisionId !== 'string' || typeof input.text !== 'string') throw new Error('APPLICATION_PROMPT_CONTEXT_REQUIRED');
  // A target is exposed only after actual preceding output was validated.
  // Prior output and golden answers are never sent as request-builder input.
  if (input.prior) parseCandidate(JSON.stringify(input.prior));
  return { textRevisionId: input.revisionId, text: input.text, evidenceCatalog: evidenceCatalog(input.text),
    selectedCaseId: input.prior ? input.selectedCaseId : undefined,
    selectedTaskId: input.prior ? input.selectedTaskId : undefined };
}

/** Pure prompt selection/validation: no provider, database, environment, or gold. */
export function createApplicationPromptSelector() {
  return {
    promptVersion: production.PROMPT_VERSION,
    catalog: evidenceCatalog,
    vision: () => production.buildVisionPrompt(),
    visionRepair: (previous) => production.buildVisionRepairPrompt(previous, '视觉识别没有返回 {text:string} JSON'),
    extraction: (input) => production.buildExtractionRequestPrompt(productionInput(input)),
    candidateRepair: (previous, input) => production.buildCandidateRepairRequestPrompt(previous, '候选 JSON 结构不符合 NoticeCandidate schema', productionInput(input)),
    candidate: (raw, revisionId, catalogItems) => {
      const candidate = parseCandidate(raw);
      validateCandidateEvidence(candidate, revisionId, catalogItems);
      return candidate;
    },
  };
}
