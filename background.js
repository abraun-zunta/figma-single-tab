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
  enabled: true
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

  const { enabled } = await getSettings();
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

  // Mark the duplicate as closing up front so repeated events are ignored.
  closing.add(tabId);

  try {
    // Bring the existing tab and its window forward. This does NOT reload it.
    await chrome.tabs.update(target.id, { active: true });
    if (typeof target.windowId === "number") {
      await chrome.windows.update(target.windowId, { focused: true });
    }

    // The existing tab already has this file loaded. Instead of reloading it,
    // drive Figma's in-page Plugin API to jump to the linked node — exactly
    // like the desktop app moving its viewport. navigateInPlace may pushState,
    // which fires onUpdated for this tab, so guard against re-entry.
    programmaticNav.add(target.id);
    await navigateInPlace(target.id, url);
    setTimeout(() => programmaticNav.delete(target.id), 5000);
  } catch (e) {
    // Existing tab vanished mid-flight — keep the freshly opened tab instead.
    programmaticNav.delete(target.id);
    closing.delete(tabId);
    return;
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
// (and tools like figma-mcp-browser) use. This is what lets us match the
// desktop app: move the viewport instead of re-loading the document.
//
// What makes this work:
//   - world: "MAIN" — `window.figma` lives in the page's own JS context, not
//     the extension's isolated world, so the snippet must run in MAIN.
//   - It initialises asynchronously after the editor boots, and may live on
//     the top window, on a manually-registered instance, or inside the
//     same-origin editor iframe — so we poll and scan frames for it.
//   - node-id in the URL is hyphenated (1-23); the Plugin API wants colons
//     (1:23).
//
// Returns/handles a {moved} result; if the API isn't reachable (view-only
// file, editor not ready, etc.) we fall back to a normal navigation so the
// link still lands at the right place.
async function navigateInPlace(tabId, url) {
  let moved = false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url],
      func: async (href) => {
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
        const waitForFigma = (timeoutMs) =>
          new Promise((resolve) => {
            const found = findFigma();
            if (found) return resolve(found);
            let elapsed = 0;
            const timer = setInterval(() => {
              const f = findFigma();
              if (f || (elapsed += 100) >= timeoutMs) {
                clearInterval(timer);
                resolve(f || null);
              }
            }, 100);
          });

        try {
          const next = new URL(href);
          const nodeParam = next.searchParams.get("node-id");
          const figma = await waitForFigma(8000);
          if (!figma) return { moved: false, reason: "no-figma-api" };

          // Link has no specific node: the file is already loaded; just keep
          // the focused tab as-is (no reload needed).
          if (!nodeParam) return { moved: true, reason: "no-node" };

          const id = nodeParam.replace(/-/g, ":");
          let node = null;
          try {
            node = figma.getNodeByIdAsync
              ? await figma.getNodeByIdAsync(id)
              : figma.getNodeById(id);
          } catch (_) {}
          // In dynamic-page documents nodes on other pages aren't loaded yet.
          if (!node && figma.loadAllPagesAsync) {
            try {
              await figma.loadAllPagesAsync();
              node = await figma.getNodeByIdAsync(id);
            } catch (_) {}
          }
          if (!node) return { moved: false, reason: "node-not-found" };

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
          return { moved: false, reason: "error" };
        }
      }
    });
    const r = results && results[0] && results[0].result;
    moved = !!(r && r.moved);
  } catch (e) {
    moved = false;
  }

  if (!moved) {
    // Plugin API not reachable (view-only file, editor still booting, …).
    // Fall back to a normal navigation so the link still lands somewhere.
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      /* tab gone */
    }
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
