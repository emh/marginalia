import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMutation,
  compareHlc,
  parseHlc,
  serializeHlc,
  tickHlc
} from "../app/model.js";

test("hybrid logical clock is stable and totally ordered", () => {
  const state = { deviceId: "device-b", hlc: { wallTime: 0, counter: 0 } };
  const first = tickHlc(state, 100);
  const second = tickHlc(state, 100);
  const third = tickHlc(state, 99);

  assert.equal(first, "0000000000100:0000:device-b");
  assert.equal(second, "0000000000100:0001:device-b");
  assert.equal(third, "0000000000100:0002:device-b");
  assert.equal(compareHlc(first, second), -1);
  assert.equal(compareHlc(second, third), -1);
  assert.deepEqual(parseHlc(third), { wallTime: 100, counter: 2, deviceId: "device-b" });
  assert.equal(compareHlc(serializeHlc(100, 2, "device-a"), third), -1);
});

test("article fields use last-write-wins per field", () => {
  const state = emptyState();

  applyMutation(state, mutation({
    id: "create-article",
    entityId: "article-1",
    field: "_create",
    timestamp: hlc(100),
    value: {
      id: "article-1",
      requestedUrl: "https://example.com/a",
      title: "Original",
      tags: ["essay"],
      contentMarkdown: "Body"
    }
  }));

  applyMutation(state, mutation({
    id: "new-title",
    entityId: "article-1",
    field: "title",
    value: "New",
    timestamp: hlc(102)
  }));

  applyMutation(state, mutation({
    id: "old-title",
    entityId: "article-1",
    field: "title",
    value: "Old",
    timestamp: hlc(101, 0, "device-c")
  }));

  assert.equal(state.articles[0].title, "New");
  assert.deepEqual(state.articles[0].tags, ["essay"]);
  assert.equal(state.articles[0].contentMarkdown, "Body");
});

function emptyState() {
  return {
    deviceId: "device-a",
    user: { id: "user-a", name: "A" },
    hlc: { wallTime: 0, counter: 0 },
    articles: [],
    articleClocks: {}
  };
}

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
