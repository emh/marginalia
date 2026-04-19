const MAX_PROMPT_CHARS = 28_000;
const BROAD_CATEGORIES = [
  "Technology",
  "Business",
  "Science",
  "Mathematics",
  "Culture",
  "Philosophy",
  "Politics",
  "Design",
  "Health",
  "Other"
];

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

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/metadata") {
        return json({ error: "Not found" }, 404);
      }

      const page = await request.json();
      const metadata = await createMetadata(page, env);
      return json(metadata, 200);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400);
    }
  }
};

async function createMetadata(page, env) {
  if (env.MOCK_LLM === "true") {
    return heuristicMetadata(page);
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_LLM is false");
  }

  if (!env.OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL is required when MOCK_LLM is false");
  }

  const metadata = await extractWithOpenAI(page, env);

  if (env.OPENAI_EMBEDDING_MODEL) {
    metadata.embedding = await embedMetadata(metadata, env);
  } else {
    metadata.embedding = semanticVector(`${metadata.title} ${metadata.summary} ${(metadata.tags || []).join(" ")}`);
  }

  return metadata;
}

async function extractWithOpenAI(page, env) {
  const useWebSearch = shouldUseWebSearch(page, env);
  let response = await requestOpenAIMetadata(page, env, useWebSearch);
  let searchError = "";

  if (!response.ok && useWebSearch) {
    searchError = await openAIError(response, "OpenAI metadata request with web search failed");
    response = await requestOpenAIMetadata(page, env, false);
  }

  if (!response.ok) {
    const message = await openAIError(response, "OpenAI metadata request failed");
    throw new Error(searchError ? `${searchError}; ${message}` : message);
  }

  const payload = await response.json();
  const outputText = getOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no metadata text");

  const metadata = normalizeMetadata(JSON.parse(outputText), page);
  metadata.sources = mergeSources(metadata.sources, openAISources(payload));
  return metadata;
}

async function requestOpenAIMetadata(page, env, useWebSearch) {
  const body = {
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: metadataSystemPrompt(useWebSearch)
      },
      {
        role: "user",
        content: articlePrompt(page)
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "article_metadata",
        strict: true,
        schema: metadataSchema()
      }
    }
  };

  if (useWebSearch) {
    body.tools = [{ type: "web_search" }];
    body.tool_choice = "auto";
    body.include = ["web_search_call.action.sources"];
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return response;
}

function shouldUseWebSearch(page, env) {
  if (env.METADATA_WEB_SEARCH === "false") return false;
  const text = String(page.text || page.textContent || "").trim();
  return page.fetchStatus === "metadata_only" || countWords(text) < 80;
}

function metadataSystemPrompt(useWebSearch) {
  const base = `Extract article metadata for a private reading-list app. Return concise, factual JSON. The category must be one broad top-level bucket from this list: ${BROAD_CATEGORIES.join(", ")}. Put narrow topics in tags, not category.`;
  if (!useWebSearch) {
    return `${base} Use only the provided article text and page hints. Put an empty array in sources.`;
  }

  return `${base} The article text may be missing or incomplete. Use web search only to find public metadata, snippets, and reliable references for the exact URL or canonical article. Do not invent article body text and do not claim access to content that is not supported by the provided text or public search results. Include source URLs that support the summary in sources.`;
}

async function embedMetadata(metadata, env) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: `${metadata.title}\n\n${metadata.summary}\n\n${(metadata.tags || []).join(", ")}`
    })
  });

  if (!response.ok) {
    throw new Error(await openAIError(response, "OpenAI embedding request failed"));
  }

  const payload = await response.json();
  return payload.data?.[0]?.embedding || [];
}

async function openAIError(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.error || payload?.message;
    if (typeof message === "string" && message) {
      return `${fallback}: ${message}`;
    }
  } catch {
    // Fall through to status text.
  }

  return `${fallback}: ${response.status}`;
}

function articlePrompt(page) {
  return [
    `URL: ${page.url || ""}`,
    `Canonical URL: ${page.canonicalUrl || ""}`,
    `Page title: ${page.title || ""}`,
    `Author hint: ${page.author || ""}`,
    `Publisher hint: ${page.siteName || page.source || ""}`,
    `Published hint: ${page.publishedAt || ""}`,
    `Word count hint: ${page.wordCount || ""}`,
    `Extraction status: ${page.fetchStatus || ""}`,
    `Extraction error: ${page.fetchError || page.error || ""}`,
    "",
    "Article text:",
    String(page.text || page.textContent || "").slice(0, MAX_PROMPT_CHARS)
  ].join("\n");
}

function metadataSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "author", "publisher", "publishedAt", "summary", "tags", "category", "wordCount", "canonicalUrl", "sources"],
    properties: {
      title: { type: "string" },
      author: { type: "string" },
      publisher: { type: "string" },
      publishedAt: { type: "string" },
      summary: { type: "string" },
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string" }
      },
      category: { type: "string", enum: BROAD_CATEGORIES },
      wordCount: { type: "number" },
      canonicalUrl: { type: "string" },
      sources: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url"],
          properties: {
            title: { type: "string" },
            url: { type: "string" }
          }
        }
      }
    }
  };
}

function getOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }

  return chunks.join("");
}

function normalizeMetadata(metadata, page) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const summary = typeof metadata.summary === "string" ? metadata.summary.trim() : summarize(page.text);
  const wordCount = Number.isFinite(metadata.wordCount) && metadata.wordCount > 0
    ? Math.round(metadata.wordCount)
    : page.wordCount || countWords(page.text);

  return {
    title: stringOr(metadata.title, page.title || titleFromUrl(page.url)),
    author: stringOr(metadata.author, page.author || "Unknown"),
    publisher: stringOr(metadata.publisher, page.siteName || page.source || hostFromUrl(page.url)),
    publishedAt: metadata.publishedAt || page.publishedAt || "",
    summary,
    tags: tags.map(tag => slugify(tag)).filter(Boolean).slice(0, 8),
    category: normalizeCategory(metadata.category, `${page.title} ${summary} ${tags.join(" ")}`),
    wordCount,
    canonicalUrl: stringOr(metadata.canonicalUrl, page.canonicalUrl || page.url),
    sources: normalizeSources(metadata.sources)
  };
}

function heuristicMetadata(page) {
  const summary = summarize(page.text);
  const tags = inferTags(`${page.title} ${page.text}`);
  const category = inferCategory(`${page.title} ${page.text}`, tags);

  return {
    title: page.title || titleFromUrl(page.url),
    author: page.author || "Unknown",
    publisher: page.siteName || page.source || hostFromUrl(page.url),
    publishedAt: page.publishedAt || "",
    summary,
    tags,
    category,
    wordCount: page.wordCount || countWords(page.text),
    canonicalUrl: page.canonicalUrl || page.url,
    sources: [],
    embedding: semanticVector(`${page.title} ${summary} ${tags.join(" ")}`)
  };
}

function openAISources(payload) {
  const sources = [];

  for (const item of payload.output || []) {
    if (Array.isArray(item.action?.sources)) {
      sources.push(...item.action.sources);
    }

    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        const citation = annotation.url_citation || annotation;
        if (citation?.url) {
          sources.push({ title: citation.title || "", url: citation.url });
        }
      }
    }
  }

  return normalizeSources(sources);
}

function mergeSources(...groups) {
  return normalizeSources(groups.flat());
}

function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const sources = [];

  for (const item of value) {
    const url = stringOr(item?.url || item?.uri || item?.href, "");
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      title: stringOr(item?.title || hostFromUrl(url), hostFromUrl(url)).slice(0, 160),
      url: key
    });
    if (sources.length >= 5) break;
  }

  return sources;
}

function summarize(text) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => sentence.length > 40);

  return sentences.slice(0, 3).join(" ").slice(0, 900) || "Summary unavailable.";
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

function inferCategory(text, tags) {
  return normalizeCategory("", `${text} ${tags.join(" ")}`);
}

function normalizeCategory(category, fallbackText = "") {
  const text = String(category || "").trim();
  if (BROAD_CATEGORIES.includes(text)) return text;

  const haystack = `${text} ${fallbackText}`;
  for (const [label, matcher] of BROAD_CATEGORY_MATCHERS) {
    if (matcher.test(haystack)) return label;
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

function titleFromUrl(input) {
  try {
    const url = new URL(input);
    const slug = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    return slug
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[-_]+/g)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "Untitled article";
  }
}

function hostFromUrl(input) {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}

function countWords(text) {
  return (String(text || "").match(/\S+/g) || []).length;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}
