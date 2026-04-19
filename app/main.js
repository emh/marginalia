import { captureArticle, ingestArticle } from "./api.js";
import {
  applyMutation,
  applyMutations,
  createMutation,
  createSyntheticMutation,
  normalizeArticleRecord,
  normalizeCode,
  visibleArticles
} from "./model.js";
import { loadAppState, loadSettings, saveAppState } from "./storage.js";
import {
  MarginaliaSync,
  createRemoteArticleShare,
  createRemoteLibrary,
  fetchRemoteArticleShare,
  fetchRemoteLibrary
} from "./sync.js";

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
const SCREEN_EXIT_MS = 280;
const EXTENSION_PROMPT_DELAY_MS = 1800;
const EXTENSION_PROMPT_DURATION_MS = 6000;

const loadedState = loadAppState();
const state = {
  ...loadedState,
  search: "",
  currentArticle: null,
  pendingDeleteId: null,
  isReadingArticle: false,
  overlayStack: [],
  setupScreen: null,
  setupPayload: null,
  syncStatus: "idle",
  settings: loadSettings()
};

const $ = id => document.getElementById(id);

let isProcessing = false;
let toastTimer;
let librarySync = null;
let renderedSetupKey = "";
let screenTransitionToken = 0;
const processedCaptureIds = new Set();
let captureExtensionInstalled = false;
let extensionPromptTimer;

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

function toast(message, options = {}) {
  const el = $("toast");
  el.textContent = "";
  el.classList.toggle("has-action", Boolean(options.href));

  if (options.href) {
    const link = document.createElement("a");
    link.className = "toast-link";
    link.href = options.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = message;
    el.append(link);
  } else {
    el.textContent = message;
  }

  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("visible");
    el.classList.remove("has-action");
  }, options.duration || 2000);
}

function save() {
  saveAppState(state);
}

function hasUser() {
  return Boolean(state.user?.id);
}

