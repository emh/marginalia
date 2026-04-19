export const ARTICLE_FIELDS = [
  "requestedUrl",
  "finalUrl",
  "canonicalUrl",
  "sourceHost",
  "title",
  "byline",
  "siteName",
  "excerpt",
  "publishedAt",
  "capturedAt",
  "lang",
  "contentMarkdown",
  "textContent",
  "headings",
  "tags",
  "notes",
  "isFavorite",
  "isArchived",
  "deleted",
  "addedByUserId",
  "updatedAt",
  "wordCount",
  "readingTime",
  "category",
  "embedding",
  "status",
  "error",
  "metadataSources"
];

export const ARTICLE_MUTATION_FIELDS = [
  "_create",
  "title",
  "tags",
  "notes",
  "isFavorite",
  "isArchived",
  "deleted"
];

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createDeviceId() {
  return createId();
}

export function createUser() {
  return {
    id: createId(),
    profileCode: ""
  };
}

export function normalizeUser(user) {
  if (!user || typeof user !== "object") return null;
  const id = typeof user.id === "string" && user.id.trim() ? user.id.trim() : "";
  if (!id) return null;
  return {
    id,
    profileCode: normalizeCode(user.profileCode)
  };
}

export function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function serializeHlc(wallTime, counter, deviceId) {
  return `${String(Math.max(0, Number(wallTime) || 0)).padStart(13, "0")}:${String(Math.max(0, Number(counter) || 0)).padStart(4, "0")}:${deviceId || ""}`;
}

