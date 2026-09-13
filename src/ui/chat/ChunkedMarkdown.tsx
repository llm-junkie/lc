/**
 * ChunkedMarkdown — renders large markdown text in stable chunks.
 *
 * During streaming, the text is append-only.  We split it at natural
 * boundaries (paragraph breaks, tool-call breaks, atomic blocks like
 * code fences / tables / math).  Each chunk is independently
 * memoized via React.memo so that only the last (growing) chunk is
 * re-parsed through the full remark + rehype pipeline — earlier
 * chunks stay frozen.
 *
 * All chunks share a single outer `.md` wrapper so CSS spacing is
 * identical to the pre-chunked single-<Markdown> rendering.
 *
 * Used by:
 *   - ReasoningBody (preview overlay → reasoning tab)
 *   - MessageBubble  (chat bubble content)
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  updateReasoningChunkState,
  type ReasoningChunkState,
} from '../../utils/reasoningChunks.ts';
import { selectLiveMarkdownChunkWindow } from '../../utils/reasoningPreview.ts';
import {
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_COMPONENTS,
  escapeNonMathDollars,
} from '../../utils/markdown.tsx';

// ── Internal memoized single-chunk renderer ───────────────────────

/**
 * Error boundary isolating a single chunk's markdown render. If ReactMarkdown
 * or any remark/rehype plugin throws on pathological input (e.g. rehype-raw /
 * parse5 on malformed HTML), only this chunk degrades to its raw text instead
 * of propagating to the app-level ErrorBoundary and taking down the whole UI.
 */
class MarkdownChunkBoundary extends React.Component<
  { text: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { text: string }) {
    // Give a changed chunk a fresh chance to render — a transient parse hiccup
    // while streaming should not permanently degrade a still-growing chunk.
    if (prev.text !== this.props.text && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <pre className="md-error-fallback">{this.props.text}</pre>;
    }
    return (
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {escapeNonMathDollars(this.props.text)}
      </ReactMarkdown>
    );
  }
}

const MarkdownChunk = React.memo(function MarkdownChunk({
  text,
}: {
  text: string;
}) {
  return <MarkdownChunkBoundary text={text} />;
});

// ── Public component ──────────────────────────────────────────────

interface Props {
  text: string;
  /** Enables append-aware chunk reuse for a growing stream. */
  streaming?: boolean;
  /** Applies the bounded production live-window policy for this surface. */
  liveSurface?: 'reasoning' | 'response';
  /** Stable absolute index for the first chunk in a progressive suffix. */
  chunkKeyOffset?: number;
}

export function ChunkedMarkdown({
  text,
  streaming = false,
  liveSurface,
  chunkKeyOffset,
}: Props) {
  const [renderState, setRenderState] = useState<{
    text: string;
    streaming: boolean;
    chunks: ReasoningChunkState;
  }>(() => ({
    text,
    streaming,
    chunks: updateReasoningChunkState(
      text,
      undefined,
      streaming && liveSurface ? LIVE_MARKDOWN_RESCAN_LIMIT_CHARS : undefined,
    ),
  }));

  let nextState = renderState;
  if (renderState.text !== text || renderState.streaming !== streaming) {
    nextState = {
      text,
      streaming,
      chunks: updateReasoningChunkState(
        text,
        streaming && renderState.streaming ? renderState.chunks : undefined,
        streaming && liveSurface ? LIVE_MARKDOWN_RESCAN_LIMIT_CHARS : undefined,
      ),
    };
    // React immediately retries this component before committing children.
    // Keeping the previous input in state is the supported render-time state
    // adjustment pattern and avoids mutating refs during concurrent rendering.
    setRenderState(nextState);
  }
  const chunks = nextState.chunks.chunks;
  const liveWindow = streaming && liveSurface
    ? selectLiveMarkdownChunkWindow(chunks)
    : undefined;
  const renderedChunks = liveWindow?.chunks ?? chunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    mode: 'markdown' as const,
    text: chunk,
  }));
  const hasPlainTail = liveWindow?.chunks.some((chunk) => chunk.mode === 'plain-tail') ?? false;
  const hasOmittedText = Boolean(
    liveWindow
    && (
      liveWindow.omittedEarlierChunks > 0
      || liveWindow.omittedGrowingTailChars > 0
      || nextState.chunks.omittedLiveChars > 0
    ),
  );

  const markdown = (
    <div className="md">
      {renderedChunks.map((chunk) => {
        const key = chunkKeyOffset === undefined
          ? chunk.chunkIndex
          : chunkKeyOffset + chunk.chunkIndex;
        const content = chunk.mode === 'plain-tail' ? (
          <pre
            className={liveSurface === 'reasoning'
              ? 'reasoning-live-plain'
              : 'streaming-markdown-plain'}
          >
            {chunk.text}
          </pre>
        ) : (
          <MarkdownChunk text={chunk.text} />
        );
        return chunkKeyOffset === undefined ? (
          <React.Fragment key={key}>{content}</React.Fragment>
        ) : (
          <div
            key={key}
            className="reasoning-markdown-chunk"
            data-reasoning-chunk-index={key}
          >
            {content}
          </div>
        );
      })}
    </div>
  );

  if (!liveSurface || (!hasPlainTail && !hasOmittedText)) {
    return markdown;
  }

  const noun = liveSurface === 'reasoning' ? 'reasoning' : 'response';
  const notice = hasPlainTail
    ? `The growing ${noun} keeps settled Markdown, but its oversized current block is plain text. Copy remains complete.`
    : `The live ${noun} shows a bounded Markdown window. Earlier text returns after completion and remains available to Copy.`;

  return (
    <div className={liveSurface === 'reasoning'
      ? 'reasoning-live-window'
      : 'streaming-markdown-window'}
    >
      <div
        className={liveSurface === 'reasoning'
          ? 'reasoning-live-notice'
          : 'streaming-markdown-notice'}
        role="status"
      >
        {notice}
      </div>
      {markdown}
    </div>
  );
}
