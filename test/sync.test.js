import assert from "node:assert/strict";
import test from "node:test";
import { MarginaliaSync } from "../app/sync.js";
import {
  articleSharePreviewHtml,
  buildArticleAppUrl,
  materializeMutations,
  normalizeArticleShareRoom,
  normalizeRoom,
  parseArticlePreviewRoute,
  parseLibraryRoute,
  parseRoomRoute
} from "../workers/sync/src/index.js";

test("library routes parse only supported room paths", () => {
  assert.deepEqual(parseLibraryRoute("/api/libraries/abc123/sync"), {
    code: "ABC123",
    action: "sync"
  });
  assert.deepEqual(parseLibraryRoute("/api/libraries/abc123"), {
    code: "ABC123",
    action: ""
  });
  assert.equal(parseLibraryRoute("/api/profiles/abc123"), null);
});

test("article share routes parse supported room paths", () => {
  assert.deepEqual(parseRoomRoute("/api/articles/abc123"), {
    kind: "articles",
    code: "ABC123",
    action: ""
  });
  assert.deepEqual(parseRoomRoute("/api/articles/abc123/state"), {
    kind: "articles",
    code: "ABC123",
    action: "state"
  });
  assert.deepEqual(parseRoomRoute("/api/articles/abc123/preview"), {
    kind: "articles",
    code: "ABC123",
    action: "preview"
  });
  assert.deepEqual(parseArticlePreviewRoute("/share/articles/abc123"), {
    kind: "articles",
    code: "ABC123",
    action: "preview"
  });
  assert.equal(parseRoomRoute("/api/folders/abc123"), null);
  assert.equal(parseArticlePreviewRoute("/share/libraries/abc123"), null);
});

test("article share rooms keep a clean app URL for preview redirects", () => {
  const room = normalizeRoom({
    kind: "articles",
    code: "abc123",
    action: ""
  }, {
    article: { id: "article-1" },
    appUrl: "https://emh.io/marginalia/?article=OLD#reader"
  });

  assert.equal(room.appUrl, "https://emh.io/marginalia/");
});

test("article share room normalization validates required article fields", () => {
  const room = normalizeArticleShareRoom({
    code: "abc123",
    article: { id: "article-1" },
    appUrl: "not a url"
  });

  assert.equal(room.articleId, "article-1");
  assert.equal(room.appUrl, "");
});

test("article preview redirects only to allowed app origins", () => {
  const env = {
    ALLOWED_ORIGINS: "http://localhost:8010,https://emh.io",
    APP_BASE_URL: "https://emh.io/marginalia/"
  };
  const request = new Request("https://marginalia-sync.example/share/articles/abc123?app=https%3A%2F%2Fevil.example%2F");

  assert.equal(
    buildArticleAppUrl(request, env, "abc123", { appUrl: "http://localhost:8010/app/" }),
    "http://localhost:8010/app/?article=ABC123"
  );
});

test("article preview html includes escaped article metadata", () => {
  const html = articleSharePreviewHtml({
    article: {
      title: "A&B \"C\"",
      excerpt: "Less <more>",
      lang: "en",
      url: "https://example.com/a"
    },
    appUrl: "https://emh.io/marginalia/?article=ABC123",
    previewUrl: "https://marginalia-sync.example/share/articles/ABC123"
  });

  assert.match(html, /<meta property="og:title" content="A&amp;B &quot;C&quot;">/);
  assert.match(html, /<meta property="og:description" content="Less &lt;more&gt;">/);
  assert.match(html, /location\.replace/);
});

test("worker materialization sorts by HLC and keeps tombstones out of visible state", () => {
  const room = {
    type: "library",
    code: "ROOM123",
    user: { id: "user-a", profileCode: "ROOM123" }
  };
  const mutations = [
    mutation({
      id: "delete",
      entityId: "article-1",
      field: "deleted",
      value: true,
      timestamp: hlc(103)
    }),
    mutation({
      id: "create",
      entityId: "article-1",
      field: "_create",
      timestamp: hlc(100),
      value: {
        id: "article-1",
        requestedUrl: "https://example.com/a",
        title: "Original"
      }
    }),
    mutation({
      id: "rename-new",
      entityId: "article-1",
      field: "title",
      value: "New",
      timestamp: hlc(102)
    }),
    mutation({
      id: "rename-old",
      entityId: "article-1",
      field: "title",
      value: "Old",
      timestamp: hlc(101)
    })
  ];

  assert.deepEqual(materializeMutations(mutations, room).articles, []);

  const restored = materializeMutations([
    ...mutations,
    mutation({
      id: "restore",
      entityId: "article-1",
      field: "deleted",
      value: false,
      timestamp: hlc(104)
    })
  ], room);

  assert.equal(restored.articles.length, 1);
  assert.equal(restored.articles[0].title, "New");
});

test("worker materializes article share rooms", () => {
  const room = {
    type: "article_share",
    code: "ART123",
    articleId: "article-1"
  };
  const mutations = [
    mutation({
      id: "article",
      entityId: "article-1",
      field: "_create",
      timestamp: hlc(100),
      value: {
        id: "article-1",
        requestedUrl: "https://example.com/a",
        title: "Shared"
      }
    })
  ];

  const materialized = materializeMutations(mutations, room);
  assert.equal(materialized.articles.length, 1);
  assert.equal(materialized.articles[0].title, "Shared");
});

test("sync confirmation removes queued ids and advances high watermark", () => {
  const queued = [
    mutation({ id: "one", timestamp: hlc(100) }),
    mutation({ id: "two", timestamp: hlc(101) })
  ];
  const state = {
    sync: {
      mutationQueue: [...queued],
      lastSyncTimestamp: ""
    },
    articles: [],
    articleClocks: {},
    hlc: { wallTime: 0, counter: 0 }
  };
  let saved = 0;
  const sync = new MarginaliaSync({
    code: "ROOM123",
    state,
    save() {
      saved += 1;
    }
  });

  sync.confirm(["one"], hlc(102), false);

  assert.equal(saved, 1);
  assert.deepEqual(state.sync.mutationQueue.map(item => item.id), ["two"]);
  assert.equal(state.sync.lastSyncTimestamp, hlc(102));
});

function mutation(overrides) {
  return {
    id: "mutation",
    entityType: "article",
    entityId: "article",
    field: "title",
    value: "value",
    timestamp: hlc(100),
    authorId: "user-a",
    deviceId: "device-a",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
