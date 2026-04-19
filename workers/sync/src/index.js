const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const ARTICLE_FIELDS = new Set([
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
]);

const ARTICLE_MUTATION_FIELDS = new Set(["_create", "title", "tags", "notes", "isFavorite", "isArchived", "deleted"]);

export class LibraryRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.initialize();
  }

  async initialize() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutations (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.state.storage.sql.exec("CREATE INDEX IF NOT EXISTS mutations_timestamp_idx ON mutations(timestamp)");
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);
    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    try {
      if (!route.action && request.method === "POST") {
        return this.createRoom(request, route, cors);
      }

      if (!route.action && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      if (route.kind === "libraries" && route.action === "sync" && request.method === "GET") {
        return this.handleWebSocket(request);
      }

      if (route.kind === "libraries" && route.action === "sync" && request.method === "POST") {
        return this.handleHttpSync(request, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
  }

  async createRoom(request, route, cors) {
    if (request.headers.get("X-Marginalia-Internal-Create") !== "1") {
      return json({ error: "Not found" }, 404, cors);
    }

    const existing = await this.getRoom();
    if (existing) return json({ error: `${roomLabel(route.kind)} code already exists` }, 409, cors);

    const body = await readJson(request);
    const room = normalizeRoom(route, body);
    await this.saveRoom(room);

    const mutations = Array.isArray(body.mutations) && body.mutations.length
      ? body.mutations
      : buildSeedMutations(room, body);
    const accepted = await this.acceptMutations(mutations, room, { creating: true });
    const payload = await this.materializedPayload(room);
    return json({ ...payload, confirmedIds: accepted.map(mutation => mutation.id) }, 200, cors);
  }

  async handleWebSocket(request) {
    await this.requireRoom();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpSync(request, cors) {
    const room = await this.requireRoom();
    const body = await readJson(request);
    const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
    const mutations = await this.listSince(typeof body.since === "string" ? body.since : "");
    const highWatermark = await this.highWatermark();

    if (accepted.length) {
      this.broadcast(null, {
        type: "mutations",
        items: accepted,
        highWatermark
      });
    }

    return json({
      room,
      mutations,
      confirmedIds: accepted.map(mutation => mutation.id),
      highWatermark
    }, 200, cors);
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const room = await this.requireRoom();
      if (room.type !== "library") {
        socket.send(JSON.stringify({ type: "error", message: "Article shares do not sync" }));
        return;
      }

      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        socket.send(JSON.stringify({ type: "room", room }));
        socket.send(JSON.stringify({
          type: "mutations",
          items: await this.listSince(typeof message.since === "string" ? message.since : ""),
          highWatermark: await this.highWatermark()
        }));
        return;
      }

      if (message.type === "push") {
        const accepted = await this.acceptMutations(Array.isArray(message.mutations) ? message.mutations : [], room);
        const highWatermark = await this.highWatermark();
        socket.send(JSON.stringify({
          type: "ack",
          confirmedIds: accepted.map(mutation => mutation.id),
          highWatermark
        }));

        if (accepted.length) {
          this.broadcast(socket, {
            type: "mutations",
            items: accepted,
            highWatermark
          });
        }
        return;
      }

      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}

  webSocketError() {}

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        try {
          socket.send(raw);
        } catch {
          // Dead sockets are closed by the runtime.
        }
      }
    }
  }

  async acceptMutations(input, room, options = {}) {
    const accepted = [];

    for (const candidate of input) {
      const mutation = validateMutation(candidate, room);
      this.authorizeMutation(mutation, room, options);
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;

      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
      accepted.push(mutation);
    }

    return accepted;
  }

  authorizeMutation(mutation, room, options = {}) {
    if (room.type === "library") return;
    if (room.type === "article_share" && options.creating && mutation.entityType === "article") return;
    throw new Error("Article shares are read-only");
  }

  async listSince(since) {
    const query = since
      ? this.state.storage.sql.exec("SELECT json FROM mutations WHERE timestamp > ? ORDER BY timestamp ASC, id ASC", since)
      : this.state.storage.sql.exec("SELECT json FROM mutations ORDER BY timestamp ASC, id ASC");
    return [...query].map(row => JSON.parse(row.json));
  }

  async highWatermark() {
    const rows = [...this.state.storage.sql.exec("SELECT timestamp FROM mutations ORDER BY timestamp DESC LIMIT 1")];
    return rows[0]?.timestamp || "";
  }

  async materializedPayload(room) {
    const mutations = await this.listSince("");
    const state = materializeMutations(mutations, room);
    return {
      room,
      code: room.code,
      user: room.user || null,
      mutations,
      articles: state.articles,
      highWatermark: await this.highWatermark()
    };
  }

  async getRoom() {
    return await this.state.storage.get("room") || null;
  }

  async requireRoom() {
    const room = await this.getRoom();
    if (!room) throw statusError("Room not found", 404);
    return room;
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/libraries") {
      return createRoomWithFreshCode(request, env, cors, "libraries");
    }

    if (request.method === "POST" && url.pathname === "/api/articles") {
      return createRoomWithFreshCode(request, env, cors, "articles");
    }

    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    const id = env.MARGINALIA_LIBRARY.idFromName(`${roomPrefix(route.kind)}:${route.code}`);
    const room = env.MARGINALIA_LIBRARY.get(id);
    return room.fetch(request);
  }
};

