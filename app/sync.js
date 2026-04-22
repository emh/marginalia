import { applyMutations, compareHlc, normalizeCode } from "./model.js";
import { loadSettings } from "./storage.js";

const SYNC_PATH = "/sync";
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export class MarginaliaSync {
  constructor({ code, state, save, onStatus, onChange, onRoom }) {
    this.code = normalizeCode(code);
    this.state = state;
    this.save = save;
    this.onStatus = onStatus;
    this.onChange = onChange;
    this.onRoom = onRoom;
    this.settings = loadSettings();
    this.socket = null;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.status = "idle";
    this.inFlight = new Set();
    this.stopped = false;
  }

  start() {
    if (!this.settings.syncBaseUrl || !this.code) {
      this.setStatus("offline");
      return;
    }

    this.stopped = false;
    this.connect();
    globalThis.addEventListener?.("online", () => this.connect());
    globalThis.addEventListener?.("offline", () => this.setStatus("offline"));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.inFlight.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  flush() {
    if (!this.settings.syncBaseUrl || !this.code) {
      this.setStatus("offline");
      return;
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.pushQueued();
      return;
    }

    this.httpSync().catch(() => {
      this.setStatus(this.queue().length ? "pending" : "offline");
      this.scheduleReconnect();
    });
  }

  connect() {
    if (
      this.stopped ||
      !this.settings.syncBaseUrl ||
      !this.code ||
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    clearTimeout(this.retryTimer);
    this.setStatus("syncing");

    try {
      this.socket = new WebSocket(getWebSocketUrl(this.settings.syncBaseUrl, this.code));
    } catch {
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.retryDelay = RETRY_MIN_MS;
      this.send({ type: "sync", since: this.syncState().lastSyncTimestamp || "" });
      this.pushQueued();
    });

    this.socket.addEventListener("message", event => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener("close", () => {
      this.socket = null;
      this.inFlight.clear();
      if (this.stopped) return;
      this.setStatus(this.queue().length ? "pending" : "offline");
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "mutations" && Array.isArray(message.items)) {
      this.applyIncoming(message.items, message.highWatermark);
      this.pushQueued();
      return;
    }

    if (message.type === "ack" && Array.isArray(message.confirmedIds)) {
      this.confirm(message.confirmedIds, message.highWatermark);
      return;
    }

    if (message.type === "room" && message.room) {
      this.onRoom?.(message.room);
      return;
    }

    if (message.type === "error") {
      this.setStatus(this.queue().length ? "pending" : "offline");
    }
  }

  async httpSync() {
    this.setStatus("syncing");
    const response = await fetch(getLibraryEndpoint(this.settings.syncBaseUrl, this.code, SYNC_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        since: this.syncState().lastSyncTimestamp || "",
        mutations: this.queue()
      })
    });

    if (!response.ok) throw new Error(await getErrorMessage(response));

    const payload = await response.json();
    if (payload.room) this.onRoom?.(payload.room);
    if (Array.isArray(payload.confirmedIds)) this.confirm(payload.confirmedIds, payload.highWatermark, false);
    if (Array.isArray(payload.mutations)) this.applyIncoming(payload.mutations, payload.highWatermark, false);
    this.persistAndNotify();
    this.setSettledStatus();
  }

  pushQueued() {
    const queued = this.queue().filter(mutation => !this.inFlight.has(mutation.id));
    if (!queued.length) {
      this.setSettledStatus();
      return;
    }

    for (const mutation of queued) this.inFlight.add(mutation.id);
    this.setStatus("syncing");
    this.send({ type: "push", mutations: queued });
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  applyIncoming(mutations, highWatermark, notify = true) {
    const changed = applyMutations(this.state, mutations);
    this.observeHighWatermark(highWatermark);
    if (changed || highWatermark) this.persistAndNotify(notify);
    this.setSettledStatus();
  }

  confirm(ids, highWatermark, notify = true) {
    const confirmed = new Set(ids);
    this.setQueue(this.queue().filter(mutation => !confirmed.has(mutation.id)));
    for (const id of confirmed) this.inFlight.delete(id);
    this.observeHighWatermark(highWatermark);
    this.persistAndNotify(notify);
    this.setSettledStatus();
  }

  observeHighWatermark(highWatermark) {
    const syncState = this.syncState();
    if (highWatermark && compareHlc(highWatermark, syncState.lastSyncTimestamp) > 0) {
      syncState.lastSyncTimestamp = highWatermark;
    }
  }

  persistAndNotify(notify = true) {
    this.save();
    if (notify) this.onChange?.();
  }

  setSettledStatus() {
    this.setStatus(this.queue().length ? "pending" : "synced");
  }

  setStatus(status) {
    this.status = status;
    this.onStatus?.(status);
  }

  scheduleReconnect() {
    if (this.stopped || !this.settings.syncBaseUrl || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 1.6, RETRY_MAX_MS);
      this.connect();
    }, this.retryDelay);
  }

  syncState() {
    this.state.sync ||= { mutationQueue: [], lastSyncTimestamp: "" };
    return this.state.sync;
  }

  queue() {
    return this.syncState().mutationQueue || [];
  }

  setQueue(next) {
    this.syncState().mutationQueue = next;
  }
}

export async function createRemoteLibrary({ user, mutations }, settings = loadSettings()) {
  const response = await fetch(getEndpoint(settings.syncBaseUrl, "/api/libraries"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, mutations })
  });

  if (!response.ok) throw new Error(await getErrorMessage(response));
  return response.json();
}

export async function fetchRemoteLibrary(code, settings = loadSettings()) {
  const response = await fetch(getLibraryEndpoint(settings.syncBaseUrl, code, ""));
  if (!response.ok) throw new Error(await getErrorMessage(response));
  return response.json();
}

export async function createRemoteArticleShare({ article, user, mutations, appUrl }, settings = loadSettings()) {
  const response = await fetch(getEndpoint(settings.syncBaseUrl, "/api/articles"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article, user, mutations, appUrl })
  });

  if (!response.ok) throw new Error(await getErrorMessage(response));
  return response.json();
}

export async function fetchRemoteArticleShare(code, settings = loadSettings()) {
  const response = await fetch(getArticleEndpoint(settings.syncBaseUrl, code, ""));
  if (!response.ok) throw new Error(await getErrorMessage(response));
  return response.json();
}

function getEndpoint(syncBaseUrl, path) {
  if (!syncBaseUrl) throw new Error("Sync worker is not configured");
  const base = syncBaseUrl.replace(/\/+$/, "");
  return new URL(path, `${base}/`).toString();
}

function getLibraryEndpoint(syncBaseUrl, code, path) {
  return getEndpoint(syncBaseUrl, `/api/libraries/${encodeURIComponent(normalizeCode(code))}${path}`);
}

function getArticleEndpoint(syncBaseUrl, code, path) {
  return getEndpoint(syncBaseUrl, `/api/articles/${encodeURIComponent(normalizeCode(code))}${path}`);
}

function getWebSocketUrl(syncBaseUrl, code) {
  const url = new URL(`/api/libraries/${encodeURIComponent(normalizeCode(code))}${SYNC_PATH}`, `${syncBaseUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function getErrorMessage(response) {
  try {
    const payload = await response.json();
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    // Fall through to status text.
  }

  return response.statusText || "Sync failed";
}
