import { useMemo } from 'react';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import {
  isConversationCorpusMutationActive, useConversations } from '../../store/conversations.ts';
import { toast } from '../../utils/toast.ts';

export function EmptyState() {
  // All toggled-on profiles are available on the welcome screen.
  // When none are toggled on we leave the list empty so the UI
  // can show a "toggle one on" prompt instead of silently
  // pointing at a deactivated server.
  const profiles = useProfileStore((s) => s.profiles);
  const activeProfiles = useMemo(() => profiles.filter((p) => p.active), [profiles]);
  const create = useConversations((s) => s.create);
  // The filter tab lives in the conversations store (see
  // ConversationsState.filterTab) so this welcome screen — which
  // is a sibling of the Sidebar, not a descendant — can keep
  // the tab in sync with the chat it's about to create. Without
  // this, a user on the Archive tab who clicks "Start a new chat"
  // would end up with the new active chat selected in the main
  // pane (good) but the conv-list still filtered to Archive (so
  // the new chat doesn't appear, the cycle buttons are disabled,
  // and the expanded tab pills show Archive as selected — three
  // places out of sync). Flipping the tab here keeps all four
  // surfaces in agreement.
  const setFilterTab = useConversations((s) => s.setFilterTab);

  return (
    <div className="empty-state">
      <div className="empty-state-card">
        <img src="/icons/favicon.png" alt="" className="about-modal-logo" width="48" height="48" />
        <h1>Welcome to LC</h1>
        <p>
          A local workbench for supervised, tool-assisted work with LLM models.
        </p>
        {activeProfiles.length === 0 ? (
          <div className="empty-actions">
            <p className="muted">
              {profiles.length === 0
                ? 'No active servers.'
                : 'No server is toggled on. Toggle one in the settings.'}
            </p>
          </div>
        ) : (
          <div className="empty-actions">
            <button
              className="primary-btn big"
              onClick={() => {
                if (isConversationCorpusMutationActive()) {
                  toast.info('Wait for the current response to finish before starting a new chat.');
                  return;
                }
                create({
                  serverId: activeProfiles[0].id,
                });
                // Ensure the new active chat is reachable in the
                // conv-list. The setFilterTab setter is a no-op
                // (zustand) if the value is unchanged, so calling
                // it unconditionally is cheap and avoids a
                // conditional branch.
                setFilterTab('active');
              }}
            >
              Start a new chat
            </button>
            <div className="muted small" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <br />
              <span>Active {activeProfiles.length === 1 ? 'server' : 'servers'}:</span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
                {activeProfiles.map((p) => (
                  <span className="chip active small" key={p.id}>{p.name}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