async function createRoomWithFreshCode(request, env, cors, kind) {
  const body = await request.text();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateInviteCode();
    const id = env.MARGINALIA_LIBRARY.idFromName(`${roomPrefix(kind)}:${code}`);
    const room = env.MARGINALIA_LIBRARY.get(id);
    const url = new URL(request.url);
    url.pathname = `/api/${kind}/${code}`;

    const response = await room.fetch(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "Origin": request.headers.get("Origin") || "",
        "X-Marginalia-Internal-Create": "1"
      },
      body
    }));

    if (response.status !== 409) return response;
  }

  return json({ error: `Could not create ${roomLabel(kind)} code` }, 500, cors);
}

export function parseRoomRoute(pathname) {
  const match = /^\/api\/(libraries|articles)\/([A-Za-z0-9]+)(?:\/(sync|state))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    kind: match[1],
    code: normalizeCode(match[2]),
    action: match[3] || ""
  };
}

export function parseLibraryRoute(pathname) {
  const route = parseRoomRoute(pathname);
  if (!route || route.kind !== "libraries") return null;
  return {
    code: route.code,
    action: route.action
  };
}

export function generateInviteCode(length = CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function normalizeRoom(route, body = {}) {
  if (route.kind === "articles") {
    return normalizeArticleShareRoom({ code: route.code, article: body.article });
  }

  return normalizeLibraryRoom({ code: route.code, user: body.user });
}

export function normalizeLibraryRoom(input = {}) {
  const code = normalizeCode(input.code);
  const user = normalizeUser(input.user);
  if (!code) throw new Error("Code is required");
  return {
    type: "library",
    code,
    user,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function normalizeArticleShareRoom(input = {}) {
  const code = normalizeCode(input.code);
  const articleId = String(input.article?.id || "").trim();
  if (!code) throw new Error("Code is required");
  if (!articleId) throw new Error("Article is required");
  return {
    type: "article_share",
    code,
    articleId,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function validateMutation(input) {
  if (!input || typeof input !== "object") throw new Error("Mutation must be an object");
  const mutation = {
    id: stringValue(input.id, "Mutation id"),
    entityType: stringValue(input.entityType, "Entity type"),
    entityId: stringValue(input.entityId, "Entity id"),
    field: stringValue(input.field, "Field"),
    value: input.value,
    timestamp: stringValue(input.timestamp, "Timestamp"),
    authorId: stringValue(input.authorId, "Author id"),
    deviceId: stringValue(input.deviceId, "Device id")
  };

  if (mutation.entityType !== "article") throw new Error("Invalid entity type");
  if (!isHlc(mutation.timestamp)) throw new Error("Invalid timestamp");

  return validateArticleMutation(mutation);
}

export function materializeMutations(mutations, room) {
  const state = {
    articles: [],
    articleClocks: {}
  };

  for (const mutation of mutations
    .map(item => validateMutation(item, room))
    .sort(compareMutation)) {
    applyServerMutation(state, mutation);
  }

  return {
    articles: state.articles.filter(article => !article.deleted)
  };
}

export function applyServerMutation(state, mutation) {
  state.articleClocks[mutation.entityId] ||= {};
  const clocks = state.articleClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeArticle({ ...mutation.value, id: mutation.entityId });
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
    applyAliases(article);
    return true;
  }

  if (!ARTICLE_FIELDS.has(mutation.field)) return false;
  let article = state.articles.find(candidate => candidate.id === mutation.entityId);
  if (!article) {
    article = normalizeArticle({ id: mutation.entityId });
    state.articles.push(article);
  }
  if (!shouldApply(clocks[mutation.field], mutation.timestamp)) return false;
  article[mutation.field] = coerceArticleField(mutation.field, mutation.value);
  clocks[mutation.field] = mutation.timestamp;
  applyAliases(article);
  return true;
}

function validateArticleMutation(mutation) {
  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("Article create value is required");
    return { ...mutation, value: normalizeArticle({ ...mutation.value, id: mutation.entityId }) };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!ARTICLE_MUTATION_FIELDS.has(field)) throw new Error("Invalid article field");
  return { ...mutation, field, value: coerceArticleField(field, mutation.value) };
}

function buildSeedMutations(room, body = {}) {
  if (room.type !== "article_share") return [];
  const user = normalizeUser(body.user || {});
  const article = normalizeArticle({ ...body.article, id: room.articleId, deleted: false });
  return [
    serverMutation("article", article.id, "_create", article, user)
  ];
}

function serverMutation(entityType, entityId, field, value, user) {
  return {
    id: crypto.randomUUID(),
    entityType,
    entityId,
    field,
    value,
    timestamp: `${String(Date.now()).padStart(13, "0")}:0000:server`,
    authorId: user.id,
    deviceId: "server"
  };
}

function normalizeArticle(input = {}) {
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

  const article = {
    id: String(input.id || ""),
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
    category: stringOr(input.category, "Other").slice(0, 40),
    embedding: Array.isArray(input.embedding) ? input.embedding : undefined,
    status: stringOr(input.status, "ready"),
    error: stringOr(input.error, ""),
    metadataSources: normalizeSources(input.metadataSources || input.sources)
  };
  applyAliases(article);
  return article;
}

function coerceArticleField(field, value) {
  if (field === "deleted" || field === "isFavorite" || field === "isArchived") return Boolean(value);
  if (field === "tags") return normalizeTags(value);
  if (field === "notes") return String(value || "").slice(0, 20_000);
  if (field === "title") return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300) || "Untitled article";
  return value;
}

function applyAliases(article) {
  article.url = article.requestedUrl || article.finalUrl || article.canonicalUrl;
  article.source = article.sourceHost || article.siteName || hostFromUrl(article.url);
  article.author = article.byline || "Unknown";
  article.summary = article.excerpt || "";
  article.dateAdded = article.capturedAt;
  article.isRead = Boolean(article.isArchived);
}

function normalizeUser(input = {}) {
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : "share",
    profileCode: normalizeCode(input.profileCode)
  };
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

function parseSocketMessage(raw) {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return JSON.parse(text);
}

function compareMutation(left, right) {
  return compareHlc(left.timestamp, right.timestamp) || left.id.localeCompare(right.id);
}

function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

function parseHlc(value) {
  const [wallTime, counter, ...deviceParts] = String(value || "").split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function isHlc(value) {
  return /^\d{13}:\d{4}:.+$/.test(value);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
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

function roomPrefix(kind) {
  return kind === "articles" ? "article" : "library";
}

function roomLabel(kind) {
  return kind === "articles" ? "article" : "library";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin && isAllowedOrigin(request, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return allowed.includes("*") || allowed.includes(origin);
}

function json(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}
