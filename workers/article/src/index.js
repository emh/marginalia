const MAX_ARTICLE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 40_000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST" || url.pathname !== "/api/articles") {
        return json({ error: "Not found" }, 404, cors);
      }

      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401, cors);
      }

      const body = await request.json();
      const articleUrl = normalizeArticleUrl(body.url);
      const page = await getArticlePage(articleUrl, env);
      const metadata = await askMetadataWorker(page, env);
      const article = buildArticle(page, metadata);

      return json({ article }, 200, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400, cors);
    }
  }
};

function isAuthorized(request, env) {
  if (!env.APP_TOKEN) return true;
  const authorization = request.headers.get("Authorization") || "";
  const explicit = request.headers.get("X-Marginalia-Token") || "";
  return authorization === `Bearer ${env.APP_TOKEN}` || explicit === env.APP_TOKEN;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Marginalia-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

function normalizeArticleUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("URL is required");
  }

  const text = input.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  if (isBlockedHost(url.hostname)) {
    throw new Error("This URL is not allowed");
  }

  url.hash = "";
  return url.toString();
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (host === "::1" || host.startsWith("[::1]")) return true;
  return false;
}

async function fetchArticlePage(articleUrl) {
  const response = await fetch(articleUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
      "User-Agent": "MarginaliaBot/0.1 (+https://github.com)"
    }
  });

  if (!response.ok) {
    throw new Error(`Article returned ${response.status}`);
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    throw new Error("URL did not return an article-like document");
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARTICLE_BYTES) {
    throw new Error("Article is too large");
  }

  const html = await response.text();
  if (html.length > MAX_ARTICLE_BYTES) {
    throw new Error("Article is too large");
  }

  return extractPage(articleUrl, html);
}

async function getArticlePage(articleUrl, env) {
  try {
    return await fetchArticlePage(articleUrl);
  } catch (error) {
    const directError = messageFromError(error);
    const readerPage = await fetchReaderFallback(articleUrl, directError, env);
    if (readerPage) return readerPage;

    console.warn(`Article fetch failed for ${articleUrl}: ${directError}`);
    throw new Error(`Article could not be extracted: ${directError}`);
  }
}

async function fetchReaderFallback(articleUrl, directError, env) {
  if (!env.READER_FALLBACK_URL) return null;

  try {
    const readerUrl = buildReaderUrl(env.READER_FALLBACK_URL, articleUrl);
    const response = await fetch(readerUrl, {
      headers: {
        "Accept": "text/plain, text/markdown;q=0.9, */*;q=0.1",
        "User-Agent": "MarginaliaBot/0.1 (+https://github.com)"
      }
    });

    if (!response.ok) {
      throw new Error(`Reader fallback returned ${response.status}`);
    }

    const markdown = await response.text();
    if (!markdown.trim()) {
      throw new Error("Reader fallback returned no content");
    }

    const page = extractReaderPage(articleUrl, markdown.slice(0, MAX_TEXT_CHARS));
    page.fetchStatus = "reader_fallback";
    page.fetchError = directError;
    console.warn(`Used reader fallback for ${articleUrl}: ${directError}`);
    return page;
  } catch (error) {
    console.warn(`Reader fallback failed for ${articleUrl}: ${messageFromError(error)}`);
    return null;
  }
}

function buildReaderUrl(readerFallbackUrl, articleUrl) {
  return `${readerFallbackUrl.replace(/\/+$/, "")}/${articleUrl}`;
}

function extractReaderPage(articleUrl, markdown) {
  const url = new URL(articleUrl);
  const source = url.hostname.replace(/^www\./, "");
  const title = getReaderField(markdown, "Title") || titleFromMarkdown(markdown) || titleFromUrl(url);
  const sourceUrl = getReaderField(markdown, "URL Source") || articleUrl;
  const publishedAt = getReaderField(markdown, "Published Time") || null;
  const author = getReaderAuthor(markdown);
  const content = markdown
    .replace(/^Title:.*$/im, "")
    .replace(/^URL Source:.*$/im, "")
    .replace(/^Published Time:.*$/im, "")
    .replace(/^Markdown Content:\s*$/im, "")
    .trim();
  const text = markdownToText(cleanReaderContent(content));

  return {
    url: articleUrl,
    canonicalUrl: sourceUrl,
    source,
    siteName: source,
    title,
    author,
    publishedAt,
    text,
    wordCount: countWords(text)
  };
}

