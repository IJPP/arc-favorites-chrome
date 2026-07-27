import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FAVORITES,
  chooseFallbackTab,
  coldUrlFor,
  favoriteIdFromColdUrl,
  isSupportedPageUrl,
  matchFavoritesToPinnedTabs,
  normalizeFavorites,
} from "../core.js";

const extensionOrigin = "chrome-extension://favorite-test/";

function favorite(overrides = {}) {
  return {
    id: "favorite-1",
    homeUrl: "https://example.com/",
    lastUrl: "https://example.com/deep",
    title: "Example",
    faviconUrl: "",
    order: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    state: "warm",
    tabId: 10,
    windowId: 1,
    ...overrides,
  };
}

test("supports only normal web URLs", () => {
  assert.equal(isSupportedPageUrl("https://example.com"), true);
  assert.equal(isSupportedPageUrl("http://localhost:3000"), true);
  assert.equal(isSupportedPageUrl("chrome://settings"), false);
  assert.equal(isSupportedPageUrl("file:///tmp/test.html"), false);
  assert.equal(isSupportedPageUrl("not a url"), false);
});

test("cold URLs preserve and recover Favorite identity", () => {
  const url = coldUrlFor(extensionOrigin, "favorite with spaces");
  assert.equal(
    url,
    "chrome-extension://favorite-test/cold.html?id=favorite+with+spaces",
  );
  assert.equal(
    favoriteIdFromColdUrl(url, extensionOrigin),
    "favorite with spaces",
  );
  assert.equal(
    favoriteIdFromColdUrl("https://example.com/cold.html?id=x", extensionOrigin),
    null,
  );
});

test("fallback selection avoids Favorites and prefers recent unpinned tabs", () => {
  const tabs = [
    { id: 10, active: true, pinned: true, lastAccessed: 500 },
    { id: 11, pinned: true, lastAccessed: 900 },
    { id: 12, pinned: false, lastAccessed: 100 },
    { id: 13, pinned: false, lastAccessed: 700 },
  ];
  const fallback = chooseFallbackTab(tabs, new Set([10, 11]), 10);
  assert.equal(fallback.id, 13);
});

test("reconciliation matches the saved tab id before URL fallbacks", () => {
  const favorites = [favorite()];
  const tabs = [
    {
      id: 20,
      url: "https://example.com/deep",
      windowId: 1,
      index: 0,
    },
    {
      id: 10,
      url: "https://example.com/other",
      windowId: 1,
      index: 1,
    },
  ];
  const [match] = matchFavoritesToPinnedTabs(
    favorites,
    tabs,
    extensionOrigin,
  );
  assert.equal(match.tab.id, 10);
  assert.equal(match.state, "warm");
});

test("reconciliation recognizes cold placeholders", () => {
  const favorites = [favorite({ tabId: null, state: "cold" })];
  const tabs = [
    {
      id: 33,
      url: coldUrlFor(extensionOrigin, "favorite-1"),
      windowId: 2,
      index: 0,
    },
  ];
  const [match] = matchFavoritesToPinnedTabs(
    favorites,
    tabs,
    extensionOrigin,
  );
  assert.equal(match.tab.id, 33);
  assert.equal(match.state, "cold");
});

test("normalization repairs malformed optional fields", () => {
  const [item] = normalizeFavorites([
    {
      id: "favorite-1",
      homeUrl: "https://example.com/",
      order: "bad",
    },
  ]);
  assert.equal(item.lastUrl, item.homeUrl);
  assert.equal(item.title, "example.com");
  assert.equal(item.order, 0);
  assert.equal(item.state, "cold");
  assert.equal(item.tabId, null);
  assert.equal(MAX_FAVORITES, 12);
});
