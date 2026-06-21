/*
 * Figma Single Tab — background service worker (Manifest V3)
 *
 * Goal: make the browser behave like the Figma desktop app, where every file
 * lives in exactly one window. When you open a Figma link and that file is
 * already open in another tab, we reuse the existing tab: we point it at the
 * new location (so it jumps to the right page/node), focus it, and close the
 * freshly opened duplicate tab.
 */

// Editor surfaces that share Figma's "file key" identity model. Two URLs point
// at the same document when these keys match — regardless of node-id, page,
// branch view, or the human-readable slug in the path.
const FILE_PATH_PATTERN =
  /\/(file|design|board|proto|slides|deck|whiteboard)\/([A-Za-z0-9]+)/;

const DEFAULT_SETTINGS = {
  enabled: true,
  // When the in-place (no-reload) jump isn't possible — Figma only exposes
  // window.figma after a plugin has run once in that tab — should we reload the
  // existing tab to reach the node? Off by default: never reload; just let the
  // new tab open normally.
  reloadWhenUnarmed: false
};

// Tab ids we are navigating ourselves. Our own tabs.update() triggers an
// onUpdated event; we must ignore it so we don't loop.
const programmaticNav = new Set();

// Duplicate tabs we have already decided to close. Guards against the burst of
// onUpdated events Figma's SPA fires before the tab is actually removed.
const closing = new Set();

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

// Returns the Figma file key for a URL, or null if it isn't a Figma file URL.
function getFileKey(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(FILE_PATH_PATTERN);
  return match ? match[2] : null;
}

async function consolidate(tabId, url) {
  if (closing.has(tabId)) return;

  // This update was caused by us moving an existing tab — let it settle.
  if (programmaticNav.has(tabId)) {
    programmaticNav.delete(tabId);
    return;
  }

  const fileKey = getFileKey(url);
  if (!fileKey) return;

  const { enabled, reloadWhenUnarmed } = await getSettings();
  if (!enabled) return;

  const figmaTabs = await chrome.tabs.query({ url: "*://*.figma.com/*" });

  // Other tabs already showing the same file. Pick the oldest (smallest id)
  // as the canonical home for this file.
  const candidates = figmaTabs
    .filter(
      (t) =>
        t.id !== tabId &&
        !closing.has(t.id) &&
        getFileKey(t.url) === fileKey
    )
    .sort((a, b) => a.id - b.id);

  if (candidates.length === 0) return; // This tab is the canonical one.

  const target = candidates[0];

  // Try to jump the existing tab to the linked node in place (no reload).
  // We do this BEFORE touching anything else and only commit to reusing the
  // tab if it actually worked. Guard against the pushState re-entering here.
  programmaticNav.add(target.id);
  let jumped = false;
  try {
    jumped = await navigateInPlace(target.id, url);
  } catch (e) {
    jumped = false;
  }
  setTimeout(() => programmaticNav.delete(target.id), 3000);

  if (!jumped) {
    // Figma's in-page API wasn't reachable (view-only file, or window.figma not
    // yet armed — Figma only exposes it after a plugin runs once in the tab).
    if (!reloadWhenUnarmed) {
      // Default: don't reload anything. Leave the freshly opened tab to load
      // normally, exactly as it would without the extension.
      console.warn(
        "[Figma Single Tab] In-place jump unavailable; leaving the new tab open."
      );
      return;
    }
    // Opt-in: reload the existing tab to the node so the link still lands in a
    // single tab (at the cost of a reload). Reuse the existing-tab path below.
    programmaticNav.add(target.id);
    setTimeout(() => programmaticNav.delete(target.id), 3000);
    try {
      await chrome.tabs.update(target.id, { url });
    } catch (e) {
      console.warn("[Figma Single Tab] reload fallback failed:", e && e.message);
      return;
    }
  }

  // Jump (or reload fallback) succeeded: bring the existing tab forward and
  // close the duplicate.
  closing.add(tabId);
  try {
    await chrome.tabs.update(target.id, { active: true });
    if (typeof target.windowId === "number") {
      await chrome.windows.update(target.windowId, { focused: true });
    }
  } catch (e) {
    /* existing tab vanished — still try to close the duplicate below */
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // Tab already gone; nothing to do.
  } finally {
    closing.delete(tabId);
  }
}

