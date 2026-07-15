import sanitizeHtml from "sanitize-html";

// Blog bodies are TipTap-generated HTML. When that HTML comes from a trusted,
// signed-in creator in the editor we store it as-is. When it arrives through an
// INBOUND integration channel (an external bot/script using an API key), we must
// not trust it: a leaked key must never be able to smuggle stored XSS into the
// creator's review queue (and thus into a published post if they hit publish).
//
// This allowlist is the exact set of nodes/marks the RichEditor can produce
// (StarterKit + Image + Youtube + TextAlign + Color/Highlight + TaskList +
// Table + LinkPreview), so a sanitized draft round-trips through the editor and
// renders identically — including image + YouTube embeds — with nothing new to
// build on the editor side.
const YT_HOSTS = [
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "www.youtube.com",
  "youtube.com",
];

export function sanitizeBlogHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [
      "p", "br", "hr", "blockquote", "pre", "code",
      "h1", "h2", "h3", "h4",
      "strong", "b", "em", "i", "u", "s", "strike", "del", "mark", "sub", "sup",
      "ul", "ol", "li",
      "a", "img",
      "div", "span",
      "iframe",
      "table", "thead", "tbody", "tr", "th", "td",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel", "class"],
      img: ["src", "alt", "title", "width", "height", "class"],
      // TipTap Youtube renders <div data-youtube-video><iframe .../></div>.
      div: ["data-youtube-video", "class"],
      iframe: [
        "src", "width", "height", "allow", "allowfullscreen",
        "frameborder", "class", "start",
      ],
      // TaskList/TaskItem carry data-type / data-checked; keep them so checkboxes
      // and ordered/bullet variants survive the round-trip.
      ul: ["data-type", "class"],
      ol: ["data-type", "class", "start"],
      li: ["data-type", "data-checked", "class"],
      p: ["class", "style"],
      h1: ["class", "style"], h2: ["class", "style"], h3: ["class", "style"], h4: ["class", "style"],
      span: ["class", "style", "data-type"],
      mark: ["data-color", "style"],
      th: ["colspan", "rowspan", "colwidth", "class", "style"],
      td: ["colspan", "rowspan", "colwidth", "class", "style"],
      table: ["class", "style"],
    },
    // Only text-align + color/background — the two style props the editor emits.
    allowedStyles: {
      "*": {
        "text-align": [/^(left|right|center|justify)$/],
        color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^rgba\(/, /^hsl\(/],
        "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^rgba\(/, /^hsl\(/],
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    // Images may point at http(s) hosts (we re-host to R2 anyway) — no data: URIs.
    allowedSchemesByTag: { img: ["http", "https"] },
    // iframes are only allowed to embed YouTube (matches the editor's Youtube node).
    allowedIframeHostnames: YT_HOSTS,
    allowIframeRelativeUrls: false,
    // Harden anchors: force noopener + open in a new tab, drop javascript: etc.
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
    disallowedTagsMode: "discard",
  });
}
