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
    // ask Figma's own SPA router to navigate to the linked location — exactly
    // like clicking a comment/share link from inside the file. Our pushState
    // will fire onUpdated for this tab, so guard against re-entry.
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

// Navigate an already-loaded Figma tab to a new location without a full page
// reload, by driving Figma's client-side router through the History API.
// Figma re-reads the page/node from the URL on `popstate` (the same path used
// by the browser back/forward buttons), so a pushState + popstate reproduces
// an in-app jump. Falls back to a normal navigation if injection isn't allowed
// (e.g. the tab is still on a non-app page).
async function navigateInPlace(tabId, url) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [url],
      func: (href) => {
        try {
          const next = new URL(href);
          const cur = new URL(location.href);
          // Same file, same spot already — nothing to do.
          if (cur.pathname === next.pathname && cur.search === next.search) {
            return;
          }
          const path = next.pathname + next.search + next.hash;
          history.pushState({}, "", path);
          window.dispatchEvent(
            new PopStateEvent("popstate", { state: history.state })
          );
        } catch (e) {
          // As a last resort, navigate normally (will reload).
          location.href = href;
        }
      }
    });
  } catch (e) {
    // Scripting was rejected (tab discarded, not yet a figma app page, …).
    // Fall back to a normal navigation so the link still lands somewhere.
    await chrome.tabs.update(tabId, { url });
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
