const STATE_STORAGE_KEY = "marginalia_v1";

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
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.articles)) {
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
      }
    }
  } catch {
    // Fall through to empty state.
  }

  return {
    articles: [],
    filter: "All",
    sortIndex: 0
  };
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      articles: state.articles,
      filter: state.filter,
      sortIndex: state.sortIndex
    }));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

export function loadSettings() {
  return {
    apiBaseUrl: getDefaultApiBaseUrl(),
    appToken: ""
  };
}

function normalizeStoredArticle(article) {
  return {
    ...article,
    id: String(article.id),
    source: article.source || article.siteName || hostFromUrl(article.url),
    siteName: article.siteName || article.source || hostFromUrl(article.url),
    tags: Array.isArray(article.tags) ? article.tags : [],
    category: normalizeCategory(article.category || "Other"),
    embedding: Array.isArray(article.embedding) ? article.embedding : article.vec,
    isRead: Boolean(article.isRead)
  };
}

function isLegacyTestArticle(article) {
  return String(article.id).startsWith("seed-") || LEGACY_TEST_URLS.has(article.url);
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
  if (!filter || filter === "All" || filter === "Saved") return "All";
  return normalizeCategory(filter);
}

function getDefaultApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8787";
  }

  return "";
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}