function getReaderField(markdown, field) {
  const match = markdown.match(new RegExp(`^${escapeRegExp(field)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function titleFromMarkdown(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/\s+\|\s+.+$/, "").trim() || "";
}

function getReaderAuthor(markdown) {
  const match = markdown.match(/^[A-Z][a-z]+ \d{1,2}, \d{4}\s*[·|]\s*(.+)$/m);
  return match?.[1]?.trim() || "";
}

function cleanReaderContent(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tocIndex = lines.findIndex(line => /^Table of Contents$/i.test(line.trim()));
  if (tocIndex < 0) return markdown;

  const lead = getReaderLead(lines.slice(0, tocIndex));
  let start = tocIndex + 1;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (!line || line.startsWith("*") || line.startsWith("-")) {
      start += 1;
      continue;
    }
    break;
  }

  const body = lines.slice(start).join("\n").trim();
  return [lead, body].filter(Boolean).join("\n\n") || markdown;
}

function getReaderLead(lines) {
  const candidates = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "|" || line.startsWith("*") || line.startsWith("[") || line.startsWith("#")) continue;
    if (/^Rye blog$/i.test(line)) continue;
    if (/^[A-Z][a-z]+ \d{1,2}, \d{4}\s*[·|]/.test(line)) continue;
    if (line.includes("](")) continue;
    if (line.length < 24) continue;
    candidates.push(line);
  }

  return candidates.slice(0, 2).join(" ");
}

function markdownToText(markdown) {
  return decodeEntities(markdown)
    .replace(/^#{2,}\s+.*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPage(articleUrl, html) {
  const url = new URL(articleUrl);
  const source = url.hostname.replace(/^www\./, "");
  const title = getMeta(html, ["og:title", "twitter:title"]) || getTitle(html) || titleFromUrl(url);
  const siteName = getMeta(html, ["og:site_name", "application-name"]) || source;
  const author = getMeta(html, ["author", "article:author", "parsely-author"]) || "";
  const publishedAt = getMeta(html, ["article:published_time", "date", "dc.date", "pubdate"]) || null;
  const canonicalUrl = getCanonicalUrl(html, url) || articleUrl;
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
  const wordCount = countWords(text);

  return {
    url: articleUrl,
    canonicalUrl,
    source,
    siteName,
    title,
    author,
    publishedAt,
    text,
    wordCount
  };
}

async function askMetadataWorker(page, env) {
  const request = new Request("https://metadata.local/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(page)
  });

  let serviceBindingError = null;

  if (env.METADATA?.fetch) {
    let response;
    try {
      response = await env.METADATA.fetch(request);
    } catch (error) {
      serviceBindingError = error;
    }

    if (response) {
      if (!response.ok) {
        throw new Error(await responseError(response, "Metadata Worker failed"));
      }
      return response.json();
    }
  }

  if (env.METADATA_WORKER_URL) {
    const response = await fetch(new URL("/metadata", env.METADATA_WORKER_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page)
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "Metadata Worker failed"));
    }
    return response.json();
  }

  if (serviceBindingError) {
    throw serviceBindingError;
  }

  throw new Error("Metadata Worker is not configured");
}

async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    if (typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
  } catch {
    // Fall through to status text.
  }

  return `${fallback}: ${response.status}`;
}

function buildArticle(page, metadata) {
  const wordCount = metadata.wordCount || page.wordCount || countWords(page.text);

  return {
    id: crypto.randomUUID(),
    url: page.url,
    canonicalUrl: metadata.canonicalUrl || page.canonicalUrl || page.url,
    title: metadata.title || page.title,
    source: metadata.source || page.source,
    siteName: metadata.publisher || metadata.siteName || page.siteName || page.source,
    author: metadata.author || page.author || "Unknown",
    publishedAt: metadata.publishedAt || page.publishedAt || null,
    dateAdded: new Date().toISOString(),
    wordCount,
    readingTime: Math.max(1, Math.round(wordCount / 225)),
    summary: metadata.summary || summarize(page.text),
    tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 8) : [],
    category: metadata.category || "Other",
    embedding: Array.isArray(metadata.embedding) ? metadata.embedding : semanticVector(`${metadata.category || ""} ${metadata.summary || ""}`),
    isRead: false,
    status: page.fetchStatus || "ready",
    error: page.fetchError || ""
  };
}

function getMeta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escapeRegExp(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const reversePattern = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escapeRegExp(name)}["'][^>]*>`, "i");
    const match = html.match(pattern) || html.match(reversePattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return "";
}

function getTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1].replace(/\s+/g, " ").trim()) : "";
}

function getCanonicalUrl(html, baseUrl) {
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);
  if (!match?.[1]) return "";
  try {
    return new URL(decodeEntities(match[1]), baseUrl).toString();
  } catch {
    return "";
  }
}

function htmlToText(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:p|br|li|h[1-6]|div|section|article|blockquote|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function titleFromUrl(url) {
  const slug = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
  return slug
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function summarize(text) {
  const sentences = String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => sentence.length > 40);

  return sentences.slice(0, 3).join(" ").slice(0, 900) || "Summary unavailable.";
}

function semanticVector(text) {
  const buckets = new Array(8).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9-]+/g) || [];
  for (const word of words) {
    buckets[hashWord(word) % buckets.length] += 1;
  }
  const magnitude = Math.sqrt(buckets.reduce((sum, n) => sum + n * n, 0)) || 1;
  return buckets.map(n => n / magnitude);
}

function hashWord(word) {
  let hash = 0;
  for (let index = 0; index < word.length; index += 1) {
    hash = Math.imul(31, hash) + word.charCodeAt(index);
  }
  return Math.abs(hash);
}

function countWords(text) {
  return (String(text).match(/\S+/g) || []).length;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
