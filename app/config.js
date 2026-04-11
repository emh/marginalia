globalThis.MARGINALIA_CONFIG = {
  apiBaseUrl: ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname)
    ? ""
    : "https://marginalia-article.emh.workers.dev"
};
