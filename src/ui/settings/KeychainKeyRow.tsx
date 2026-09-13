import { useRef, useState } from 'react';
import { keychainGet } from '../../platform/keychain.ts';
import { toast } from '../../utils/toast.ts';

/** Outcome of a commit, so the caller can report what actually happened. */
export type KeyCommitResult = 'none' | 'saved' | 'cleared' | 'fallback';

/** Stand-in for a key that lives in the encrypted local key store and has not
 *  been fetched. A blurred field renders `type="password"`, so a real value is
 *  masked by the browser. A key-store-backed key has no value in the DOM, and
 *  an empty field would read as "no key set". Fixed width so it leaks nothing
 *  about the real key's length. */
const KEY_MASK = '••••••••••••••••••••••••••••••••••••••••••••••••';

interface Props {
  id: string;
  name: string;
  /** Placeholder shown when no key is stored yet. */
  placeholder: string;
  /** Plaintext value from settings — the fallback when no keychain ref
   *  exists (web build, or a failed keychain write). */
  storedKey: string;
  /** Key-store ref, when the key lives in the encrypted local key store. */
  storedRef?: string;
  /** Decrypted value this session is already holding, if any. Used when the
   *  keychain read comes back empty so the field does not reveal a blank. */
  liveKey: string | null;
  /** Persist a trimmed value, or `''` to clear. */
  onCommit: (value: string) => Promise<KeyCommitResult>;
  /** Used for the button's title/aria-label and the toasts. */
  label: string;
}

/**
 * An API-key field that reveals on focus.
 *
 * Blurred it is masked; focused it shows the real key in the clear and is
 * directly editable — no separate show/hide toggle to hunt for. A
 * keychain-backed key is fetched on focus, since there is nothing in the DOM
 * to unmask until then.
 *
 * Edits commit on blur *or* via the explicit save button. The button exists so
 * the save is legible and so its outcome can be reported accurately; the blur
 * commit stays because losing a typed key by clicking elsewhere would be worse.
 */
export function KeychainKeyRow({
  id, name, placeholder, storedKey, storedRef, liveKey, onCommit, label,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  // In-progress edit. Held here rather than in the settings store so
  // keystrokes never reach localStorage. `null` means "not edited".
  const [draft, setDraft] = useState<string | null>(null);
  // Set on the save button's mousedown so the input's blur — which fires
  // first — defers the commit to the button's click handler instead of
  // racing it. Without this the key is written twice and the button cannot
  // report whether the write actually succeeded.
  const saveRef = useRef(false);

  const isKeychain = !!(storedRef && !storedKey);

  const commit = async (): Promise<KeyCommitResult> => {
    if (draft === null) return 'none';
    const value = draft.trim();
    setDraft(null);
    setFetched(null);
    return onCommit(value);
  };

  const displayValue = focused
    ? (draft ?? fetched ?? storedKey ?? '')
    : (isKeychain ? KEY_MASK : (storedKey ?? ''));

  return (
    <div className="api-key-row">
      <input
        id={id}
        name={name}
        type={focused ? 'text' : 'password'}
        autoComplete="off"
        value={displayValue}
        onFocus={async () => {
          setFocused(true);
          if (isKeychain && fetched === null) {
            const val = await keychainGet(storedRef!).catch(() => null);
            // Fall back to the decrypted copy this session already holds.
            // Without it, any build where the keychain read comes back empty
            // (the web build no-ops it entirely) reveals a blank field and
            // reads as "the key is gone".
            setFetched(val || liveKey || '');
          }
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          // The save button's mousedown claimed this commit — let its click
          // handler run so it can report the real outcome.
          if (saveRef.current) return;
          setFetched(null);
          void commit();
        }}
        placeholder={isKeychain ? 'Stored securely — click to reveal and edit' : placeholder}
      />
      <button
        type="button"
        className="bubble-icon-btn"
        onMouseDown={() => { saveRef.current = true; }}
        onClick={async () => {
          saveRef.current = false;
          const hadEdit = draft !== null;
          const result = await commit();
          setFocused(false);
          if (!hadEdit) toast.info('No changes to save.');
          else if (result === 'cleared') toast.success(`${label} cleared.`);
          else if (result === 'saved') toast.success(`${label} saved.`);
          else toast.error('Could not store the key securely — kept as a local fallback.');
        }}
        title={`Save ${label}`}
        aria-label={`Save ${label}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      </button>
    </div>
  );
}
