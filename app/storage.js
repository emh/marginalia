import {
  applyMutation,
  createDeviceId,
  createMutation,
  createUser,
  normalizeArticleRecord,
  normalizeUser
} from "./model.js";

export const STATE_STORAGE_KEY = "marginalia_v2";
export const LEGACY_STORAGE_KEY = "marginalia_v1";
export const SCHEMA_VERSION = 1;

const LEGACY_TEST_URLS = new Set([
  "https://www.incompleteideas.net/IncIdeas/BitterLesson.html",
  "https://www.dartmouth.edu/~matc/MathDrama/reading/Wigner.html",
  "https://frankchimero.com/blog/2015/the-webs-grain/",
  "https://mcfunley.com/choose-boring-technology",
  "https://www.orwell.ru/library/essays/politics/english/e_polit",
  "https://fee.org/resources/i-pencil/",
  "https://www.philosopher.eu/nagel-what-is-it-like-to-be-a-bat/",
  "https://dreamsongs.com/RiseOfWorseIsBetter.html",
  "https://alistapart.com/article/a-dao-of-web-design/",
  "https://www.newyorker.com/magazine/the-end-of-the-english-major",
  "https://www.ncbi.nlm.nih.gov/pmc/articles/sleep-cognition/",
  "https://aeon.co/essays/the-merits-and-perils-of-metaphor-in-science",
  "https://www.ribbonfarm.com/a-big-little-idea-called-legibility/"
]);

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

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) return normalizeStoredState(JSON.parse(raw));
  } catch {
    // Fall through to first-run state.
  }

  const state = {
    ...createInitialState(),
    pendingLegacy: loadLegacyState()
  };
  migrateLegacyForUser(state);
  return state;
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    user: createUser(),
    hlc: { wallTime: 0, counter: 0 },
    articles: [],
    articleClocks: {},
    sync: createSyncState(),
    ui: {
      filter: "All",
      sortIndex: 0,
      searchQuery: ""
    },
    filter: "All",
    sortIndex: 0
  };
}

export function normalizeStoredState(data = {}) {
  const ui = normalizeUiState(data.ui || data);
  const state = {
    ...createInitialState(),
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof data.deviceId === "string" && data.deviceId ? data.deviceId : createDeviceId(),
    user: normalizeUser(data.user) || createUser(),
    hlc: normalizeClock(data.hlc),
    articles: Array.isArray(data.articles)
      ? data.articles.map(normalizeStoredArticle).filter(article => !isLegacyTestArticle(article))
      : [],
    articleClocks: plainObject(data.articleClocks),
    sync: normalizeSyncState(data.sync),
    ui,
    filter: ui.filter,
    sortIndex: ui.sortIndex
  };

  reconcileFilters(state);
  return state;
}

export function migrateLegacyForUser(state) {
  state.user = normalizeUser(state.user) || createUser();
  state.sync = normalizeSyncState(state.sync);

  const legacy = state.pendingLegacy;
  if (!legacy) {
    delete state.pendingLegacy;
    return state;
  }

  state.filter = legacy.filter || "All";
  state.sortIndex = Number.isInteger(legacy.sortIndex) ? legacy.sortIndex : 0;
  state.ui = normalizeUiState({ filter: state.filter, sortIndex: state.sortIndex });
  state.articles = [];
  state.articleClocks = {};

  for (const legacyArticle of legacy.articles || []) {
    const article = normalizeArticleRecord({
      ...legacyArticle,
      addedByUserId: state.user.id
    });
    const mutation = createMutation(state, "article", article.id, "_create", article);
    applyMutation(state, mutation);
    state.sync.mutationQueue.push(mutation);
  }

  delete state.pendingLegacy;
  reconcileFilters(state);
  return state;
}

export function loadSettings() {
  return {
    apiBaseUrl: getConfiguredApiBaseUrl() || getDefaultArticleApiBaseUrl(),
    syncBaseUrl: getConfiguredSyncBaseUrl() || getDefaultSyncBaseUrl(),
    appToken: ""
  };
}

function serializeState(state) {
  const ui = normalizeUiState({
    ...state.ui,
    filter: state.filter,
    sortIndex: state.sortIndex,
    searchQuery: state.search || state.ui?.searchQuery || ""
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: state.deviceId,
    user: normalizeUser(state.user) || createUser(),
    hlc: normalizeClock(state.hlc),
    articles: state.articles || [],
    articleClocks: state.articleClocks || {},
    sync: normalizeSyncState(state.sync),
    ui
  };
}

function loadLegacyState() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.articles)) return null;
    const articles = data.articles
      .map(normalizeStoredArticle)
      .filter(article => !isLegacyTestArticle(article));
    let filter = normalizeStoredFilter(data.filter);
    if (filter !== "All" && !articles.some(article => article.category === filter)) {
      filter = "All";
    }

    return {
      articles,
      filter,
      sortIndex: Number.isInteger(data.sortIndex) ? data.sortIndex : 0
    };
  } catch {
    return null;
  }
}

function normalizeStoredArticle(article) {
  return normalizeArticleRecord({
    ...article,
    sourceHost: article.sourceHost || article.source || article.siteName || hostFromUrl(article.url),
    siteName: article.siteName || article.source || hostFromUrl(article.url),
    category: normalizeCategory(article.category || "Other"),
    embedding: Array.isArray(article.embedding) ? article.embedding : article.vec,
    isArchived: article.isArchived == null ? article.isRead : article.isArchived
  });
}

function isLegacyTestArticle(article) {
  return String(article.id).startsWith("seed-") || LEGACY_TEST_URLS.has(article.url || article.requestedUrl);
}

function normalizeCategory(category) {
  const text = String(category || "").trim();
  if (!text) return "Other";

  for (const [label, matcher] of BROAD_CATEGORY_MATCHERS) {
    if (matcher.test(text)) return label;
  }

  return text.length <= 18 && !/[&/]/.test(text) ? text : "Other";
}

function normalizeStoredFilter(filter) {
  if (!filter || /^all$/i.test(filter) || filter === "Saved") return "All";
  return normalizeCategory(filter);
}

function normalizeUiState(input = {}) {
  return {
    filter: normalizeStoredFilter(input.filter),
    sortIndex: Number.isInteger(input.sortIndex) ? input.sortIndex : 0,
    searchQuery: typeof input.searchQuery === "string" ? input.searchQuery : ""
  };
}

function createSyncState(input = {}) {
  return {
    mutationQueue: Array.isArray(input.mutationQueue) ? input.mutationQueue.filter(isQueuedMutation) : [],
    lastSyncTimestamp: typeof input.lastSyncTimestamp === "string" ? input.lastSyncTimestamp : ""
  };
}

function normalizeSyncState(input = {}) {
  return createSyncState(input);
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reconcileFilters(state) {
  const articles = (state.articles || []).filter(article => !article.deleted);
  if (state.filter !== "All" && !articles.some(article => article.category === state.filter)) {
    state.filter = "All";
    state.ui.filter = "All";
  }
}

function getDefaultArticleApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8787";
  }

  return "";
}

function getDefaultSyncBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8789";
  }

  return "";
}

function getConfiguredApiBaseUrl() {
  const value = globalThis.MARGINALIA_CONFIG?.apiBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function getConfiguredSyncBaseUrl() {
  const value = globalThis.MARGINALIA_CONFIG?.syncBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function isQueuedMutation(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    typeof mutation.entityType === "string" &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}
