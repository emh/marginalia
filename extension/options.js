const DEFAULT_APP_URL = "https://emh.io/marginalia/";

const form = document.getElementById("options-form");
const input = document.getElementById("app-url");
const status = document.getElementById("status");

chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL }).then(settings => {
  input.value = settings.appUrl || DEFAULT_APP_URL;
});

form.addEventListener("submit", event => {
  event.preventDefault();
  const appUrl = normalizeAppUrl(input.value);
  chrome.storage.sync.set({ appUrl }).then(() => {
    input.value = appUrl;
    status.textContent = "Saved.";
  });
});

function normalizeAppUrl(value) {
  try {
    const url = new URL(value || DEFAULT_APP_URL);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_APP_URL;
    return url.toString();
  } catch {
    return DEFAULT_APP_URL;
  }
}