function getArticles(options = {}) {
  return options.includeDeleted ? state.articles : visibleArticles(state.articles);
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
  return getArticles()
    .filter(candidate => candidate.id !== article.id)
    .map(candidate => ({ ...candidate, score: cosine(target, articleVector(candidate)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function similarUnread(article, count) {
  const target = articleVector(article);
  return getArticles()
    .filter(candidate => candidate.id !== article.id && !candidate.isArchived)
    .map(candidate => ({ ...candidate, score: cosine(target, articleVector(candidate)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function renderStats() {
  const articles = getArticles();
  const total = articles.length;
  const read = articles.filter(article => article.isArchived).length;
  const minutes = articles
    .filter(article => !article.isArchived)
    .reduce((sum, article) => sum + (article.readingTime || 0), 0);
  const hours = Math.floor(minutes / 60);
  const remaining = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

  $("stats").textContent = `${total} articles - ${read} read - ${remaining} remaining`;
  $("progress-fill").style.width = total > 0 ? `${(read / total) * 100}%` : "0%";
}

function getCategories() {
  const categories = new Set(getArticles().map(article => article.category || "Other"));
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
  let articles = [...getArticles()];

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
      (article.textContent || "").toLowerCase().includes(query) ||
      (article.contentMarkdown || "").toLowerCase().includes(query) ||
      (article.notes || "").toLowerCase().includes(query) ||
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
    <article class="article-item${article.isArchived ? " is-read" : ""}" data-id="${esc(article.id)}">
      <div class="article-meta">
        <span>${esc(sourceFor(article))} - ${article.readingTime || 1} min${statusLabel(article)}</span>
        <span>${formatDate(article.dateAdded)}</span>
      </div>
      <h2 class="article-title">${esc(article.title)}</h2>
      <p class="article-summary">${esc(article.summary)}</p>
    </article>
  `).join("");
}

function renderDetail(article) {
  const container = $("detail-content");
  container.className = "overlay-screen";
  container.hidden = false;

  if (state.isReadingArticle) {
    container.innerHTML = articleReaderHtml(article);
    return;
  }

  container.innerHTML = articleDetailHtml(article);
}

function articleDetailHtml(article) {
  const related = similar(article, 3);
  return `
    ${overlayHeaderHtml("back")}

    <div class="overlay-content has-fixed-header has-fixed-footer">
      <h1 class="detail-title">${esc(article.title)}</h1>
      <p class="detail-byline">${esc(authorFor(article))}</p>
      <p class="detail-pub">${esc(sourceFor(article))} - ${article.readingTime || 1} min read - ${formatDate(article.publishedAt || article.dateAdded)}</p>

      <p class="detail-summary">${esc(article.summary)}</p>
      ${renderArticleNotice(article)}
      ${renderMetadataSources(article)}
      <p class="detail-tags">${(article.tags || []).map(tag => esc(tag)).join(" - ")}</p>

      <hr class="detail-rule">

      <div class="section-label">Related</div>
      ${related.map(candidate => renderRelated(candidate)).join("")}

      ${article.isArchived ? renderReadNext(article) : ""}
    </div>

    ${overlayFooterHtml(`
      <div class="detail-actions${state.pendingDeleteId === article.id ? " is-confirming-delete" : ""}">
        ${renderReadArticleAction(article)}
        <a class="action-link muted" href="${esc(article.finalUrl || article.canonicalUrl || article.url)}" target="_blank" rel="noopener">Open</a>
        <button class="action-link" data-action="share-article" type="button">Share</button>
        <button class="action-link" data-action="toggle-read" type="button">${article.isArchived ? "Mark unread" : "Mark as read"}</button>
        ${renderDeleteAction(article)}
      </div>
    `)}
  `;
}

function overlayHeaderHtml(action) {
  return `
    <div class="overlay-fixed-header">
      <div class="overlay-fixed-inner">
        <button class="back-btn" data-action="${esc(action)}" type="button">Back</button>
      </div>
    </div>
  `;
}

function overlayFooterHtml(content) {
  return `
    <div class="overlay-fixed-footer">
      <div class="overlay-fixed-inner">
        ${content}
      </div>
    </div>
  `;
}

function statusLabel(article) {
  if (article.status === "fetch_failed" || hasMetadataError(article)) return " - metadata incomplete";
  return "";
}

function renderArticleNotice(article) {
  if (article.status === "fetch_failed") {
    return `<p class="detail-summary">${esc("Metadata extraction failed. The original link is still in your library.")}</p>`;
  }

  if (article.status === "metadata_only") {
    return `<p class="detail-summary muted-copy">${esc("The article body could not be extracted. Metadata was filled from search when available.")}</p>`;
  }

  if (hasMetadataError(article)) {
    return `<p class="detail-summary">${esc("Metadata enrichment failed. The article text was saved with fallback details.")}</p>`;
  }

  return "";
}

function renderMetadataSources(article) {
  const sources = Array.isArray(article.metadataSources) ? article.metadataSources.slice(0, 5) : [];
  if (!sources.length) return "";
  return `
    <p class="detail-sources">
      Sources:
      ${sources.map(source => `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title || source.url)}</a>`).join(" - ")}
    </p>
  `;
}

function hasMetadataError(article) {
  if (hasArticleBody(article)) return false;
  return article.status === "metadata_failed" || /\bmetadata unavailable\b|\bmetadata worker failed\b/i.test(article.error || "");
}

function renderReadArticleAction(article) {
  if (!hasArticleBody(article)) return "";
  return `<button class="action-link" data-action="read-article" type="button">Read</button>`;
}

function hasArticleBody(article) {
  return Boolean(String(article.contentMarkdown || article.textContent || "").trim());
}

function articleReaderHtml(article) {
  return `
    ${overlayHeaderHtml("back-to-detail")}

    <div class="overlay-content has-fixed-header">
      <h1 class="detail-title reader-title">${esc(article.title)}</h1>
      ${renderArticleBody(article)}
    </div>
  `;
}

function renderArticleBody(article) {
  const markdown = String(article.contentMarkdown || article.textContent || "").trim();
  if (!markdown) {
    return `<p class="detail-summary">No readable text was extracted.</p>`;
  }

  const blocks = markdown
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);

  if (!blocks.length) return "";

  return `
    <div class="article-body">
      ${blocks.map(renderMarkdownBlock).join("")}
    </div>
  `;
}

function renderMarkdownBlock(block) {
  const heading = block.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = Math.min(4, Math.max(2, heading[1].length + 1));
    return `<h${level}>${esc(heading[2])}</h${level}>`;
  }

  if (/^[-*]\s+/m.test(block)) {
    const items = block
      .split(/\n/)
      .map(line => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .map(item => `<li>${esc(stripMarkdown(item))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (/^>\s+/m.test(block)) {
    return `<blockquote>${esc(stripMarkdown(block.replace(/^>\s+/gm, "")))}</blockquote>`;
  }

  return `<p>${esc(stripMarkdown(block))}</p>`;
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    <span class="delete-confirm-wrap">
      <span class="delete-confirm-label">Delete?</span>
      <span class="delete-confirm-menu">
        <button class="action-link danger" data-action="confirm-delete" type="button">Yes</button>
        <button class="action-link muted" data-action="cancel-delete" type="button">Cancel</button>
      </span>
    </span>
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
  if (!getArticles().some(candidate => candidate.id === id)) return;
  openOverlayScreen({ type: "article-detail", articleId: id }, { reset: true });
}

function goBack() {
  if (!$("detail-overlay").classList.contains("active")) return;
  popOverlayScreen();
}

function showArticleReader() {
  if (!state.currentArticle || !hasArticleBody(state.currentArticle)) return;
  openOverlayScreen({ type: "article-reader", articleId: state.currentArticle.id });
}

function backToArticleDetail() {
  goBack();
}

function currentOverlayScreen() {
  return state.overlayStack[state.overlayStack.length - 1] || null;
}

function isSameOverlayScreen(left, right) {
  return Boolean(
    left &&
    right &&
    left.type === right.type &&
    (left.articleId || "") === (right.articleId || "")
  );
}

function overlayScreenHtml(screen) {
  if (!screen) return "";

  if (screen.type === "article-detail" || screen.type === "article-reader") {
    const article = getArticles().find(candidate => candidate.id === screen.articleId);
    if (!article) return missingArticleHtml();
    return screen.type === "article-reader" ? articleReaderHtml(article) : articleDetailHtml(article);
  }

  return missingArticleHtml();
}

function renderOverlayScreen(screen = currentOverlayScreen()) {
  const container = $("detail-content");
  if (!screen) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  if (screen.type === "article-detail" || screen.type === "article-reader") {
    const article = getArticles().find(candidate => candidate.id === screen.articleId);
    if (!article) {
      container.className = "overlay-screen";
      container.hidden = false;
      container.innerHTML = missingArticleHtml();
      state.currentArticle = null;
      state.isReadingArticle = false;
      return;
    }

    state.currentArticle = article;
    state.isReadingArticle = screen.type === "article-reader";
    renderDetail(article);
    return;
  }

  state.currentArticle = null;
  state.isReadingArticle = false;
  container.className = "overlay-screen";
  container.hidden = false;
  container.innerHTML = missingArticleHtml();
}

function openOverlayScreen(screen, options = {}) {
  const overlay = $("detail-overlay");
  const container = $("detail-content");
  const direction = options.direction || "forward";
  const wasActive = overlay.classList.contains("active") && !overlay.classList.contains("is-screen-transitioning");
  const current = currentOverlayScreen();

  if (options.reset) {
    state.overlayStack = [screen];
  } else if (options.replace && state.overlayStack.length) {
    state.overlayStack[state.overlayStack.length - 1] = screen;
  } else if (!isSameOverlayScreen(current, screen)) {
    state.overlayStack.push(screen);
  }

  state.pendingDeleteId = null;

  if (wasActive && container.innerHTML.trim()) {
    transitionDetailContent(overlayScreenHtml(screen), () => renderOverlayScreen(), direction);
  } else {
    renderOverlayScreen();
    overlay.classList.add("active");
    overlay.scrollTop = 0;
    document.body.classList.add("no-scroll");
  }
}

function replaceOverlayScreen(screen, direction = "forward") {
  openOverlayScreen(screen, { replace: true, direction });
}

function popOverlayScreen(direction = "back") {
  if (state.overlayStack.length <= 1) {
    closeDetailOverlay();
    return;
  }

  state.overlayStack.pop();
  state.pendingDeleteId = null;
  const next = currentOverlayScreen();
  transitionDetailContent(overlayScreenHtml(next), () => renderOverlayScreen(), direction);
}

function transitionDetailContent(nextHtml, commit, direction = "forward") {
  const container = $("detail-content");
  const overlay = $("detail-overlay");
  const token = ++screenTransitionToken;
  const isBack = direction === "back";
  const scrollTop = overlay.scrollTop;
  const currentHtml = container.innerHTML;

  const stage = document.createElement("div");
  stage.className = `screen-transition ${isBack ? "is-back" : "is-forward"}`;
  stage.innerHTML = `
    <div class="screen-pane screen-pane-current">
      ${currentHtml}
    </div>
    <div class="screen-pane screen-pane-next">
      ${nextHtml}
    </div>
  `;

  overlay.classList.add("is-screen-transitioning");
  container.hidden = true;
  overlay.append(stage);
  stage.querySelector(".screen-pane-current").scrollTop = scrollTop;

  setTimeout(() => {
    if (token !== screenTransitionToken) return;

    commit();
    overlay.scrollTop = 0;
    overlay.classList.remove("is-screen-transitioning");
    stage.remove();
  }, SCREEN_EXIT_MS);
}

function missingArticleHtml(message = "Article not found.") {
  return `
    ${overlayHeaderHtml("back")}
    <div class="overlay-content has-fixed-header">
      <p class="detail-summary muted-copy">${esc(message)}</p>
    </div>
  `;
}

function showArticleInOverlay(articleId, direction = "forward") {
  if (!getArticles().some(candidate => candidate.id === articleId)) return;
  openOverlayScreen({ type: "article-detail", articleId }, { direction });
}

function closeDetailOverlay() {
  $("detail-overlay").classList.remove("active");
  document.body.classList.remove("no-scroll");
  state.overlayStack = [];
  state.pendingDeleteId = null;
  state.isReadingArticle = false;
  state.currentArticle = null;
  renderAll();
}

async function shareCurrentArticle() {
  const article = state.currentArticle;
  if (!article) return;
  const payload = await createRemoteArticleShare({
    user: state.user,
    article
  }, state.settings);
  const code = normalizeCode(payload.code || payload.room?.code);
  if (!code) throw new Error("Article share code missing");
  state.setupScreen = "article-share";
  state.setupPayload = { code, articleId: article.id };
  renderAll();
}

function toggleRead(id) {
  const article = getArticles().find(candidate => candidate.id === id);
  if (!article) return;

  const nextArchived = !article.isArchived;
  commitChanges([{
    entityType: "article",
    entityId: article.id,
    field: "isArchived",
    value: nextArchived
  }], nextArchived ? "Marked as read" : "Marked as unread");
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
  if (!getArticles().some(candidate => candidate.id === articleId)) return;

  commitChanges([{
    entityType: "article",
    entityId: articleId,
    field: "deleted",
    value: true
  }]);
  state.currentArticle = null;
  state.pendingDeleteId = null;
  state.isReadingArticle = false;
  closeDetailOverlay();
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
    const result = upsertArticle(article);
    const savedArticle = result.article;
    didAdd = true;

    const newElement = document.querySelector(`[data-id="${CSS.escape(savedArticle.id)}"]`);
    if (result.added) newElement?.classList.add("animate-in");
    toast(result.added ? "Article added" : "Article already saved");
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

async function addCapturedArticle(payload, captureId = "") {
  const id = String(captureId || "");
  if (id && processedCaptureIds.has(id)) return;
  if (isProcessing) return;

  isProcessing = true;
  if (id) processedCaptureIds.add(id);
  let didSave = false;

  const input = $("main-input");
  const status = $("input-status");
  const progress = $("input-progress");
  const stopStatus = startArticleStatus(status);

  input.disabled = true;
  status.classList.remove("is-error");
  progress.classList.add("running");

  try {
    const article = await captureArticle(payload, state.settings);
    stopStatus("saving...");
    const result = upsertArticle(article);
    didSave = true;

    stripLinkQuery();
    renderAll();
    showDetail(result.article.id);
    toast(result.added ? "Article added" : "Article already saved");
    postCaptureResult("marginalia:capture:ack", id);
  } catch (error) {
    stopStatus();
    renderInputError(status, error);
    status.classList.add("is-error");
    toast("Could not add article");
    if (id) processedCaptureIds.delete(id);
    postCaptureResult("marginalia:capture:error", id, error);
  } finally {
    stopStatus();
    progress.classList.remove("running");
    if (didSave) {
      status.textContent = "";
      status.classList.remove("is-error");
    }
    input.disabled = false;
    isProcessing = false;
  }
}

function postCaptureResult(type, id, error) {
  if (!id) return;
  globalThis.postMessage({
    type,
    id,
    error: error instanceof Error ? error.message : error ? String(error) : ""
  }, globalThis.location.origin);
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
    status.innerHTML = `
      <span class="input-error-detail">${esc(expandedDetail || detail)}</span>
    `;
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
  const existing = getArticles({ includeDeleted: true }).find(candidate =>
    sameArticle(candidate, article)
  );

  if (existing && !existing.deleted) {
    renderAll();
    return { article: existing, added: false };
  }

  const next = normalizeArticleRecord({
    ...article,
    id: existing?.id || article.id,
    addedByUserId: state.user.id,
    deleted: false
  });
  commitChanges([{ entityType: "article", entityId: next.id, field: "_create", value: next }]);
  return {
    article: getArticles({ includeDeleted: true }).find(candidate => candidate.id === next.id) || next,
    added: true
  };
}

function sameArticle(left, right) {
  const leftUrls = articleUrlKeys(left);
  return Array.from(articleUrlKeys(right)).some(url => leftUrls.has(url));
}

function articleUrlKeys(article) {
  return new Set([
    article.requestedUrl,
    article.finalUrl,
    article.canonicalUrl,
    article.url
  ].filter(Boolean));
}

function commitChanges(changes, message) {
  const mutations = changes.map(change => createMutation(state, change.entityType, change.entityId, change.field, change.value));
  for (const mutation of mutations) {
    applyMutation(state, mutation);
    state.sync.mutationQueue.push(mutation);
  }

  save();
  flushSync();
  renderAll();
  refreshCurrentArticle();
  if (message) toast(message);
  return mutations;
}

function flushSync() {
  librarySync?.flush();
}

function refreshCurrentArticle() {
  const screen = currentOverlayScreen();
  if (
    !$("detail-overlay").classList.contains("active") ||
    !screen ||
    (screen.type !== "article-detail" && screen.type !== "article-reader")
  ) {
    return;
  }

  renderOverlayScreen(screen);
}

function renderAll() {
  renderSetupScreen();
  renderSyncIndicator();
  if (!hasUser()) return;
  renderStats();
  renderCategories();
  renderSort();
  renderArticles();
  if (currentOverlayScreen() && $("detail-overlay").classList.contains("active") && !$("detail-overlay").classList.contains("is-screen-transitioning")) {
    renderOverlayScreen();
  }
}

function renderSetupScreen() {
  const screen = $("setup-screen");
  const content = $("setup-content");
  if (!screen || !content) return;

  const active = Boolean(state.setupScreen);
  screen.classList.toggle("active", active);
  document.body.classList.toggle("no-scroll", active || $("detail-overlay").classList.contains("active"));
  if (!active) {
    renderedSetupKey = "";
    return;
  }

  if (state.setupScreen === "library-share") {
    const code = state.setupPayload?.code || state.user.profileCode;
    const url = libraryLink(code);
    setSetupContent(`
      <button class="back-btn" data-action="close-setup" type="button">back</button>
      <h1>link library</h1>
      <p class="setup-copy">Open this on another device.</p>
      <input class="share-field" id="library-share-url" value="${esc(url)}" readonly>
      <div class="setup-code" id="library-share-code">${esc(code)}</div>
      <div class="detail-actions">
        <button class="action-link" data-action="share-library-url" type="button">share url</button>
        <button class="action-link" data-action="copy-library-url" type="button">copy url</button>
        <button class="action-link muted" data-action="copy-library-code" type="button">copy code</button>
      </div>
    `, `library-share:${code}`);
    return;
  }

  if (state.setupScreen === "article-share") {
    const code = state.setupPayload?.code || "";
    const article = getArticles({ includeDeleted: true }).find(candidate => candidate.id === state.setupPayload?.articleId);
    const url = articleShareLink(code);
    setSetupContent(`
      <button class="back-btn" data-action="close-setup" type="button">back</button>
      <h1>${esc(article?.title || "share article")}</h1>
      <p class="setup-copy">Send this link to share the article.</p>
      <input class="share-field" id="article-share-url" value="${esc(url)}" readonly>
      <div class="setup-code" id="article-share-code">${esc(code)}</div>
      <div class="detail-actions">
        <button class="action-link" data-action="share-article-url" type="button">share url</button>
        <button class="action-link" data-action="copy-article-url" type="button">copy url</button>
        <button class="action-link muted" data-action="copy-article-code" type="button">copy code</button>
      </div>
    `, `article-share:${code}`);
    return;
  }
}

function setSetupContent(html, key, afterRender) {
  const content = $("setup-content");
  if (!content) return;
  const changed = renderedSetupKey !== key;
  if (changed) {
    content.innerHTML = html;
    renderedSetupKey = key;
    content.classList.remove("screen-enter");
    requestAnimationFrame(() => content.classList.add("screen-enter"));
  }
  if (afterRender) requestAnimationFrame(afterRender);
}

async function showLibraryLink() {
  const code = await ensureLibraryCode();
  state.setupScreen = "library-share";
  state.setupPayload = { code };
  renderAll();
}

async function ensureLibraryCode() {
  if (state.user?.profileCode) return state.user.profileCode;
  const payload = await createRemoteLibrary({
    user: state.user,
    mutations: state.sync.mutationQueue
  }, state.settings);
  applyRemotePayload(payload);
  state.user.profileCode = payload.code;
  if (Array.isArray(payload.confirmedIds)) {
    const confirmed = new Set(payload.confirmedIds);
    state.sync.mutationQueue = state.sync.mutationQueue.filter(mutation => !confirmed.has(mutation.id));
  }
  save();
  configureSync();
  return state.user.profileCode;
}

async function linkLibrary(code) {
  const payload = await fetchRemoteLibrary(code, state.settings);
  applyRemotePayload(payload);
  state.user = {
    ...payload.user,
    profileCode: payload.code
  };
  state.sync.mutationQueue = [];
  state.sync.lastSyncTimestamp = payload.highWatermark || "";
  stripLinkQuery();
  save();
  configureSync();
  state.setupScreen = null;
  state.setupPayload = null;
  renderAll();
  toast("Library linked");
}

async function openSharedArticle(code) {
  const payload = await fetchRemoteArticleShare(code, state.settings);
  const article = payload.articles?.[0] || payload.article;
  if (!article) throw new Error("Shared article not found");

  const result = upsertArticle(article);
  stripLinkQuery();
  save();
  renderAll();
  showDetail(result.article.id);
  toast(result.added ? "Article added" : "Article already saved");
}

function applyRemotePayload(payload) {
  if (payload?.user) {
    state.user = {
      ...payload.user,
      profileCode: payload.user.profileCode || payload.code || state.user?.profileCode || ""
    };
  }

  if (Array.isArray(payload?.mutations)) {
    applyMutations(state, payload.mutations);
  } else {
    mergeMaterializedPayload(payload);
  }

  if (payload?.highWatermark) {
    if (!payload.room || payload.room.type === "library") {
      state.sync.lastSyncTimestamp = payload.highWatermark;
    }
  }
}

function mergeMaterializedPayload(payload = {}) {
  const synthetic = [];
  for (const article of payload.articles || []) {
    synthetic.push(createSyntheticMutation("article", article.id, "_create", article, state));
  }
  applyMutations(state, synthetic);
}

function libraryLink(code) {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("library", code);
  return url.toString();
}

function articleShareLink(code) {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("article", code);
  return url.toString();
}

function stripLinkQuery() {
  const url = new URL(globalThis.location.href);
  let changed = false;
  if (url.searchParams.has("library")) {
    url.searchParams.delete("library");
    changed = true;
  }
  if (url.searchParams.has("article")) {
    url.searchParams.delete("article");
    changed = true;
  }
  if (url.searchParams.has("capture")) {
    url.searchParams.delete("capture");
    changed = true;
  }
  if (!changed) return;
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function copyText(value, message) {
  await navigator.clipboard?.writeText(value);
  toast(message);
}

async function shareText(title, url, fallbackMessage) {
  if (navigator.share) {
    await navigator.share({ title, url });
  } else {
    await copyText(url, fallbackMessage);
  }
}

function renderSyncIndicator() {
  const dot = $("sync-dot");
  if (!dot) return;
  const pending = state.sync?.mutationQueue?.length > 0;
  const synced = Boolean(state.user?.profileCode && !pending && state.syncStatus !== "syncing");
  dot.classList.toggle("synced", synced);
  dot.classList.toggle("unsynced", !synced);
  dot.setAttribute("aria-label", synced ? "synced" : "not synced");
  dot.title = synced ? "synced" : "not synced";
}

function configureSync() {
  if (!hasUser()) {
    librarySync?.stop();
    librarySync = null;
    state.syncStatus = "idle";
    return;
  }

  if (!state.user.profileCode) {
    librarySync?.stop();
    librarySync = null;
    state.syncStatus = state.sync?.mutationQueue?.length ? "pending" : "idle";
  } else if (!librarySync || librarySync.code !== state.user.profileCode) {
    librarySync?.stop();
    librarySync = new MarginaliaSync({
      code: state.user.profileCode,
      state,
      save,
      onStatus(status) {
        state.syncStatus = status;
        renderSyncIndicator();
      },
      onChange() {
        save();
        renderAll();
        refreshCurrentArticle();
      },
      onRoom(room) {
        if (room?.code && state.user) {
          state.user.profileCode = room.code;
          save();
        }
      }
    });
    librarySync.start();
  }
}

function markCaptureExtensionInstalled() {
  captureExtensionInstalled = true;
  clearTimeout(extensionPromptTimer);
}

function scheduleExtensionInstallPrompt() {
  clearTimeout(extensionPromptTimer);
  if (captureExtensionInstalled || !state.settings.extensionInstallUrl || !isDesktopChromium()) return;

  extensionPromptTimer = setTimeout(() => {
    if (captureExtensionInstalled) return;
    toast("Click here to install chrome extension", {
      href: state.settings.extensionInstallUrl,
      duration: EXTENSION_PROMPT_DURATION_MS
    });
  }, EXTENSION_PROMPT_DELAY_MS);
}

function isDesktopChromium() {
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return false;
  return /\b(?:Chrome|Chromium|Edg)\//.test(ua) && !/\bOPR\//.test(ua);
}

function handleLinkQueries() {
  const params = new URLSearchParams(globalThis.location.search);
  const libraryCode = normalizeCode(params.get("library"));
  const articleCode = normalizeCode(params.get("article"));

  if (libraryCode) {
    runAction(() => linkLibrary(libraryCode));
    return;
  }

  if (articleCode) {
    runAction(() => openSharedArticle(articleCode));
  }
}

function closeSetup() {
  state.setupScreen = null;
  state.setupPayload = null;
  stripLinkQuery();
  renderAll();
}

function runAction(fn) {
  Promise.resolve(fn()).catch(error => {
    toast(error instanceof Error ? error.message : String(error));
  });
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");

  globalThis.addEventListener("message", event => {
    if (event.source !== globalThis || event.origin !== globalThis.location.origin) return;
    if (event.data?.type === "marginalia:extension-installed") {
      markCaptureExtensionInstalled();
      return;
    }
    if (event.data?.type !== "marginalia:capture") return;
    runAction(() => addCapturedArticle(event.data.payload || {}, event.data.id));
  });

  $("link-library-btn")?.addEventListener("click", () => runAction(showLibraryLink));

  $("setup-content")?.addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;

    runAction(async () => {
      if (action.dataset.action === "close-setup") return closeSetup();
      if (action.dataset.action === "copy-library-url") return copyText($("library-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-library-code") return copyText($("library-share-code")?.textContent || "", "code copied");
      if (action.dataset.action === "share-library-url") return shareText("link marginalia library", $("library-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-article-url") return copyText($("article-share-url")?.value || "", "url copied");
      if (action.dataset.action === "copy-article-code") return copyText($("article-share-code")?.textContent || "", "code copied");
      if (action.dataset.action === "share-article-url") return shareText("share marginalia article", $("article-share-url")?.value || "", "url copied");
    });
  });

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
      if (action.dataset.action === "back-to-detail") return backToArticleDetail();
      if (action.dataset.action === "read-article") return showArticleReader();
      if (action.dataset.action === "share-article") return runAction(shareCurrentArticle);
      if (action.dataset.action === "toggle-read") return toggleRead(state.currentArticle.id);
      if (action.dataset.action === "request-delete") return requestDeleteCurrentArticle();
      if (action.dataset.action === "confirm-delete") return deleteCurrentArticle();
      if (action.dataset.action === "cancel-delete") return cancelDeleteCurrentArticle();
    }

    const related = event.target.closest(".related-item");
    if (!related) return;
    const article = getArticles().find(candidate => candidate.id === related.dataset.id);
    if (!article) return;
    showArticleInOverlay(article.id);
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("detail-overlay").classList.contains("active")) {
      goBack();
    }
  });
}

function init() {
  bindEvents();
  handleLinkQueries();
  configureSync();
  renderAll();
  scheduleExtensionInstallPrompt();
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
