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
    // Move the existing tab to the requested location and bring it forward.
    programmaticNav.add(target.id);
    await chrome.tabs.update(target.id, { url, active: true });
    if (typeof target.windowId === "number") {
      await chrome.windows.update(target.windowId, { focused: true });
    }
  } catch (e) {
    // Existing tab vanished mid-flight — fall back to keeping the new one.
    programmaticNav.delete(target.id);
    closing.delete(tabId);
    return;
  }

  // Safety net: clear the self-nav guard even if no further event arrives.
  setTimeout(() => programmaticNav.delete(target.id), 5000);

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // Tab already gone; nothing to do.
  } finally {
    closing.delete(tabId);
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
