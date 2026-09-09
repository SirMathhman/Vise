# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

A minimal **Vite** project using **vanilla JavaScript** (no framework). It renders a single-page UI by building an HTML template string in `src/render.js` and injecting it into `#app`.

## Commands

| Task             | Command           |
| ---------------- | ----------------- |
| Dev server (HMR) | `npm run dev`     |
| Production build | `npm run build`   |
| Preview build    | `npm run preview` |
| Lint (CPD)       | `npm run lint:all`|

There is **no test runner or formatter** configured. `npm run lint:all` runs **PMD CPD** (copy-paste detection) over `src/` and `index.html` — keep code DRY so it stays clean. Verify UI changes by running the dev server and checking the browser.

## Architecture & Conventions

- **ES modules** throughout (`"type": "module"` in `package.json`). Use `import`/`export`, not CommonJS.
- **Entry point:** `index.html` loads `/src/main.js` as a module.
- **Composition root:** `src/main.js` is a thin wiring module — it imports the render layer and behavior modules, then calls them. Keep it small; do not add rendering or feature logic here.
- **Rendering:** `src/render.js` exports `renderApp(appEl)`, which builds the DOM via a template literal assigned to `innerHTML`. Add new markup here, not in `main.js`.
- **Modular logic:** Extract reusable behavior into small leaf modules and import them into `main.js`.
- **Dependency direction:** one-way only — `main.js → render.js` (and any other leaf modules). Leaf modules must not import each other or `main.js`.
- **Styling:** `src/style.css` uses **native CSS nesting**, CSS custom properties (design tokens in `:root`), and `prefers-color-scheme` for dark mode. Follow the existing token-based approach (`var(--accent)`, etc.) rather than hardcoding colors.
- **Static assets:**
  - `public/` — served as-is at the site root (e.g. `/favicon.svg`, `/icons.svg`). Reference with an absolute `/` path.
  - `src/assets/` — imported in JS so Vite processes/hashes them (e.g. `import heroImg from './assets/hero.png'`).

## Pitfalls

- Do not add a framework or build tool without explicit request — this is intentionally a plain Vite + vanilla JS setup.
- `public/` assets are not processed by Vite; use `src/assets/` imports when you need bundling/hashing.
- CSS uses native nesting — keep it consistent; do not introduce a CSS preprocessor.
