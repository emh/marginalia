import assert from "node:assert/strict";
import test from "node:test";
import { MarginaliaSync } from "../app/sync.js";
import { materializeMutations, parseLibraryRoute } from "../workers/sync/src/index.js";

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

test("worker materialization sorts by HLC and keeps tombstones out of visible state", () => {
  const room = {
    type: "library",
    code: "ROOM123",
    user: { id: "user-a", name: "A", profileCode: "ROOM123" }
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
    authorName: "A",
    deviceId: "device-a",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