export function parseHlc(value) {
  if (typeof value !== "string" || !value) {
    return { wallTime: 0, counter: 0, deviceId: "" };
  }

  const [wallTime, counter, ...deviceParts] = value.split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

export function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

export function tickHlc(state, now = Date.now(), deviceId = state.deviceId) {
  const clock = normalizeClock(state.hlc);
  const wallTime = Math.max(clock.wallTime, now);
  const counter = wallTime === clock.wallTime ? clock.counter + 1 : 0;
  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function observeHlc(state, timestamp, now = Date.now(), deviceId = state.deviceId) {
  const local = normalizeClock(state.hlc);
  const remote = parseHlc(timestamp);
  const wallTime = Math.max(local.wallTime, remote.wallTime, now);
  let counter = 0;

  if (wallTime === local.wallTime && wallTime === remote.wallTime) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wallTime === local.wallTime) {
    counter = local.counter + 1;
  } else if (wallTime === remote.wallTime) {
    counter = remote.counter + 1;
  }

  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function createMutation(state, entityType, entityId, field, value) {
  const user = state.user || createUser();
  if (!user.id) throw new Error("User id required");

  return {
    id: createId(),
    entityType,
    entityId: String(entityId || ""),
    field: String(field || ""),
    value,
    timestamp: tickHlc(state, Date.now(), state.deviceId),
    authorId: user.id,
    deviceId: state.deviceId
  };
}

export function normalizeArticleRecord(input = {}) {
  const requestedUrl = stringOr(input.requestedUrl, input.url || input.finalUrl || input.canonicalUrl || "");
  const finalUrl = stringOr(input.finalUrl, input.url || requestedUrl);
  const canonicalUrl = stringOr(input.canonicalUrl, finalUrl || requestedUrl);
  const sourceHost = stringOr(input.sourceHost, input.source || hostFromUrl(canonicalUrl || finalUrl || requestedUrl));
  const excerpt = stringOr(input.excerpt, input.summary || "");
  const textContent = stringOr(input.textContent, input.text || excerpt || input.contentMarkdown || "");
  const wordCount = numberOr(input.wordCount, countWords(textContent || input.contentMarkdown || excerpt));
  const capturedAt = typeof input.capturedAt === "string" && input.capturedAt
    ? input.capturedAt
    : typeof input.dateAdded === "string" && input.dateAdded
      ? input.dateAdded
      : new Date().toISOString();
  const isArchived = input.isArchived == null ? Boolean(input.isRead) : Boolean(input.isArchived);

  return {
    id: String(input.id || createId()),
    requestedUrl,
    finalUrl,
    canonicalUrl,
    sourceHost,
    title: String(input.title || "").trim().slice(0, 300) || `Article from ${sourceHost || "source"}`,
    byline: stringOr(input.byline, input.author || "Unknown"),
    siteName: stringOr(input.siteName, input.source || sourceHost),
    excerpt,
    publishedAt: typeof input.publishedAt === "string" && input.publishedAt ? input.publishedAt : null,
    capturedAt,
    lang: stringOr(input.lang, ""),
    contentMarkdown: stringOr(input.contentMarkdown, ""),
    textContent,
    headings: normalizeHeadings(input.headings),
    tags: normalizeTags(input.tags),
    notes: stringOr(input.notes, ""),
    isFavorite: Boolean(input.isFavorite),
    isArchived,
    deleted: Boolean(input.deleted),
    addedByUserId: stringOr(input.addedByUserId, ""),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
    wordCount,
    readingTime: numberOr(input.readingTime, Math.max(1, Math.round(wordCount / 225))),
    category: normalizeCategory(input.category || "Other"),
    embedding: Array.isArray(input.embedding) ? input.embedding : Array.isArray(input.vec) ? input.vec : undefined,
    status: stringOr(input.status, "ready"),
    error: stringOr(input.error, ""),
    metadataSources: normalizeSources(input.metadataSources || input.sources),

    // Compatibility aliases used by the existing presentation layer.
    url: requestedUrl || finalUrl || canonicalUrl,
    source: sourceHost,
    author: stringOr(input.byline, input.author || "Unknown"),
    summary: excerpt,
    dateAdded: capturedAt,
    isRead: isArchived
  };
}

export function visibleArticles(articles = []) {
  return articles.filter(article => !article.deleted);
}

export function applyMutations(state, mutations = []) {
  let changed = false;
  for (const mutation of mutations) {
    changed = applyMutation(state, mutation) || changed;
  }
  return changed;
}

export function applyMutation(state, mutation) {
  if (!isMutationLike(mutation)) return false;
  observeHlc(state, mutation.timestamp);
  return applyArticleMutation(state, mutation);
}

export function createSyntheticMutation(entityType, entityId, field, value, state = {}) {
  return {
    id: createId(),
    entityType,
    entityId,
    field,
    value,
    timestamp: `${String(Date.now()).padStart(13, "0")}:0000:import`,
    authorId: value.addedByUserId || state.user?.id || "import",
    deviceId: "import"
  };
}

function applyArticleMutation(state, mutation) {
  state.articles ||= [];
  state.articleClocks ||= {};
  state.articleClocks[mutation.entityId] ||= {};
  const clocks = state.articleClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeArticleRecord({ ...mutation.value, id: mutation.entityId });
    let article = state.articles.find(candidate => candidate.id === mutation.entityId);
    if (!article) {
      state.articles.push(incoming);
      article = state.articles[state.articles.length - 1];
    }

    for (const field of ARTICLE_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        article[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    applyCompatibilityAliases(article);
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!ARTICLE_MUTATION_FIELDS.includes(field)) return false;

  let article = state.articles.find(candidate => candidate.id === mutation.entityId);
  if (!article) {
    article = normalizeArticleRecord({ id: mutation.entityId });
    state.articles.push(article);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  article[field] = coerceArticleField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  applyCompatibilityAliases(article);
  return true;
}

function coerceArticleField(field, value) {
  if (field === "deleted" || field === "isFavorite" || field === "isArchived") return Boolean(value);
  if (field === "tags") return normalizeTags(value);
  if (field === "notes") return String(value || "").slice(0, 20_000);
  if (field === "title") return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300) || "Untitled article";
  return value;
}

function applyCompatibilityAliases(article) {
  article.url = article.requestedUrl || article.finalUrl || article.canonicalUrl;
  article.source = article.sourceHost || article.siteName || hostFromUrl(article.url);
  article.author = article.byline || "Unknown";
  article.summary = article.excerpt || "";
  article.dateAdded = article.capturedAt;
  article.isRead = Boolean(article.isArchived);
}

function normalizeHeadings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === "string") return { level: 2, text: item.trim() };
      return {
        level: Math.min(6, Math.max(1, Number(item?.level) || 2)),
        text: String(item?.text || "").trim()
      };
    })
    .filter(item => item.text)
    .slice(0, 64);
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map(tag => String(tag || "").trim()).filter(Boolean).slice(0, 12)
    : [];
}

function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const sources = [];

  for (const item of value) {
    const url = stringOr(item?.url || item?.href || item?.uri, "");
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      title: stringOr(item?.title || hostFromUrl(key), hostFromUrl(key)).slice(0, 160),
      url: key
    });
    if (sources.length >= 5) break;
  }

  return sources;
}

function normalizeCategory(category) {
  const text = String(category || "").trim();
  if (!text) return "Other";
  return text.length <= 40 && !/[&/]/.test(text) ? text : "Other";
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function maxHlc(left, right) {
  if (!left) return right || "";
  if (!right) return left || "";
  return compareHlc(left, right) >= 0 ? left : right;
}

function isMutationLike(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    mutation.entityType === "article" &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function countWords(text) {
  return (String(text || "").match(/\S+/g) || []).length;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
