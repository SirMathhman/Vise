/** One tab of the workspace: a file, a URL iframe, or a live integrated-browser tab. */
export interface OpenFile {
  path: string;
  text: string;
  /** Markdown files can show rendered or as raw text; svg files render as an image. */
  mode: "text" | "markdown" | "svg" | "url" | "browser";
  /** Browser tabs: the page title (`text` holds the current URL). */
  title?: string;
}

/** How a file is viewed, decided from its name (the `mode` of a non-URL tab). */
export type FileMode = "text" | "markdown" | "svg";

/** True when the name ends in a markdown extension. */
export const isMarkdown = (path: string): boolean =>
  /\.(md|markdown)$/i.test(path);

/** True when the name ends in an svg extension. */
export const isSvg = (path: string): boolean => /\.svg$/i.test(path);

/** The viewer mode for a file name: markdown, svg, or plain text. */
export function viewerMode(path: string): FileMode {
  return isMarkdown(path) ? "markdown" : isSvg(path) ? "svg" : "text";
}

/** A tab of the integrated browser, as the server reports it. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
}

/** The workspace's open tabs and which one has focus. */
export class OpenTabs {
  readonly files: OpenFile[] = [];
  active = -1;

  get current(): OpenFile | undefined {
    return this.files[this.active];
  }

  has(path: string): boolean {
    return this.files.some((f) => f.path === path);
  }

  indexOf(path: string): number {
    return this.files.findIndex((f) => f.path === path);
  }

  /** Append a tab; returns its index. */
  add(file: OpenFile): number {
    return this.files.push(file) - 1;
  }

  /** Index of the tab showing `url`, adding one when none exists. */
  urlIndex(url: string): number {
    const index = this.indexOf(url);
    return index >= 0 ? index : this.add({ path: url, text: "", mode: "url" });
  }

  /**
   * Keep only tabs where `keep(i)` holds and return the removed ones. Focus
   * stays on its tab if it survives, else moves to the nearest survivor.
   */
  retain(keep: (i: number) => boolean): OpenFile[] {
    const focused = this.current;
    const kept = this.files.filter((_, i) => keep(i));
    const removed = this.files.filter((f) => !kept.includes(f));
    const old = this.active;
    this.files.splice(0, this.files.length, ...kept);
    this.active =
      focused && kept.includes(focused)
        ? kept.indexOf(focused)
        : Math.min(old, kept.length - 1);
    return removed;
  }

  /**
   * Bring the `browser:<id>` tabs in line with the browser's real tabs: drop
   * ones that vanished, refresh title/URL of the rest, append (and focus) new
   * ones. Returns true when a tab was appended.
   */
  sync(tabs: BrowserTab[]): boolean {
    const focused = this.current;
    const live = new Map(tabs.map((tab) => [`browser:${tab.id}`, tab]));
    const gone = this.files.filter(
      (f) => f.mode === "browser" && !live.has(f.path),
    );
    this.retain((i) => !gone.includes(this.files[i] as OpenFile));
    let added = false;
    for (const [path, tab] of live) {
      const existing = this.files.find((f) => f.path === path);
      if (existing) {
        existing.text = tab.url;
        existing.title = tab.title;
      } else {
        this.add({ path, text: tab.url, title: tab.title, mode: "browser" });
        added = true;
      }
    }
    if (added) this.active = this.files.length - 1;
    else if (focused && this.files.includes(focused)) {
      this.active = this.files.indexOf(focused);
    }
    return added;
  }
}
