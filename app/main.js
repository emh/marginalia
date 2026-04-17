import { ingestArticle } from "./api.js";
import { loadAppState, loadSettings, saveAppState } from "./storage.js";

const SORTS = [
  { key: "newest", label: "newest first" },
  { key: "oldest", label: "oldest first" },
  { key: "longest", label: "longest first" },
  { key: "shortest", label: "shortest first" },
  { key: "alpha", label: "a to z" }
];

const ADD_ARTICLE_STEPS = [
  "fetching article...",
  "cleaning article text...",
  "extracting metadata...",
  "summarizing...",
  "indexing..."
];

const state = {
  ...loadAppState(),
  search: "",
  currentArticle: null,
  pendingDeleteId: null,
  settings: loadSettings()
};

const $ = id => document.getElementById(id);

let isProcessing = false;
let toastTimer;

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function sourceFor(article) {
  return article.source || article.siteName || hostFromUrl(article.url);
}

function authorFor(article) {
  return article.author || "Unknown";
}

function formatDate(iso) {
  if (!iso) return "undated";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "undated";

  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = `${months[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

function isUrl(value) {
  const text = value.trim();
  if (text.includes(" ") || text.length < 4) return false;
  return /^https?:\/\//i.test(text) || /^[a-z0-9][-a-z0-9]*\.[a-z]{2,}/i.test(text);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "article";
  }
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

function save() {
  saveAppState(state);
}

function cosine(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const length = Math.min(a.length, b.length);
  if (!length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

function articleVector(article) {
  if (Array.isArray(article.embedding)) return article.embedding;
  if (Array.isArray(article.vec)) return article.vec;
  return semanticVector([article.category, article.summary, ...(article.tags || [])].join(" "));
}

function semanticVector(text) {
  const buckets = new Array(8).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9-]+/g) || [];
  for (const word of words) {
    const index = hashWord(word) % buckets.length;
    buckets[index] += 1;
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

function similar(article, count) {
  const target = articleVector(article);
  return state.articles
    .filter(candidate => candidate.id !== article.id)
    .map(candidate => ({ ...candidate, score: cosine(target, articleVector(candidate)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function similarUnread(article, count) {
  const target = articleVector(article);
  return state.articles
    .filter(candidate => candidate.id !== article.id && !candidate.isRead)
    .map(candidate => ({ ...candidate, score: cosine(target, articleVector(candidate)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function renderStats() {
  const total = state.articles.length;
  const read = state.articles.filter(article => article.isRead).length;
  const minutes = state.articles
    .filter(article => !article.isRead)
    .reduce((sum, article) => sum + (article.readingTime || 0), 0);
  const hours = Math.floor(minutes / 60);
  const remaining = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

  $("stats").textContent = `${total} articles - ${read} read - ${remaining} remaining`;
  $("progress-fill").style.width = total > 0 ? `${(read / total) * 100}%` : "0%";
}

function getCategories() {
  const categories = new Set(state.articles.map(article => article.category || "Other"));
  return ["All", ...Array.from(categories).sort()];
}

function renderCategories() {
  $("categories").innerHTML = getCategories().map(category =>
    `<span class="cat-item${state.filter === category ? " active" : ""}" data-cat="${esc(category)}">${esc(category)}</span>`
  ).join("");
}

function renderSort() {
  $("sort-btn").textContent = SORTS[state.sortIndex].label;
}

function getFiltered() {
  let articles = [...state.articles];

  if (state.filter !== "All") {
    articles = articles.filter(article => (article.category || "Other") === state.filter);
  }

  if (state.search) {
    const query = state.search.toLowerCase();
    articles = articles.filter(article =>
      article.title.toLowerCase().includes(query) ||
      authorFor(article).toLowerCase().includes(query) ||
      sourceFor(article).toLowerCase().includes(query) ||
      (article.summary || "").toLowerCase().includes(query) ||
      (article.tags || []).some(tag => tag.toLowerCase().includes(query))
    );
  }

  const sort = SORTS[state.sortIndex].key;
  switch (sort) {
    case "newest":
      articles.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
      break;
    case "oldest":
      articles.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      break;
    case "longest":
      articles.sort((a, b) => (b.readingTime || 0) - (a.readingTime || 0));
      break;
    case "shortest":
      articles.sort((a, b) => (a.readingTime || 0) - (b.readingTime || 0));
      break;
    case "alpha":
      articles.sort((a, b) => a.title.localeCompare(b.title));
      break;
  }

  return articles;
}

function renderArticles() {
  const articles = getFiltered();
  const container = $("article-list");
  const empty = $("empty-state");

  if (!articles.length) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  container.innerHTML = articles.map(article => `
    <article class="article-item${article.isRead ? " is-read" : ""}" data-id="${esc(article.id)}">
      <div class="article-meta">
        <span>${esc(sourceFor(article))} - ${article.readingTime || 1} min${article.status === "fetch_failed" ? " - metadata incomplete" : ""}</span>
        <span>${formatDate(article.dateAdded)}</span>
      </div>
      <h2 class="article-title">${esc(article.title)}</h2>
      <p class="article-summary">${esc(article.summary)}</p>
    </article>
  `).join("");
}

function renderDetail(article) {
  const related = similar(article, 3);
  $("detail-content").innerHTML = `
    <button class="back-btn" data-action="back" type="button">Back</button>

    <h1 class="detail-title">${esc(article.title)}</h1>
    <p class="detail-byline">${esc(authorFor(article))}</p>
    <p class="detail-pub">${esc(sourceFor(article))} - ${article.readingTime || 1} min read - ${formatDate(article.publishedAt || article.dateAdded)}</p>

    <p class="detail-summary">${esc(article.summary)}</p>
    ${article.status === "fetch_failed" ? `<p class="detail-summary">${esc("Metadata extraction failed. The original link is still in your library.")}</p>` : ""}
    <p class="detail-tags">${(article.tags || []).map(tag => esc(tag)).join(" - ")}</p>

    <hr class="detail-rule">

    <div class="section-label">Related</div>
    ${related.map(candidate => renderRelated(candidate)).join("")}

    <hr class="detail-rule">

    <div class="detail-actions">
      <button class="action-link" data-action="toggle-read" type="button">${article.isRead ? "Read" : "Mark as read"}</button>
      <a class="action-link muted" href="${esc(article.url)}" target="_blank" rel="noopener">Open</a>
      ${renderDeleteAction(article)}
    </div>

    ${article.isRead ? renderReadNext(article) : ""}
  `;
}

function renderRelated(article) {
  return `
    <div class="related-item" data-id="${esc(article.id)}">
      <span class="related-title">${esc(article.title)}</span>
      <span class="related-meta">${esc(authorFor(article))} - ${article.readingTime || 1} min</span>
    </div>
  `;
}

function renderDeleteAction(article) {
  if (state.pendingDeleteId !== article.id) {
    return `<button class="action-link muted danger" data-action="request-delete" type="button">Delete</button>`;
  }

  return `
    <span class="delete-confirm-label">Delete?</span>
    <button class="action-link danger" data-action="confirm-delete" type="button">Yes</button>
    <button class="action-link muted" data-action="cancel-delete" type="button">Cancel</button>
  `;
}

function renderReadNext(article) {
  const suggestions = similarUnread(article, 3);
  if (!suggestions.length) return "";
  return `
    <hr class="detail-rule">
    <div class="read-next-section">
      <div class="section-label">Read next</div>
      ${suggestions.map(candidate => renderRelated(candidate)).join("")}
    </div>
  `;
}

function showDetail(id) {
  const article = state.articles.find(candidate => candidate.id === id);
  if (!article) return;

  state.currentArticle = article;
  state.pendingDeleteId = null;
  renderDetail(article);
  $("detail-overlay").classList.add("active");
  $("detail-overlay").scrollTop = 0;
  document.body.classList.add("no-scroll");
}

function goBack() {
  if ($("detail-overlay").classList.contains("active")) {
    $("detail-overlay").classList.remove("active");
    document.body.classList.remove("no-scroll");
    state.pendingDeleteId = null;
    renderAll();
  }
}

function toggleRead(id) {
  const article = state.articles.find(candidate => candidate.id === id);
  if (!article) return;

  article.isRead = !article.isRead;
  if (article.isRead) article.dateRead = new Date().toISOString();
  else delete article.dateRead;

  save();
  renderDetail(article);
  renderStats();
  toast(article.isRead ? "Marked as read" : "Marked as unread");
}

function requestDeleteCurrentArticle() {
  if (!state.currentArticle) return;
  state.pendingDeleteId = state.currentArticle.id;
  renderDetail(state.currentArticle);
}

function cancelDeleteCurrentArticle() {
  if (!state.currentArticle) return;
  state.pendingDeleteId = null;
  renderDetail(state.currentArticle);
}

function deleteCurrentArticle() {
  if (!state.currentArticle) return;

  const articleId = state.currentArticle.id;
  const index = state.articles.findIndex(candidate => candidate.id === articleId);
  if (index < 0) return;

  state.articles.splice(index, 1);
  state.currentArticle = null;
  state.pendingDeleteId = null;
  save();

  $("detail-overlay").classList.remove("active");
  document.body.classList.remove("no-scroll");
  renderAll();
  toast("Article deleted");
}

async function addArticle(url) {
  if (isProcessing) return;
  isProcessing = true;
  let didAdd = false;

  const input = $("main-input");
  const status = $("input-status");
  const progress = $("input-progress");
  const stopStatus = startArticleStatus(status);

  input.value = "";
  input.disabled = true;
  status.classList.remove("is-error");
  progress.classList.add("running");

  try {
    const article = await ingestArticle(url, state.settings);
    stopStatus("saving...");
    upsertArticle(article);
    save();
    renderAll();
    didAdd = true;

    const newElement = document.querySelector(`[data-id="${CSS.escape(article.id)}"]`);
    newElement?.classList.add("animate-in");
    toast("Article added");
  } catch (error) {
    stopStatus();
    input.value = url;
    renderInputError(status, error);
    status.classList.add("is-error");
    toast("Could not add article");
  } finally {
    stopStatus();
    progress.classList.remove("running");
    if (didAdd) {
      status.textContent = "";
      status.classList.remove("is-error");
    }
    input.disabled = false;
    input.focus();
    isProcessing = false;
  }
}

function startArticleStatus(status) {
  let index = 0;
  let isStopped = false;
  status.textContent = ADD_ARTICLE_STEPS[index];

  const timer = setInterval(() => {
    index = (index + 1) % ADD_ARTICLE_STEPS.length;
    status.textContent = ADD_ARTICLE_STEPS[index];
  }, 2200);

  return finalMessage => {
    if (isStopped) return;
    isStopped = true;
    clearInterval(timer);
    if (finalMessage) status.textContent = finalMessage;
  };
}

function renderInputError(status, error) {
  const detail = error instanceof Error ? error.message : "Could not add article";
  const summary = summaryForError(detail);
  const expandedDetail = detailForError(detail);

  if (summary === detail) {
    status.textContent = detail;
    return;
  }

  status.innerHTML = `
    <button class="input-error-summary" type="button" aria-expanded="false">${esc(summary)}</button>
    <span class="input-error-detail" hidden>${esc(expandedDetail)}</span>
  `;
}

function summaryForError(message) {
  if (
    /^Article could not be extracted\b/i.test(message) ||
    /\binternal error;\s*reference\s*=/i.test(message)
  ) {
    return "Article could not be extracted";
  }

  return message;
}

function detailForError(message) {
  return message
    .replace(/^Article could not be extracted:\s*/i, "")
    .trim();
}

function upsertArticle(article) {
  const existingIndex = state.articles.findIndex(candidate =>
    candidate.canonicalUrl === article.canonicalUrl || candidate.url === article.url
  );

  if (existingIndex >= 0) {
    const existing = state.articles[existingIndex];
    state.articles[existingIndex] = {
      ...existing,
      ...article,
      id: existing.id,
      dateAdded: existing.dateAdded,
      isRead: existing.isRead
    };
    return;
  }

  state.articles.unshift(article);
}

function renderAll() {
  renderStats();
  renderCategories();
  renderSort();
  renderArticles();
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");

  status.addEventListener("click", event => {
    const toggle = event.target.closest(".input-error-summary");
    if (!toggle) return;

    const detail = status.querySelector(".input-error-detail");
    if (!detail) return;

    const isExpanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!isExpanded));
    detail.hidden = isExpanded;
  });

  input.addEventListener("input", () => {
    const value = input.value.trim();
    if (isUrl(value)) {
      status.textContent = "Enter to add article";
      status.classList.remove("is-error");
      state.search = "";
    } else {
      status.textContent = "";
      status.classList.remove("is-error");
      state.search = value;
    }
    renderArticles();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      const value = input.value.trim();
      if (isUrl(value)) {
        event.preventDefault();
        addArticle(value);
      }
    }

    if (event.key === "Escape") {
      input.value = "";
      state.search = "";
      status.textContent = "";
      status.classList.remove("is-error");
      renderArticles();
      input.blur();
    }
  });

  $("categories").addEventListener("click", event => {
    const category = event.target.closest(".cat-item");
    if (!category) return;
    state.filter = category.dataset.cat;
    save();
    renderCategories();
    renderArticles();
  });

  $("sort-btn").addEventListener("click", () => {
    state.sortIndex = (state.sortIndex + 1) % SORTS.length;
    save();
    renderSort();
    renderArticles();
  });

  $("article-list").addEventListener("click", event => {
    const item = event.target.closest(".article-item");
    if (item) showDetail(item.dataset.id);
  });

  $("detail-content").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "back") return goBack();
      if (action.dataset.action === "toggle-read") return toggleRead(state.currentArticle.id);
      if (action.dataset.action === "request-delete") return requestDeleteCurrentArticle();
      if (action.dataset.action === "confirm-delete") return deleteCurrentArticle();
      if (action.dataset.action === "cancel-delete") return cancelDeleteCurrentArticle();
    }

    const related = event.target.closest(".related-item");
    if (!related) return;
    const article = state.articles.find(candidate => candidate.id === related.dataset.id);
    if (!article) return;
    state.currentArticle = article;
    state.pendingDeleteId = null;
    renderDetail(article);
    $("detail-overlay").scrollTop = 0;
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("detail-overlay").classList.contains("active")) {
      goBack();
    }
  });
}

function init() {
  renderAll();
  bindEvents();
  registerServiceWorker();
  watchForAppUpdates();
}

init();

function isLocalHost() {
  const host = globalThis.location?.hostname || "";
  return host === "localhost" || host === "127.0.0.1";
}

function shouldUseServiceWorker() {
  return "serviceWorker" in navigator && globalThis.location?.protocol === "https:" && !isLocalHost();
}

function registerServiceWorker() {
  if (!shouldUseServiceWorker()) return;

  let isReloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isReloadingForServiceWorker) return;
    isReloadingForServiceWorker = true;
    globalThis.location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then(registration => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      setInterval(() => {
        registration.update().catch(() => {});
      }, 60_000);
    })
    .catch(() => {});
}

function watchForAppUpdates() {
  if (isLocalHost()) return;

  let didReload = false;
  const currentBuildId = globalThis.MARGINALIA_BUILD_ID || "";

  async function checkVersion() {
    if (didReload || !currentBuildId) return;

    try {
      const versionUrl = new URL("./version.js", globalThis.location.href);
      versionUrl.searchParams.set("t", Date.now().toString());
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (!response.ok) return;

      const nextBuildId = parseBuildId(await response.text());
      if (!nextBuildId || nextBuildId === currentBuildId) return;

      didReload = true;
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.().catch(() => {});
      globalThis.location.reload();
    } catch {
      // Stay on the current version if the version check is unavailable.
    }
  }

  setInterval(checkVersion, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkVersion();
  });
}

function parseBuildId(scriptText) {
  return scriptText.match(/MARGINALIA_BUILD_ID\s*=\s*["']([^"']+)["']/)?.[1] || "";
}
