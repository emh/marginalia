const DEFAULT_APP_URL = "https://emh.io/marginalia/";
const CAPTURE_PREFIX = "capture:";
const CAPTURE_TTL_MS = 60 * 60 * 1000;

chrome.action.onClicked.addListener(tab => {
  runCapture(tab).catch(error => {
    console.error("Marginalia capture failed", error);
    setBadge(tab?.id, "ERR", "#9a0000");
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

async function runCapture(tab) {
  if (!tab?.id || !isCaptureUrl(tab.url)) {
    throw new Error("Open an article page before saving to Marginalia.");
  }

  setBadge(tab.id, "...", "#777777");
  await pruneCaptures();

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: captureReadablePage
  });

  const payload = normalizePayload(result);
  const id = crypto.randomUUID();
  await chrome.storage.local.set({
    [`${CAPTURE_PREFIX}${id}`]: {
      payload,
      createdAt: Date.now()
    }
  });

  await chrome.tabs.create({
    url: captureUrl(await getAppUrl(), id),
    openerTabId: tab.id
  });
  setBadge(tab.id, "OK", "#0b7a3b");
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return { ok: false, error: "Invalid message" };
  }

  if (message.type === "marginalia:get-capture") {
    const id = captureId(message.id);
    const key = `${CAPTURE_PREFIX}${id}`;
    const stored = await chrome.storage.local.get(key);
    const record = stored[key];
    if (!record?.payload) return { ok: false, error: "Capture not found" };
    return { ok: true, payload: record.payload };
  }

  if (message.type === "marginalia:clear-capture") {
    const id = captureId(message.id);
    await chrome.storage.local.remove(`${CAPTURE_PREFIX}${id}`);
    return { ok: true };
  }

  return { ok: false, error: "Unknown message" };
}

async function getAppUrl() {
  const settings = await chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL });
  return normalizeAppUrl(settings.appUrl);
}

function captureUrl(appUrl, id) {
  const url = new URL(appUrl);
  url.searchParams.set("capture", id);
  return url.toString();
}

function normalizeAppUrl(value) {
  try {
    const url = new URL(value || DEFAULT_APP_URL);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_APP_URL;
    return url.toString();
  } catch {
    return DEFAULT_APP_URL;
  }
}

function normalizePayload(value) {
  if (!value || typeof value !== "object") {
    throw new Error("No readable article text found.");
  }

  const wordCount = countWords(value.textContent || value.contentMarkdown);
  if (wordCount < 40) {
    throw new Error("No readable article text found.");
  }

  return {
    requestedUrl: stringOr(value.requestedUrl || value.url, ""),
    finalUrl: stringOr(value.finalUrl || value.url || value.requestedUrl, ""),
    canonicalUrl: stringOr(value.canonicalUrl, ""),
    sourceHost: stringOr(value.sourceHost, ""),
    title: stringOr(value.title, "Untitled article"),
    byline: stringOr(value.byline, ""),
    siteName: stringOr(value.siteName, ""),
    excerpt: stringOr(value.excerpt, ""),
    publishedAt: stringOr(value.publishedAt, ""),
    capturedAt: new Date().toISOString(),
    lang: stringOr(value.lang, ""),
    contentMarkdown: stringOr(value.contentMarkdown, ""),
    textContent: stringOr(value.textContent, ""),
    headings: Array.isArray(value.headings) ? value.headings : [],
    captureSource: "chrome-extension"
  };
}

function isCaptureUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value || "").protocol);
  } catch {
    return false;
  }
}

function captureId(value) {
  const id = String(value || "").trim();
  if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new Error("Invalid capture id");
  return id;
}

async function pruneCaptures() {
  const all = await chrome.storage.local.get(null);
  const staleKeys = [];
  const now = Date.now();
  for (const [key, record] of Object.entries(all)) {
    if (!key.startsWith(CAPTURE_PREFIX)) continue;
    if (!record?.createdAt || now - record.createdAt > CAPTURE_TTL_MS) {
      staleKeys.push(key);
    }
  }
  if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
}

function setBadge(tabId, text, color) {
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 1600);
}

