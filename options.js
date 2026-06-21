const DEFAULTS = { enabled: true };
const checkbox = document.getElementById("enabled");

chrome.storage.sync.get(DEFAULTS, ({ enabled }) => {
  checkbox.checked = enabled;
});

checkbox.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: checkbox.checked });
});
