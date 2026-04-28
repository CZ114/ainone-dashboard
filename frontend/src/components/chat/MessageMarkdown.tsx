// Markdown renderer for chat message bodies.
//
// Replaces the old `<pre>` plaintext fallback so Claude's responses
// (which are heavily markdown-formatted: headings, code fences, lists,
// tables, **bold**, links) actually look like the structured documents
// they are. User messages also pass through here — they rarely have
// formatting, but if a user pastes code or quotes a fence we want it
// rendered correctly.
//
// Why react-markdown + remark-gfm specifically:
//   - react-markdown is the de-facto standard, well-maintained,
//     explicitly designed to be safe against XSS (no innerHTML, no
//     raw HTML pass-through unless you opt in).
//   - remark-gfm adds GitHub-Flavored extensions (tables, task lists,
//     strikethrough, autolinks) that Claude uses constantly.
//
// We deliberately don't pull in syntax highlighting (e.g.
// react-syntax-highlighter) — it adds 200KB+ and the readability win
// from monospace + background alone covers ~90% of the value. Easy
// to add later if a grammar is genuinely needed.
//
// Styling is bespoke (not @tailwindcss/typography) because the host
// app already has a dark-theme palette (text-text-primary etc) that
// the prose plugin doesn't know about; matching colours via the
// plugin would mean either ejecting its config or fighting the
// !important defaults.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MessageMarkdownProps {
  content: string;
  // Theme variant — user bubbles are blue with white text, so links /
  // code / tables need different colours than on assistant bubbles.
  // Defaults to 'assistant' since most messages are Claude's.
  variant?: 'user' | 'assistant';
}

// react-markdown component overrides. We provide custom renderers for
// elements that need theme-aware styling; everything else falls back
// to plain HTML which CSS selectors can target if needed.
//
// Note on `<code>`: react-markdown renders BOTH inline `code` and
// fenced ```code``` blocks through the same `code` component. The
// distinguisher is whether the parent is `<pre>`. We split the two
// cases by detecting newlines in `children` plus the absence of an
// `inline` flag (the API stopped passing `inline` in v9; we use a
// content heuristic instead).
function buildComponents(variant: 'user' | 'assistant'): Components {
  const isUserVariant = variant === 'user';

  return {
    // Headings — descending size with subtle weight changes.
    h1: ({ children }) => (
      <h1 className="text-base font-bold mt-3 mb-2 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-sm font-bold mt-3 mb-2 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-sm font-semibold mt-2 mb-1.5 first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h4>
    ),
    // Paragraph — tight vertical rhythm so short messages don't sprawl.
    p: ({ children }) => (
      <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
    ),
    // Inline emphasis. <strong> and <em> can be left as defaults; we
    // only override to ensure they render on user-blue background.
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    // Lists — markdown's tight vs loose distinction is honored by
    // remark; we just style spacing.
    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    // Blockquote — left bar to visually nest.
    blockquote: ({ children }) => (
      <blockquote
        className={`border-l-2 pl-3 my-2 italic ${
          isUserVariant
            ? 'border-accent-soft/40 text-white/90'
            : 'border-card-border text-text-secondary'
        }`}
      >
        {children}
      </blockquote>
    ),
    // Links — open in new tab; rel=noopener so target=_blank is safe.
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`underline ${
          isUserVariant
            ? 'text-white hover:text-white'
            : 'text-accent-soft hover:text-accent-soft'
        }`}
      >
        {children}
      </a>
    ),
    // Code — both inline `x` and block ```x```. We distinguish by
    // looking at the parent context via a simple content check:
    // multi-line content is treated as a block, single-line as inline.
    // (react-markdown v9+ removed the `inline` prop, hence this
    // heuristic.)
    code: ({ className, children, ...props }) => {
      const text = String(children ?? '');
      const isBlock = /\n/.test(text) || /^language-/.test(className ?? '');
      if (isBlock) {
        // Fenced code block — wrapped <pre> is provided by the `pre`
        // override below; here we just style the inner <code>.
        return (
          <code
            className={`block font-mono text-[12px] leading-snug ${className ?? ''}`}
            {...props}
          >
            {children}
          </code>
        );
      }
      // Inline code — pill-shaped, contrasting background.
      return (
        <code
          className={`px-1 py-0.5 rounded font-mono text-[0.85em] ${
            isUserVariant
              ? 'bg-accent-hover/60 text-white'
              : 'bg-window-bg border border-card-border/60 text-text-primary'
          }`}
          {...props}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      // The <pre> wrap for fenced code — separate background, scrolls
      // horizontally on long lines instead of breaking the bubble layout.
      <pre
        className={`my-2 p-2.5 rounded-md overflow-x-auto ${
          isUserVariant
            ? 'bg-accent-hover/40 border border-accent-soft/30'
            : 'bg-window-bg border border-card-border'
        }`}
      >
        {children}
      </pre>
    ),
    // Horizontal rule — subtle.
    hr: () => (
      <hr
        className={`my-3 border-0 border-t ${
          isUserVariant ? 'border-accent-soft/30' : 'border-card-border'
        }`}
      />
    ),
    // Tables (from remark-gfm). Compact, scrollable on overflow.
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th
        className={`px-2 py-1 border text-left font-semibold ${
          isUserVariant
            ? 'border-accent-soft/30 bg-accent-hover/30'
            : 'border-card-border bg-card-bg'
        }`}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className={`px-2 py-1 border ${
          isUserVariant
            ? 'border-accent-soft/30'
            : 'border-card-border'
        }`}
      >
        {children}
      </td>
    ),
  };
}

export function MessageMarkdown({
  content,
  variant = 'assistant',
}: MessageMarkdownProps) {
  return (
    <div
      // Outer text container handles wrapping; markdown elements
      // themselves use blocks/inline as appropriate. break-words is
      // critical for very long URLs / code identifiers that would
      // otherwise overflow the chat bubble.
      className="text-sm break-words"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={buildComponents(variant)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
