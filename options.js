const DEFAULTS = { enabled: true, reloadWhenUnarmed: false };

const inputs = {
  enabled: document.getElementById("enabled"),
  reloadWhenUnarmed: document.getElementById("reloadWhenUnarmed")
};

chrome.storage.sync.get(DEFAULTS, (settings) => {
  inputs.enabled.checked = settings.enabled;
  inputs.reloadWhenUnarmed.checked = settings.reloadWhenUnarmed;
});

for (const [key, input] of Object.entries(inputs)) {
  input.addEventListener("change", () => {
    chrome.storage.sync.set({ [key]: input.checked });
  });
}
