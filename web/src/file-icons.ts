/**
 * A single file icon for each file row in the file tree. The server sends only
 * the filename, so the icon is derived here from the extension: a short map
 * from extension to one emoji, grouped by category rather than per language.
 * Every file gets an icon; an unknown (or missing) extension falls back to 📄.
 */

const ICONS: Record<string, string> = {
  // Code
  ts: "💻",
  mjs: "💻",
  cjs: "💻",
  py: "💻",
  rs: "💻",
  go: "💻",
  java: "💻",
  c: "💻",
  cpp: "💻",
  cc: "💻",
  h: "💻",
  cs: "💻",
  rb: "💻",
  php: "💻",
  sh: "💻",
  sql: "💻",
  toml: "💻",
  ini: "💻",
  // Markup / docs
  md: "📝",
  mdx: "📝",
  txt: "📝",
  rst: "📝",
  html: "📝",
  htm: "📝",
  // Config
  json: "⚙️",
  yml: "⚙️",
  yaml: "⚙️",
  env: "⚙️",
  xml: "⚙️",
  config: "⚙️",
  // Images
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  svg: "🖼️",
  bmp: "🖼️",
  ico: "🖼️",
  // Media
  mp3: "🎬",
  wav: "🎬",
  mp4: "🎬",
  webm: "🎬",
  mov: "🎬",
  // Archives
  zip: "📦",
  tar: "📦",
  gz: "📦",
  "7z": "📦",
  rar: "📦",
  // Fonts
  woff: "🔤",
  woff2: "🔤",
  ttf: "🔤",
  otf: "🔤",
  eot: "🔤",
};

const FALLBACK_ICON = "📄";

/** One emoji for a file, derived from the extension in a name like "app.ts". */
export function emojiFor(name: string): string {
  const dot = name.lastIndexOf(".");
  // No dot, or a leading dot (a hidden file like ".envrc") means no extension.
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return ICONS[ext] ?? FALLBACK_ICON;
}
