import { isTauri } from '../../utils/saveBlob.ts';
import { toast } from '../../utils/toast.ts';

export const LC_GITHUB_URL = 'https://github.com/llm-junkie/llm-client';
export const LC_ISSUES_URL = 'https://github.com/llm-junkie/llm-client/issues';
export const LC_TEAM_LEAD_URL = 'https://github.com/rathaROG';
export const LC_CONTRIBUTORS_URL = 'https://github.com/llm-junkie/llm-client/graphs/contributors';

export async function openSupportLink(url: string): Promise<void> {
  try {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    toast.error('Could not open link in the default browser.');
  }
}
