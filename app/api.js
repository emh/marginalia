import { loadSettings } from "./storage.js";

const ARTICLE_PATH = "/api/articles";

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
  const endpoint = getEndpoint(settings.apiBaseUrl);
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.appToken) {
    headers.Authorization = `Bearer ${settings.appToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  const payload = await response.json();
  return normalizeArticle(payload.article || payload);
}

function getEndpoint(apiBaseUrl) {
  const base = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, "") : getSameOriginApiBase();
  return new URL(ARTICLE_PATH, `${base}/`).toString();
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
  const source = article.source || article.siteName || hostFromUrl(article.url);
  const wordCount = Number.isFinite(article.wordCount) ? article.wordCount : estimateWords(article.summary);
  const readingTime = Number.isFinite(article.readingTime)
    ? article.readingTime
    : Math.max(1, Math.round(wordCount / 225));

  return {
    id: String(article.id || crypto.randomUUID()),
    url: article.url,
    canonicalUrl: article.canonicalUrl || article.url,
    title: article.title || `Article from ${source}`,
    source,
    siteName: article.siteName || source,
    author: article.author || "Unknown",
    publishedAt: article.publishedAt || null,
    dateAdded: article.dateAdded || new Date().toISOString(),
    wordCount,
    readingTime,
    summary: article.summary || "",
    tags: Array.isArray(article.tags) ? article.tags : [],
    category: normalizeCategory(article.category || "Other"),
    isRead: Boolean(article.isRead),
    embedding: Array.isArray(article.embedding) ? article.embedding : article.vec,
    status: article.status || "ready",
    error: article.error || ""
  };
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
