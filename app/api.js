import { normalizeArticleRecord } from "./model.js";
import { loadSettings } from "./storage.js";

const EXTRACT_PATH = "/api/extract";
const CAPTURE_PATH = "/api/capture";

const BROAD_CATEGORY_MATCHERS = [
  ["Business", /\b(startup|startups|business|strategy|management|company|companies|market|markets|economics|finance|labor|work)\b/i],
  ["Mathematics", /\b(math|mathematics|mathematical)\b/i],
  ["Philosophy", /\b(philosophy|philosophical|ethics|epistemology|consciousness|mind)\b/i],
  ["Politics", /\b(policy|politics|political|government|governance|regulation|law)\b/i],
  ["Design", /\b(design|typography|ux|interface|visual)\b/i],
  ["Technology", /\b(technology|software|engineering|frontend|programming|ai|llm|prompt|prompting|forecasting|computer|internet|web|data|infrastructure)\b/i],
  ["Science", /\b(science|research|physics|biology|neuroscience|climate|space)\b/i],
  ["Health", /\b(health|medicine|medical|sleep|exercise|nutrition|cognition)\b/i],
  ["Culture", /\b(culture|media|society|language|writing|education|humanities)\b/i]
];

export async function ingestArticle(url, settings = loadSettings()) {
  return requestArticle(EXTRACT_PATH, { url }, settings);
}

export async function captureArticle(capture, settings = loadSettings()) {
  return requestArticle(CAPTURE_PATH, capture, settings);
}

async function requestArticle(path, body, settings) {
  const endpoint = getEndpoint(settings.apiBaseUrl, path);
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.appToken) {
    headers.Authorization = `Bearer ${settings.appToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  const article = normalizeArticle(payload.article || payload);
  if (isExtractionFailure(article)) {
    throw new Error(article.error || article.summary || "Article could not be extracted");
  }

  return article;
}

function getEndpoint(apiBaseUrl, path = EXTRACT_PATH) {
  const base = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, "") : getSameOriginApiBase();
  return new URL(path, `${base}/`).toString();
}

function getSameOriginApiBase() {
  const host = globalThis.location?.hostname || "";
  if (host.endsWith(".github.io")) {
    throw new Error("Production API URL is not configured. Set app/config.js to the article Worker URL.");
  }
  return globalThis.location.origin;
}

async function getErrorMessage(response) {
  try {
    const payload = await response.json();
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    // Fall through to status text.
  }

  return response.statusText || "Request failed";
}

function normalizeArticle(article) {
  const source = article.sourceHost || article.source || article.siteName || hostFromUrl(article.requestedUrl || article.url);
  const normalized = normalizeArticleRecord({
    ...article,
    id: String(article.id || crypto.randomUUID()),
    requestedUrl: article.requestedUrl || article.url,
    finalUrl: article.finalUrl || article.url || article.requestedUrl,
    sourceHost: source,
    byline: article.byline || article.author || "Unknown",
    excerpt: article.excerpt || article.summary || "",
    capturedAt: article.capturedAt || article.dateAdded || new Date().toISOString(),
    category: normalizeCategory(article.category || "Other"),
    isArchived: article.isArchived == null ? article.isRead : article.isArchived
  });

  if (!normalized.wordCount) {
    normalized.wordCount = estimateWords(normalized.textContent || normalized.excerpt);
    normalized.readingTime = Math.max(1, Math.round(normalized.wordCount / 225));
  }

  return normalized;
}

function normalizeCategory(category) {
  const text = String(category || "").trim();
  if (!text) return "Other";

  for (const [label, matcher] of BROAD_CATEGORY_MATCHERS) {
    if (matcher.test(text)) return label;
  }

  return text.length <= 18 && !/[&/]/.test(text) ? text : "Other";
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}

function estimateWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isExtractionFailure(article) {
  return (
    article.status === "failed" ||
    article.status === "fetch_failed" ||
    article.status === "metadata_only" ||
    /metadata could not be extracted/i.test(article.summary)
  );
}
