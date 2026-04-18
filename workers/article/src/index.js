const MAX_ARTICLE_BYTES = 2_000_000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST" || !["/api/articles", "/api/extract"].includes(url.pathname)) {
        return json({ error: "Not found" }, 404, cors);
      }

      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401, cors);
      }

      const body = await request.json();
      const articleUrl = normalizeArticleUrl(body.url);
      const page = await getArticlePage(articleUrl, env);
      const metadata = await getArticleMetadata(page, env);
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

  return extractPage(response.url || articleUrl, html, articleUrl);
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
    if (markdown.length > MAX_ARTICLE_BYTES) {
      throw new Error("Reader fallback article is too large");
    }

    const page = extractReaderPage(articleUrl, markdown);
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
  const contentMarkdown = cleanReaderContent(content);
  const text = markdownToText(contentMarkdown);

  return {
    requestedUrl: articleUrl,
    finalUrl: sourceUrl,
    url: articleUrl,
    canonicalUrl: sourceUrl,
    sourceHost: source,
    source,
    siteName: source,
    title,
    byline: author,
    author,
    publishedAt,
    lang: "",
    contentMarkdown,
    textContent: text,
    headings: headingsFromMarkdown(contentMarkdown),
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

function extractPage(finalUrl, html, requestedUrl = finalUrl) {
  const url = new URL(finalUrl);
  const source = url.hostname.replace(/^www\./, "");
  const title = getMeta(html, ["og:title", "twitter:title"]) || getTitle(html) || titleFromUrl(url);
  const siteName = getMeta(html, ["og:site_name", "application-name"]) || source;
  const author = getMeta(html, ["author", "article:author", "parsely-author"]) || "";
  const publishedAt = getMeta(html, ["article:published_time", "date", "dc.date", "pubdate"]) || null;
  const canonicalUrl = getCanonicalUrl(html, url) || finalUrl;
  const contentHtml = getMainContentHtml(html);
  const rawMarkdown = htmlToMarkdown(contentHtml, url);
  const rawText = markdownToText(rawMarkdown || htmlToText(html));
  const contentMarkdown = rawMarkdown;
  const text = rawText;
  const wordCount = countWords(rawText || text);

  return {
    requestedUrl,
    finalUrl,
    url: requestedUrl,
    canonicalUrl,
    sourceHost: source,
    source,
    siteName,
    title,
    byline: author,
    author,
    publishedAt,
    lang: getLang(html),
    contentMarkdown,
    textContent: text,
    headings: getHeadings(contentHtml),
    text,
    wordCount
  };
}

function getMainContentHtml(html) {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return (article?.[1] || main?.[1] || body?.[1] || html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:nav|header|footer|aside|form)\b[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi, " ");
}

function htmlToMarkdown(html, baseUrl) {
  let value = String(html || "");

  value = value
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => `\n\n${"#".repeat(Number(level))} ${inlineText(content, baseUrl)}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => `\n\n> ${inlineText(content, baseUrl)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${inlineText(content, baseUrl)}`)
    .replace(/<\/(?:ul|ol)>/gi, "\n\n")
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => `\n\n${inlineText(content, baseUrl)}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|section)>/gi, "\n\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
      const text = inlineText(content, baseUrl);
      if (!text) return "";
      try {
        return `[${text}](${new URL(decodeEntities(href), baseUrl).toString()})`;
      } catch {
        return text;
      }
    })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => alt ? ` ${decodeEntities(alt)} ` : " ")
    .replace(/<[^>]+>/g, " ");

  return cleanMarkdown(decodeEntities(value));
}