function stringOr(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function countWords(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function captureReadablePage() {
  const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre";
  const REMOVE_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "template",
    "button",
    "input",
    "select",
    "textarea",
    "[hidden]",
    "[aria-hidden='true']",
    "[role='navigation']",
    "[role='complementary']"
  ].join(",");
  const ROOT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    "[itemprop='articleBody']",
    "[data-testid='article-body']",
    "[data-testid='story-body']",
    "section[name='articleBody']",
    ".article-body",
    ".story-body",
    ".entry-content",
    ".post-content",
    "#article",
    "#main"
  ];

  function meta(names) {
    for (const name of names) {
      const selector = `meta[name="${cssEscape(name)}"],meta[property="${cssEscape(name)}"]`;
      const value = document.querySelector(selector)?.getAttribute("content");
      if (value?.trim()) return cleanText(value);
    }
    return "";
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/"/g, "\\\"");
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visibleText(element) {
    if (!element || isSkippable(element)) return "";
    return cleanText(element.innerText || element.textContent || "");
  }

  function isHidden(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.closest("[hidden],[aria-hidden='true']")) return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  }

  function isSkippable(element) {
    return Boolean(element.closest(REMOVE_SELECTOR)) || isHidden(element);
  }

  function roots() {
    const seen = new Set();
    const items = [];
    for (const selector of ROOT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element) || isSkippable(element)) continue;
        seen.add(element);
        items.push(element);
      }
    }
    if (document.body && !seen.has(document.body)) items.push(document.body);
    return items;
  }

  function rootScore(element) {
    const text = visibleText(element);
    const links = Array.from(element.querySelectorAll("a")).map(visibleText).join(" ");
    const paragraphs = element.querySelectorAll("p").length;
    const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
    return text.length - links.length * 0.35 + paragraphs * 120 + headings * 60;
  }

  function blockText(element) {
    if (isSkippable(element)) return "";
    const text = cleanText(element.innerText || element.textContent || "");
    if (!text) return "";
    if (element.matches("p,li,blockquote") && text.length < 20) return "";
    return text;
  }

  function hasBlockAncestor(element, root) {
    let current = element.parentElement;
    while (current && current !== root) {
      if (current.matches(BLOCK_SELECTOR)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function markdownBlock(element, text) {
    const name = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(name)) {
      return `${"#".repeat(Number(name.slice(1)))} ${text}`;
    }
    if (name === "li") return `- ${text}`;
    if (name === "blockquote") return `> ${text}`;
    return text;
  }

  function articleMarkdown(root) {
    const blocks = [];
    const seen = new Set();
    for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
      if (hasBlockAncestor(element, root)) continue;
      const text = blockText(element);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      blocks.push(markdownBlock(element, text));
    }
    return blocks.join("\n\n").trim();
  }

  function headings(root) {
    return Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map(element => ({
        level: Number(element.tagName.slice(1)),
        text: blockText(element)
      }))
      .filter(item => item.text)
      .slice(0, 64);
  }

  function byline() {
    const selectors = [
      "[rel='author']",
      "[itemprop='author']",
      ".byline",
      ".author",
      "[data-testid*='byline' i]",
      "[class*='byline' i]",
      "[class*='author' i]"
    ];
    for (const selector of selectors) {
      const text = cleanText(document.querySelector(selector)?.textContent || "");
      if (text && text.length < 160) return text.replace(/^by\s+/i, "");
    }
    return meta(["author", "article:author", "parsely-author"]);
  }

  function canonicalUrl() {
    try {
      return new URL(document.querySelector("link[rel='canonical']")?.href || location.href).toString();
    } catch {
      return location.href;
    }
  }

  const root = roots().sort((a, b) => rootScore(b) - rootScore(a))[0] || document.body;
  const contentMarkdown = articleMarkdown(root) || cleanText(visibleText(root));
  const textContent = cleanText(contentMarkdown.replace(/^#{1,6}\s+/gm, "").replace(/^>\s+/gm, "").replace(/^[-*]\s+/gm, ""));
  const rootHeading = blockText(root.querySelector("h1"));
  const title = meta(["og:title", "twitter:title"]) || rootHeading || cleanText(document.title).replace(/\s+[|-]\s+.+$/, "");
  const url = location.href;
  const host = location.hostname.replace(/^www\./, "");

  return {
    requestedUrl: url,
    finalUrl: url,
    canonicalUrl: canonicalUrl(),
    sourceHost: host,
    title,
    byline: byline(),
    siteName: meta(["og:site_name", "application-name"]) || host,
    excerpt: meta(["description", "og:description", "twitter:description"]),
    publishedAt: meta(["article:published_time", "date", "dc.date", "pubdate"]) || document.querySelector("time[datetime]")?.getAttribute("datetime") || "",
    lang: document.documentElement.lang || meta(["language", "og:locale"]),
    contentMarkdown,
    textContent,
    headings: headings(root)
  };
}
