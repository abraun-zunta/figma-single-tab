# Figma Single Tab

**Make your browser open Figma links the way the Figma desktop app does — one tab per file.**

When you click a Figma link (from Slack, email, a comment, the dashboard,
anywhere) and that file is *already open* in another browser tab, Figma Single
Tab **reuses that tab** instead of piling up duplicates:

1. It detects the incoming Figma link.
2. It finds the tab where the same file is already open.
3. It brings that tab to the front and tells Figma to jump to the exact
   location in the link (the right page, frame, node, or prototype screen) —
   **without reloading the file**, exactly like clicking a comment or share
   link from inside Figma.
4. It closes the duplicate tab that just opened.

The result: no more hunting through ten near-identical "Untitled" Figma tabs.
Each file lives in exactly one tab, just like the desktop app — but in the
browser you already prefer (Chrome, Edge, Brave, Arc, or any Chromium browser).

---

## Why

The Figma desktop app keeps a single window per file. The browser doesn't —
every shared link spawns a brand-new tab, even when you already have that file
open. If you live in the browser (Linux, fast-loading Edge, or just personal
preference) you lose that tidy desktop behavior. This extension brings it back.

## Features

- ♻️ **Reuses the existing tab** for a file instead of opening a duplicate.
- 🎯 **Jumps to the linked location** — node-id, page, prototype frame, etc. are
  preserved.
- 🪟 **Focuses the right window and tab** so the file is instantly in front of you.
- 🧩 Works across **Figma design files, FigJam boards, prototypes, slides, and
  Dev Mode** links.
- 🔌 **One toggle** to turn the behavior on/off, no configuration required.
- 🔒 **Zero data collection.** It only looks at Figma tab URLs, entirely on your
  machine. No analytics, no servers, no account.

## Install

### From source (works today)

1. Download or clone this repository.
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this project's folder.
5. Done — open a Figma link and watch it land in the existing tab.

> The PNG icons are checked in. If you change `scripts/make_icons.py`, regenerate
> them with `python3 scripts/make_icons.py`.

## How it works

A small Manifest V3 service worker (`background.js`) listens for tab URL changes.
Every Figma file URL contains a stable **file key**, e.g.
`https://www.figma.com/design/`**`AbC123…`**`/My-File?node-id=…`. Two links point
at the same document when their file keys match — independent of the page,
node-id, branch view, or the slug in the path.

When a Figma link loads, the worker:

- extracts its file key,
- looks for another open tab with the same file key,
- and, if one exists, focuses that tab and jumps it to the linked node, then
  closes the duplicate.

### The no-reload jump

The interesting part is moving the existing tab to the right node *without
reloading it*. Figma's web editor reads the `node-id` only at load time, so
changing the URL would force a full reload. Instead, the extension uses Figma's
own **in-page Plugin API** — the `window.figma` object that Figma plugins use,
which is also reachable from the page's `MAIN` JavaScript world. It:

1. injects a snippet into the existing tab's `MAIN` world,
2. waits for `window.figma` to be ready (it loads asynchronously after the
   editor boots, and may live inside the editor's same-origin iframe),
3. resolves the node with `figma.getNodeByIdAsync(...)`,
4. switches to its page with `figma.setCurrentPageAsync(...)` if needed, and
5. moves the viewport with `figma.viewport.scrollAndZoomIntoView([node])` and
   selects it — exactly what the desktop app does.

No reload, no lost work — the canvas just glides to the node.

> **Note:** the Plugin API jump needs **edit access** to the file (Figma only
> exposes `window.figma` to editors). On view-only files, or if the editor
> hasn't finished booting, the extension **never reloads your open tab** — it
> simply logs a warning and lets the newly opened tab load normally, exactly as
> it would without the extension. The jump is attempted instantly (no waiting).

If no other tab has the file open, the link is left alone — it simply becomes the
canonical tab for that file. Internal navigation within a single open file is
never touched.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `tabs` | Read tab URLs to detect Figma files, switch to the existing tab, and close the duplicate. |
| `scripting` | Inject the snippet that calls Figma's in-page Plugin API (`window.figma`) to jump the existing tab to the linked node without reloading. |
| `storage` | Remember whether the feature is enabled. |
| `host_permissions: *://*.figma.com/*` | Limit all of the above strictly to Figma pages. |

The injected snippet only locates a node and moves the viewport to it. The
extension never reads or exfiltrates page contents and never touches non-Figma
tabs.

## Settings

Click the toolbar icon to open a single toggle: **Reuse existing tabs**. Turn it
off any time you actually want a link to open in a fresh tab.

## Compatibility

Any Chromium-based browser with Manifest V3 support: Chrome, Edge, Brave, Arc,
Opera, Vivaldi, and more. (Firefox is not supported yet — it uses a different
extension model.)

## Privacy

Everything runs locally in your browser. The extension inspects only the URLs of
`figma.com` tabs to decide which tab to reuse. It collects nothing, sends nothing
anywhere, and has no backend.

## Contributing

Issues and pull requests are welcome — especially additional Figma URL surfaces,
a Firefox port, and edge-case handling.

## License

[MIT](LICENSE)
