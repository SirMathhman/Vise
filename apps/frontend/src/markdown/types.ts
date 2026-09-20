/** The Markdown tree: what the DOM-free parser produces and the renderer consumes. */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "em"; c: Inline[] }
  | { t: "strong"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" };