// Jump an already-loaded Figma tab to the linked node WITHOUT a full reload by
// driving Figma's in-page Plugin API — the same `window.figma` that plugins
// (and tools like figma-mcp-browser) use. Returns true if the jump happened,
// false otherwise. It NEVER reloads anything: if `window.figma` isn't there
// (view-only file, editor not ready) it just logs and returns false, and the
// caller leaves the new tab alone.
//
// What makes this work:
//   - world: "MAIN" — `window.figma` lives in the page's own JS context, not
//     the extension's isolated world, so the snippet must run in MAIN.
//   - It may live on the top window, on a manually-registered instance, or
//     inside the same-origin editor iframe — so we check all three. We grab it
//     immediately (with only a couple of instant retries — never a long wait).
//   - node-id in the URL is hyphenated (1-23); the Plugin API wants colons
//     (1:23).
async function navigateInPlace(tabId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      // Inject into every frame: Figma's editor sometimes runs inside an
      // iframe (occasionally cross-origin), so window.figma may only exist
      // there, not in the top frame. Each frame self-checks; the one that has
      // the API does the jump, the rest no-op.
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [url],
      func: async (href) => {
        const TAG = "[Figma Single Tab]";
        const findFigma = () => {
          if (window.figma) return window.figma;
          if (window.__figmaMCPInstance) return window.__figmaMCPInstance;
          for (const frame of document.querySelectorAll("iframe")) {
            try {
              if (frame.contentWindow && frame.contentWindow.figma) {
                return frame.contentWindow.figma;
              }
            } catch (_) {
              /* cross-origin frame — skip */
            }
          }
          return null;
        };

        try {
          const next = new URL(href);
          const nodeParam = next.searchParams.get("node-id");

          // Grab the API right away. A couple of micro-retries cover the case
          // where it's a tick behind, but we never block for seconds.
          let figma = findFigma();
          for (let i = 0; i < 3 && !figma; i++) {
            await new Promise((r) => setTimeout(r, 50));
            figma = findFigma();
          }
          if (!figma) {
            console.warn(TAG, "window.figma not available — skipping jump.");
            return { moved: false, reason: "no-figma-api" };
          }

          // Link with no specific node: file is already loaded, nothing to move.
          if (!nodeParam) return { moved: true, reason: "no-node" };

          const id = nodeParam.replace(/-/g, ":");
          let node = null;
          try {
            node = figma.getNodeByIdAsync
              ? await figma.getNodeByIdAsync(id)
              : figma.getNodeById(id);
          } catch (_) {}
          if (!node) {
            console.warn(TAG, "node not found:", id);
            return { moved: false, reason: "node-not-found" };
          }

          // Switch to the node's page if it lives on a different one.
          let page = node;
          while (page && page.type !== "PAGE") page = page.parent;
          if (page && figma.currentPage !== page) {
            if (figma.setCurrentPageAsync) await figma.setCurrentPageAsync(page);
            else figma.currentPage = page;
          }

          // Select and zoom to the node, like the desktop app does.
          if (node.type !== "PAGE") {
            try {
              figma.currentPage.selection = [node];
            } catch (_) {}
            figma.viewport.scrollAndZoomIntoView([node]);
          }

          // Reflect the new location in the address bar (pushState ≠ reload).
          try {
            history.pushState(history.state, "", next.pathname + next.search);
          } catch (_) {}
          return { moved: true, reason: "jumped" };
        } catch (e) {
          console.warn(TAG, "in-place jump failed:", e && e.message);
          return { moved: false, reason: "error" };
        }
      }
    });
    // Any frame that reports a successful jump counts as success.
    return (
      Array.isArray(results) &&
      results.some((r) => r && r.result && r.result.moved)
    );
  } catch (e) {
    // Injection itself was rejected (discarded tab, etc.). Don't reload.
    console.warn("[Figma Single Tab] could not inject jump script:", e && e.message);
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only react when the URL actually changes (covers new tabs and in-page
  // SPA navigations alike). Status-only events carry no url and are skipped.
  if (changeInfo.url) {
    consolidate(tabId, changeInfo.url);
  }
});

// Clean up book-keeping if a tracked tab closes on its own.
chrome.tabs.onRemoved.addListener((tabId) => {
  programmaticNav.delete(tabId);
  closing.delete(tabId);
});
