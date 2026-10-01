import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isTauri } from '../../utils/saveBlob.ts';
import { openSupportLink } from '../settings/support-links.ts';

async function readLicenses(): Promise<string | null> {
  if (isTauri) return invoke<string | null>('read_third_party_licenses');

  // Vite serves the optional generated resource during browser development.
  // Packaged desktop releases read their own bundled inventory through IPC.
  const response = await fetch('/src-tauri/resources/THIRD_PARTY_LICENSES.md');
  if (!response.ok) return null;
  const text = await response.text();
  // A browser build without the resource may serve the SPA fallback instead.
  return text.startsWith('# Third-party licenses') ? text : null;
}

const components: Components = {
  a: ({ href, children }) => {
    if (href?.startsWith('#')) {
      return (
        <a href={href} onClick={(event) => {
          event.preventDefault();
          document.getElementById(`third-party-${href.slice(1)}`)?.scrollIntoView({ block: 'start' });
        }}>
          {children}
        </a>
      );
    }
    if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        event.preventDefault();
        void openSupportLink(href);
      }}>
        {children}
      </a>
    );
  },
  // The generated document's raw HTML anchors are skipped. Restore notice
  // targets on their headings so inventory links stay inside this view.
  h3: ({ children }) => {
    const notice = /^L\d+\b/.exec(String(children))?.[0].toLowerCase();
    return <h3 id={notice ? `third-party-${notice}` : undefined}>{children}</h3>;
  },
  table: ({ children }) => <div className="third-party-licenses-table"><table>{children}</table></div>,
  img: ({ alt }) => <span>{alt}</span>,
};

export function ThirdPartyLicenses() {
  const [document, setDocument] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    void readLicenses().then((text) => {
      if (!active) return;
      setDocument(text);
      setStatus(text ? 'ready' : 'unavailable');
    }).catch(() => {
      if (active) setStatus('error');
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="third-party-licenses-content" aria-busy={status === 'loading'}>
      {status === 'loading' && <p role="status">Loading third-party licenses…</p>}
      {status === 'unavailable' && <p role="status">Third-party licenses are included with packaged desktop releases of LC. The inventory is unavailable in this build.</p>}
      {status === 'error' && <p role="alert">Could not read the third-party licenses. Please reopen this view to try again.</p>}
      {status === 'ready' && document && (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
          {document.replace(/^# Third-party licenses\r?\n/, '')}
        </ReactMarkdown>
      )}
    </div>
  );
}
