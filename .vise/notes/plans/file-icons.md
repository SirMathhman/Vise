## Plan: File Tree Emoji Icons

Add a small emoji to each file row in the web file tree, derived client-side from the filename's extension. Directives keep the existing ▸/▾ triangles. No server or asset changes.

**Steps**

1. **Add an `emojiFor(name)` helper** in `web/src/explorer.ts` (or a small sibling module if the file is approaching the 500-line limit).
   - Pure function: `name: string → string` (a single emoji character, or `""` for no icon).
   - Extract the file extension (last dot, lowercase, no leading dot) and look up a small mapping table. Group by category, not one-per-language:
     - Code (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.cs`, `.rb`, `.php`, `.sh`, `.sql`, `.toml`, `.ini`): `💻`
     - Markup / docs (`.md`, `.mdx`, `.txt`, `.rst`, `.html`, `.htm`): `📝`
     - Config (`.json`, `.yml`, `.yaml`, `.env`, `.xml`, `.config`): `⚙️`
     - Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`): `🖼️`
     - Media (`.mp3`, `.wav`, `.mp4`, `.webm`, `.mov`): `🎬`
     - Archives (`.zip`, `.tar`, `.gz`, `.7z`, `.rar`): `📦`
     - Fonts (`.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`): `🔤`
     - Fallback (no match, or unknown extension): `📄`
   - The mapping is an object literal (extension → emoji) so adding or adjusting entries is trivial.

2. **Render the emoji in `fileRow()`** in `web/src/explorer.ts`.
   - In `fileRow`, prepend a `<span class="fs-icon">` containing the result of `emojiFor(name)` before the filename text node.
   - Leave `dirRow()` unchanged (triangles stay).

3. **Add CSS** in `web/styles.css`.
   - `.fs-icon` — inline-block, fixed width (e.g. `width: 1.4em; text-align: center;`) so filenames after the icon align in a column. Optionally slightly reduced font-size or opacity to keep it subtle.
   - No other CSS changes needed.

4. **Build and verify**.
   - `bun run web` (builds `web/dist/app.js` from `web/src/`).
   - Open the page with a folder containing varied file types; confirm each file row shows the correct emoji and names are aligned.
   - Confirm directories still show only ▸/▾ with no emoji.
   - Confirm the emoji is present on file open, in the file tree list, and does not interfere with file-click navigation.

**Relevant files**

- `web/src/explorer.ts` — `fileRow()` function (where the `<li>` and filename text are created); add `emojiFor()` here or in a new `web/src/file-icons.ts` if the file is near the line limit
- `web/styles.css` — add `.fs-icon` class

**Verification**

1. `bun run web` → open the file tree panel
2. Navigate to a directory with a mix of `.ts`, `.md`, `.json`, `.png`, `.zip`, `.mp3`, and an unknown extension → each shows the correct emoji
3. Directories show only the triangle marker, no emoji
4. File names are visually aligned (the icon column doesn't shift text left/right per row)
5. `bun run typecheck:web` passes
6. `bun run lint` passes

**Decisions**

- Client-side only: the server already sends the full filename; no `/api/fs` schema change needed.
- Emoji over SVG or letter badges: zero asset files to bundle, platform-inconsistent rendering is acceptable.
- Directories keep the existing ▸/▾ Unicode triangles; no 📁 added.
- Fallback emoji `📄` for any extension not in the mapping, so every file gets an icon.
- The mapping is intentionally a small category table (7–8 groups), not one emoji per language.
