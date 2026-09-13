import {
  clearGenerationPhase,
  getPhase,
  onPhaseChange,
  reasoningFinished,
  reasoningRunning,
  reasoningStarted,
  resetAll,
  textResponseFinished,
  textResponseRunning,
  textResponseStarted,
  toolUseFinished,
  toolUseRunning,
  toolUseStarted,
} from '../../store/responseStatus.ts';
import {
  isGenerationSessionOwner,
  setGenerationSessionPhase,
} from './generation-session-manager.ts';

export type PipelinePhase = 'idle' | 'reasoning' | 'tool-use' | 'text-response';

export function createGenerationPhaseTracker(conversationId: string, generationId: string) {
  const ownsSession = () => isGenerationSessionOwner(conversationId, generationId);
  return {
    get current(): PipelinePhase {
      if (!ownsSession()) return 'idle';
      const phase = getPhase(conversationId);
      if (phase.reasoning === 'running' || phase.reasoning === 'started') return 'reasoning';
      if (phase.toolUse === 'running' || phase.toolUse === 'started') return 'tool-use';
      if (phase.textResponse === 'running' || phase.textResponse === 'started') return 'text-response';
      return 'idle';
    },
    reset() {
      if (!ownsSession()) return;
      resetAll(conversationId, generationId);
      setGenerationSessionPhase(conversationId, generationId, 'running');
    },
    clear() { clearGenerationPhase(conversationId, generationId); },
    reasoning: {
      started() {
        if (!ownsSession()) return;
        reasoningStarted(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'thinking');
      },
      running() {
        if (!ownsSession()) return;
        reasoningRunning(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'thinking');
      },
      finished() {
        if (ownsSession()) reasoningFinished(conversationId, generationId);
      },
    },
    toolUse: {
      started() {
        if (!ownsSession()) return;
        toolUseStarted(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'using-tools');
      },
      running() {
        if (!ownsSession()) return;
        toolUseRunning(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'using-tools');
      },
      finished() {
        if (ownsSession()) toolUseFinished(conversationId, generationId);
      },
    },
    textResponse: {
      started() {
        if (!ownsSession()) return;
        textResponseStarted(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'writing');
      },
      running() {
        if (!ownsSession()) return;
        textResponseRunning(conversationId, generationId);
        setGenerationSessionPhase(conversationId, generationId, 'writing');
      },
      finished() {
        if (ownsSession()) textResponseFinished(conversationId, generationId);
      },
    },
    onChange(callback: (phase: PipelinePhase) => void): () => void {
      return onPhaseChange(conversationId, (raw) => {
        if (!ownsSession()) return;
        if (raw.reasoning === 'running' || raw.reasoning === 'started') callback('reasoning');
        else if (raw.toolUse === 'running' || raw.toolUse === 'started') callback('tool-use');
        else if (raw.textResponse === 'running' || raw.textResponse === 'started') callback('text-response');
        else callback('idle');
      });
    },
  };
}
