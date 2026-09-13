/**
 * Capability glyphs shared by the model-visibility rows.
 *
 * The reasoning brain and the wrench+screwdriver are the same paths already
 * used in `MessageBubble.tsx` / `SidePanel.tsx`, so "reasoning" and "tools"
 * read identically wherever they appear. The eye is new — a lucide-style
 * stroke outline drawn to match the brain's weight.
 *
 * Each icon is `aria-hidden`; the accessible name belongs on the badge
 * wrapper, because colour and shape alone do not name a capability.
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Brain outline — the reasoning glyph from MessageBubble. */
export function ReasoningIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="2 2 20 20" width={size} height={size} {...STROKE}>
      <path d="M9.5 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 5 10v1a3 3 0 0 0 1.5 2.6V14a3 3 0 0 0 3 3h.5" />
      <path d="M14.5 4a3 3 0 0 1 3 3v.5A3 3 0 0 1 19 10v1a3 3 0 0 1-1.5 2.6V14a3 3 0 0 1-3 3H14" />
      <path d="M12 8v6" />
      <path d="M9.5 11h5" />
      <path d="M10 14h4" />
    </svg>
  );
}

/** Eye outline — the vision glyph. */
export function VisionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

/** Crossed wrench + screwdriver — the tools glyph from MessageBubble. */
export function ToolsIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
    </svg>
  );
}

export type ModelCapabilityKind = 'reasoning' | 'vision' | 'tools';

const LABELS: Record<ModelCapabilityKind, string> = {
  reasoning: 'Reasoning',
  vision: 'Vision',
  tools: 'Tools',
};

/**
 * A 16×16 capability chip. `img` role plus an accessible label, because the
 * purple/green/blue fill is decoration — it is not the capability's name.
 */
export function ModelCapabilityBadge({ kind }: { kind: ModelCapabilityKind }) {
  const label = LABELS[kind];
  return (
    <span className={`model-cap-badge cap-${kind}`} role="img" aria-label={label} title={label}>
      {kind === 'reasoning' ? <ReasoningIcon /> : kind === 'vision' ? <VisionIcon /> : <ToolsIcon />}
    </span>
  );
}
