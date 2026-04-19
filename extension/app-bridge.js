const params = new URLSearchParams(globalThis.location.search);
const captureId = params.get("capture");

announceInstalled();

if (captureId) {
  bridgeCapture(captureId).catch(error => {
    console.error("Marginalia capture bridge failed", error);
  });
}

function announceInstalled() {
  let attempts = 0;
  const version = chrome.runtime.getManifest().version;
  const post = () => {
    globalThis.postMessage({
      type: "marginalia:extension-installed",
      version
    }, globalThis.location.origin);
  };

  post();
  const timer = setInterval(() => {
    attempts += 1;
    post();
    if (attempts >= 10) clearInterval(timer);
  }, 300);
}

async function bridgeCapture(id) {
  const response = await chrome.runtime.sendMessage({ type: "marginalia:get-capture", id });
  if (!response?.ok || !response.payload) {
    console.warn(response?.error || "Marginalia capture was not found.");
    return;
  }

  let attempts = 0;
  let done = false;
  const payload = response.payload;

  globalThis.addEventListener("message", event => {
    if (event.source !== globalThis || event.origin !== globalThis.location.origin) return;
    if (event.data?.id !== id) return;

    if (event.data.type === "marginalia:capture:ack") {
      done = true;
      chrome.runtime.sendMessage({ type: "marginalia:clear-capture", id });
    }

    if (event.data.type === "marginalia:capture:error") {
      done = true;
      console.warn(event.data.error || "Marginalia could not save the captured article.");
    }
  });

  const post = () => {
    globalThis.postMessage({ type: "marginalia:capture", id, payload }, globalThis.location.origin);
  };

  post();
  const timer = setInterval(() => {
    if (done || attempts >= 60) {
      clearInterval(timer);
      return;
    }
    attempts += 1;
    post();
  }, 500);
}