function inlineText(html, baseUrl) {
  return cleanMarkdown(decodeEntities(String(html || "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
      const text = inlineText(content, baseUrl);
      if (!text) return "";
      try {
        return `[${text}](${new URL(decodeEntities(href), baseUrl).toString()})`;
      } catch {
        return text;
      }
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")));
}

function cleanMarkdown(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getHeadings(html) {
  const headings = [];
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = pattern.exec(html)) && headings.length < 64) {
    const text = inlineText(match[2]).replace(/^#+\s*/, "").trim();
    if (text) headings.push({ level: Number(match[1]), text });
  }
  return headings;
}

function headingsFromMarkdown(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .map(line => line.match(/^(#{1,6})\s+(.+)$/))
    .filter(Boolean)
    .map(match => ({ level: match[1].length, text: match[2].trim() }))
    .slice(0, 64);
}

function getLang(html) {
  const htmlLang = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1];
  const metaLang = getMeta(html, ["language", "og:locale"]);
  return (htmlLang || metaLang || "").trim();
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

async function getArticleMetadata(page, env) {
  try {
    return await askMetadataWorker(page, env);
  } catch (error) {
    const message = messageFromError(error);
    console.warn(`Metadata extraction failed for ${page.url || page.requestedUrl}: ${message}`);
    return heuristicMetadata(page, message);
  }
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
  const requestedUrl = page.requestedUrl || page.url;
  const finalUrl = metadata.finalUrl || page.finalUrl || page.url;
  const canonicalUrl = metadata.canonicalUrl || page.canonicalUrl || finalUrl || requestedUrl;
  const sourceHost = metadata.sourceHost || metadata.source || page.sourceHost || page.source || hostFromUrl(canonicalUrl || finalUrl || requestedUrl);
  const byline = metadata.byline || metadata.author || page.byline || page.author || "Unknown";
  const excerpt = metadata.excerpt || metadata.summary || summarize(page.text);
  const capturedAt = new Date().toISOString();

  const article = {
    id: crypto.randomUUID(),
    requestedUrl,
    finalUrl,
    canonicalUrl,
    sourceHost,
    title: metadata.title || page.title,
    siteName: metadata.publisher || metadata.siteName || page.siteName || page.source,
    byline,
    publishedAt: metadata.publishedAt || page.publishedAt || null,
    capturedAt,
    lang: metadata.lang || page.lang || "",
    contentMarkdown: page.contentMarkdown || "",
    textContent: page.textContent || page.text || "",
    headings: Array.isArray(page.headings) ? page.headings : [],
    tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 8) : [],
    notes: "",
    isFavorite: false,
    isArchived: false,
    deleted: false,
    addedByUserId: "",
    addedByName: "",
    updatedAt: "",
    wordCount,
    readingTime: Math.max(1, Math.round(wordCount / 225)),
    category: metadata.category || "Other",
    embedding: Array.isArray(metadata.embedding) ? metadata.embedding : semanticVector(`${metadata.category || ""} ${metadata.summary || ""}`),
    isRead: false,
    status: page.fetchStatus || metadata.status || "ready",
    error: [page.fetchError, metadata.error].filter(Boolean).join("; ")
  };

  return {
    ...article,
    url: requestedUrl,
    source: sourceHost,
    author: byline,
    summary: excerpt,
    excerpt,
    dateAdded: capturedAt
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

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}

function summarize(text) {
  const sentences = String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => sentence.length > 40);

  return sentences.slice(0, 3).join(" ").slice(0, 900) || "Summary unavailable.";
}

function heuristicMetadata(page, error = "") {
  const text = page.textContent || page.text || markdownToText(page.contentMarkdown || "");
  const summary = summarize(text);
  const tags = inferTags(`${page.title || ""} ${text}`);
  const category = inferCategory(`${page.title || ""} ${summary} ${tags.join(" ")}`);

  return {
    title: page.title || titleFromUrl(page.url || page.requestedUrl || ""),
    author: page.byline || page.author || "Unknown",
    publisher: page.siteName || page.source || page.sourceHost || hostFromUrl(page.url || page.requestedUrl || ""),
    publishedAt: page.publishedAt || "",
    summary,
    tags,
    category,
    wordCount: page.wordCount || countWords(text),
    canonicalUrl: page.canonicalUrl || page.finalUrl || page.url || page.requestedUrl || "",
    embedding: semanticVector(`${page.title || ""} ${summary} ${tags.join(" ")}`),
    status: "metadata_failed",
    error: error ? `Metadata unavailable: ${error}` : "Metadata unavailable"
  };
}

function inferTags(text) {
  const stop = new Set(["about", "after", "again", "also", "because", "before", "being", "between", "could", "every", "first", "from", "have", "into", "more", "most", "other", "over", "some", "than", "that", "their", "there", "these", "this", "through", "what", "when", "where", "which", "while", "with", "would"]);
  const counts = new Map();
  const words = String(text).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];

  for (const word of words) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => slugify(word))
    .filter(Boolean);
}

function inferCategory(text) {
  const matchers = [
    ["Business", /\b(startup|startups|business|strategy|management|company|companies|market|markets|economics|finance|labor|work)\b/i],
    ["Mathematics", /\b(math|mathematics|mathematical)\b/i],
    ["Philosophy", /\b(philosophy|philosophical|ethics|epistemology|consciousness|mind)\b/i],
    ["Politics", /\b(policy|politics|political|government|governance|regulation|law|election|senate|congress|president)\b/i],
    ["Design", /\b(design|typography|ux|interface|visual)\b/i],
    ["Technology", /\b(technology|software|engineering|frontend|programming|ai|llm|prompt|computer|internet|web|data|infrastructure)\b/i],
    ["Science", /\b(science|research|physics|biology|neuroscience|climate|space)\b/i],
    ["Health", /\b(health|medicine|medical|sleep|exercise|nutrition|cognition)\b/i],
    ["Culture", /\b(culture|media|society|language|writing|education|humanities)\b/i]
  ];

  for (const [label, matcher] of matchers) {
    if (matcher.test(text)) return label;
  }

  return "Other";
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

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
