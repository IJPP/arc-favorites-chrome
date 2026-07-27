import test from "node:test";
import assert from "node:assert/strict";

class FakeEvent {
  listeners = new Set();

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  async trigger(...args) {
    for (const listener of [...this.listeners]) {
      await listener(...args);
    }
  }
}

function createFakeChrome({
  homeAudibleOnReload = false,
  refuseAudibleDiscard = false,
  retainAudibleOnDiscard = false,
} = {}) {
  let nextTabId = 3;
  const reloadCounts = new Map();
  let storage = {};
  const tabs = new Map([
    [
      1,
      {
        id: 1,
        windowId: 1,
        index: 0,
        active: true,
        pinned: false,
        incognito: false,
        audible: true,
        discarded: false,
        mutedInfo: { muted: false },
        status: "complete",
        title: "Example Home",
        url: "https://example.com/",
        favIconUrl: "https://example.com/favicon.ico",
        lastAccessed: 200,
      },
    ],
    [
      2,
      {
        id: 2,
        windowId: 1,
        index: 1,
        active: false,
        pinned: false,
        incognito: false,
        audible: false,
        discarded: false,
        mutedInfo: { muted: false },
        status: "complete",
        title: "Fallback",
        url: "https://fallback.test/",
        favIconUrl: "",
        lastAccessed: 100,
      },
    ],
  ]);

  const events = {
    command: new FakeEvent(),
    contextClicked: new FakeEvent(),
    contextShown: new FakeEvent(),
    installed: new FakeEvent(),
    message: new FakeEvent(),
    startup: new FakeEvent(),
    tabActivated: new FakeEvent(),
    tabAttached: new FakeEvent(),
    tabMoved: new FakeEvent(),
    tabRemoved: new FakeEvent(),
    tabReplaced: new FakeEvent(),
    tabUpdated: new FakeEvent(),
    windowCreated: new FakeEvent(),
  };

  function copyTab(tab) {
    return tab ? { ...tab } : undefined;
  }

  function reindex(windowId) {
    [...tabs.values()]
      .filter((tab) => tab.windowId === windowId)
      .sort((left, right) => left.index - right.index)
      .forEach((tab, index) => {
        tab.index = index;
      });
  }

  async function updateTab(tabId, properties) {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id ${tabId}`);
    }
    const changeInfo = {};

    if (properties.active === true && !tab.active) {
      const wasDiscarded = tab.discarded;
      for (const candidate of tabs.values()) {
        if (candidate.windowId === tab.windowId) {
          candidate.active = candidate.id === tab.id;
        }
      }
      tab.discarded = false;
      if (wasDiscarded) {
        tab.status = "loading";
      }
      tab.lastAccessed += 1000;
      await events.tabActivated.trigger({
        tabId: tab.id,
        windowId: tab.windowId,
      });
      if (wasDiscarded) {
        tab.status = "complete";
        await events.tabUpdated.trigger(
          tab.id,
          { status: "complete" },
          copyTab(tab),
        );
      }
    } else if (properties.active === false) {
      tab.active = false;
    }

    if (
      typeof properties.pinned === "boolean" &&
      properties.pinned !== tab.pinned
    ) {
      tab.pinned = properties.pinned;
      changeInfo.pinned = properties.pinned;
    }

    if (
      typeof properties.muted === "boolean" &&
      properties.muted !== tab.mutedInfo.muted
    ) {
      tab.mutedInfo = { muted: properties.muted };
      changeInfo.mutedInfo = { muted: properties.muted };
    }

    if (properties.url && properties.url !== tab.url) {
      tab.url = properties.url;
      tab.status = "complete";
      tab.audible = false;
      tab.discarded = false;
      changeInfo.url = properties.url;
      changeInfo.status = "complete";
    }

    if (Object.keys(changeInfo).length) {
      await events.tabUpdated.trigger(tab.id, changeInfo, copyTab(tab));
    }
    return copyTab(tab);
  }

  const fake = {
    commands: {
      getAll: async () => [
        { name: "close-favorite", shortcut: "Alt+W" },
        { name: "toggle-favorite", shortcut: "Alt+Shift+P" },
      ],
      onCommand: events.command,
    },
    contextMenus: {
      create: () => undefined,
      onClicked: events.contextClicked,
      onShown: events.contextShown,
      refresh: () => undefined,
      removeAll: async () => undefined,
      update: async () => undefined,
    },
    runtime: {
      getURL: (path = "") => {
        return `chrome-extension://test/${path.replace(/^\//, "")}`;
      },
      onInstalled: events.installed,
      onMessage: events.message,
      onStartup: events.startup,
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(storage[key]) }),
        set: async (value) => {
          storage = { ...storage, ...structuredClone(value) };
        },
      },
    },
    tabs: {
      create: async (properties = {}) => {
        const windowId = properties.windowId ?? 1;
        const id = nextTabId++;
        const tab = {
          id,
          windowId,
          index: properties.index ?? tabs.size,
          active: properties.active ?? true,
          pinned: properties.pinned ?? false,
          incognito: false,
          audible: false,
          discarded: false,
          mutedInfo: { muted: false },
          status: "complete",
          title: "New Tab",
          url:
            properties.url ??
            "chrome://newtab/",
          favIconUrl: "",
          lastAccessed: 50,
        };
        if (tab.active) {
          for (const candidate of tabs.values()) {
            if (candidate.windowId === windowId) {
              candidate.active = false;
            }
          }
        }
        tabs.set(id, tab);
        reindex(windowId);
        if (tab.active) {
          await events.tabActivated.trigger({ tabId: id, windowId });
        }
        return copyTab(tab);
      },
      discard: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab || tab.active) {
          return undefined;
        }
        if (
          tab.audible &&
          (refuseAudibleDiscard || !tab.mutedInfo.muted)
        ) {
          return undefined;
        }
        tab.discarded = true;
        if (!retainAudibleOnDiscard) {
          tab.audible = false;
        }
        return copyTab(tab);
      },
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error(`No tab with id ${tabId}`);
        }
        return copyTab(tab);
      },
      reload: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error(`No tab with id ${tabId}`);
        }
        reloadCounts.set(tabId, (reloadCounts.get(tabId) ?? 0) + 1);
        tab.status = "loading";
        await events.tabUpdated.trigger(
          tab.id,
          { status: "loading" },
          copyTab(tab),
        );
        tab.status = "complete";
        tab.audible = homeAudibleOnReload;
        await events.tabUpdated.trigger(
          tab.id,
          { status: "complete" },
          copyTab(tab),
        );
      },
      onActivated: events.tabActivated,
      onAttached: events.tabAttached,
      onMoved: events.tabMoved,
      onRemoved: events.tabRemoved,
      onReplaced: events.tabReplaced,
      onUpdated: events.tabUpdated,
      move: async (tabId, moveProperties) => {
        await moveTab(tabId, moveProperties.index);
        return copyTab(tabs.get(tabId));
      },
      query: async (query) => {
        return [...tabs.values()]
          .filter((tab) => {
            if (query.windowId != null && tab.windowId !== query.windowId) {
              return false;
            }
            if (query.currentWindow && tab.windowId !== 1) {
              return false;
            }
            if (query.active != null && tab.active !== query.active) {
              return false;
            }
            if (query.pinned != null && tab.pinned !== query.pinned) {
              return false;
            }
            return true;
          })
          .map(copyTab);
      },
      remove: async (tabId) => removeTab(tabId),
      update: updateTab,
    },
    windows: {
      get: async (windowId) => ({ id: windowId, type: "normal" }),
      getAll: async () => [{ id: 1, type: "normal", focused: true }],
      getLastFocused: async () => ({
        id: 1,
        type: "normal",
        focused: true,
      }),
      onCreated: events.windowCreated,
      update: async (windowId) => ({
        id: windowId,
        type: "normal",
        focused: true,
      }),
    },
  };

  async function sendMessage(message) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of events.message.listeners) {
        const result = listener(message, {}, (response) => {
          handled = true;
          if (response.ok) {
            resolve(response.result);
          } else {
            reject(new Error(response.error));
          }
        });
        if (result === true) {
          handled = true;
        }
      }
      if (!handled) {
        reject(new Error(`No message handler for ${message.type}`));
      }
    });
  }

  async function removeTab(tabId, isWindowClosing = false) {
    const tab = tabs.get(tabId);
    tabs.delete(tabId);
    if (tab) {
      reindex(tab.windowId);
      await events.tabRemoved.trigger(tabId, {
        isWindowClosing,
        windowId: tab.windowId,
      });
    }
  }

  async function moveTab(tabId, toIndex) {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id ${tabId}`);
    }
    const peers = [...tabs.values()]
      .filter((candidate) => candidate.windowId === tab.windowId)
      .sort((left, right) => left.index - right.index);
    const fromIndex = peers.findIndex((candidate) => candidate.id === tabId);
    peers.splice(fromIndex, 1);
    peers.splice(Math.max(0, Math.min(toIndex, peers.length)), 0, tab);
    peers.forEach((candidate, index) => {
      candidate.index = index;
    });
    await events.tabMoved.trigger(tabId, {
      fromIndex,
      toIndex: tab.index,
      windowId: tab.windowId,
    });
  }

  return {
    events,
    fake,
    getStoredFavorites: () =>
      structuredClone(storage["arcFavorites.v1"] ?? []),
    getTab: (tabId) => copyTab(tabs.get(tabId)),
    getReloadCount: (tabId) => reloadCounts.get(tabId) ?? 0,
    setStoredFavorites: (favorites) => {
      storage["arcFavorites.v1"] = structuredClone(favorites);
    },
    setAudible: (tabId, audible) => {
      tabs.get(tabId).audible = audible;
    },
    moveTab,
    removeTab,
    sendMessage,
  };
}

test("Favorite stays pinned while closing cold, wakes at Home, and rescues Cmd-W", async () => {
  const harness = createFakeChrome();
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${Date.now()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  let [favorite] = harness.getStoredFavorites();
  assert.equal(harness.getTab(1).pinned, true);
  assert.equal(favorite.homeUrl, "https://example.com/");
  assert.equal(favorite.state, "warm");

  await harness.fake.tabs.update(1, {
    url: "https://example.com/deep",
  });
  harness.setAudible(1, true);
  [favorite] = harness.getStoredFavorites();
  assert.equal(favorite.lastUrl, "https://example.com/deep");

  await harness.sendMessage({
    type: "favorite:close",
    favoriteId: favorite.id,
  });
  [favorite] = harness.getStoredFavorites();
  assert.equal(favorite.state, "cold");
  assert.equal(harness.getTab(1), undefined);
  assert.notEqual(favorite.tabId, 1);
  assert.equal(harness.getTab(favorite.tabId).pinned, true);
  assert.match(harness.getTab(favorite.tabId).url, /cold\.html\?id=/);
  assert.equal(harness.getTab(favorite.tabId).audible, false);
  assert.equal(harness.getTab(favorite.tabId).mutedInfo.muted, false);
  assert.equal(harness.getTab(favorite.tabId).discarded, true);
  assert.equal(harness.getTab(favorite.tabId).index, 0);
  assert.equal(harness.getTab(2).active, true);

  await harness.fake.tabs.update(favorite.tabId, { active: true });
  [favorite] = harness.getStoredFavorites();
  assert.equal(harness.getTab(favorite.tabId).url, "https://example.com/");
  assert.equal(favorite.state, "warm");

  const closedTabId = favorite.tabId;
  await harness.removeTab(closedTabId);
  [favorite] = harness.getStoredFavorites();
  assert.notEqual(favorite.tabId, closedTabId);
  assert.equal(favorite.state, "cold");
  assert.equal(harness.getTab(favorite.tabId).pinned, true);
  assert.equal(harness.getTab(favorite.tabId).discarded, true);
  assert.match(harness.getTab(favorite.tabId).url, /cold\.html\?id=/);

  const rescuedTabId = favorite.tabId;
  await harness.sendMessage({
    type: "favorite:remove",
    favoriteId: favorite.id,
  });
  assert.equal(harness.getStoredFavorites().length, 0);
  assert.equal(harness.getTab(rescuedTabId).pinned, false);
  assert.equal(harness.getTab(rescuedTabId).url, "https://example.com/");
});

test("Reset returns Home, moving pins persists order, and unpin removes registration", async () => {
  const harness = createFakeChrome();
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${crypto.randomUUID()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  await harness.sendMessage({ type: "favorite:add", tabId: 2 });

  await harness.moveTab(2, 0);
  let favorites = harness.getStoredFavorites();
  assert.deepEqual(
    favorites.map((favorite) => favorite.tabId),
    [2, 1],
  );
  assert.deepEqual(
    favorites.map((favorite) => favorite.order),
    [0, 1],
  );

  const favoriteForFirstTab = favorites.find(
    (favorite) => favorite.tabId === 1,
  );
  await harness.fake.tabs.update(1, {
    url: "https://example.com/deep",
  });
  await harness.sendMessage({
    type: "favorite:reset",
    favoriteId: favoriteForFirstTab.id,
  });
  assert.equal(harness.getTab(1).active, true);
  assert.equal(harness.getTab(1).pinned, true);
  assert.equal(harness.getTab(1).url, "https://example.com/");

  await harness.fake.tabs.update(1, { pinned: false });
  favorites = harness.getStoredFavorites();
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0].tabId, 2);

  await harness.sendMessage({
    type: "favorite:close",
    favoriteId: favorites[0].id,
  });
  const [closedFavorite] = harness.getStoredFavorites();
  const restingTabId = closedFavorite.tabId;
  await harness.fake.tabs.update(restingTabId, { pinned: false });
  assert.equal(harness.getStoredFavorites().length, 0);
  assert.equal(harness.getTab(restingTabId).url, "https://fallback.test/");
});

test("Closing an audible Favorite replaces its media session with a silent tab", async () => {
  const harness = createFakeChrome({
    homeAudibleOnReload: true,
    retainAudibleOnDiscard: true,
  });
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${crypto.randomUUID()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  const [favorite] = harness.getStoredFavorites();
  assert.equal(harness.getTab(1).audible, true);

  await harness.sendMessage({
    type: "favorite:close",
    favoriteId: favorite.id,
  });

  const [closedFavorite] = harness.getStoredFavorites();
  assert.equal(harness.getReloadCount(1), 0);
  assert.equal(harness.getTab(1), undefined);
  assert.match(harness.getTab(closedFavorite.tabId).url, /cold\.html\?id=/);
  assert.equal(harness.getTab(closedFavorite.tabId).audible, false);
  assert.equal(harness.getTab(closedFavorite.tabId).discarded, true);
  assert.equal(harness.getTab(closedFavorite.tabId).mutedInfo.muted, false);
});

test("Startup keeps an existing silent placeholder discarded", async () => {
  const harness = createFakeChrome();
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${crypto.randomUUID()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  const [favorite] = harness.getStoredFavorites();
  await harness.fake.tabs.update(1, {
    url: `chrome-extension://test/cold.html?id=${favorite.id}`,
  });
  await harness.fake.tabs.update(2, { active: true });

  await harness.events.startup.trigger();

  const [migrated] = harness.getStoredFavorites();
  assert.equal(migrated.state, "cold");
  assert.match(harness.getTab(1).url, /cold\.html\?id=/);
  assert.equal(harness.getTab(1).discarded, true);
});

test("Startup replaces media left on an existing cold Home tab", async () => {
  const harness = createFakeChrome();
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${crypto.randomUUID()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  const [favorite] = harness.getStoredFavorites();
  harness.setStoredFavorites([{ ...favorite, state: "cold" }]);
  harness.setAudible(1, true);
  await harness.fake.tabs.update(2, { active: true });

  await harness.events.startup.trigger();

  const [cleanedFavorite] = harness.getStoredFavorites();
  assert.equal(harness.getReloadCount(1), 0);
  assert.equal(harness.getTab(1), undefined);
  assert.notEqual(cleanedFavorite.tabId, 1);
  assert.match(harness.getTab(cleanedFavorite.tabId).url, /cold\.html\?id=/);
  assert.equal(harness.getTab(cleanedFavorite.tabId).audible, false);
  assert.equal(harness.getTab(cleanedFavorite.tabId).discarded, true);
});

test("Browser startup restores a Favorite whose window closed", async () => {
  const harness = createFakeChrome();
  globalThis.chrome = harness.fake;
  await import(`../favorites-background.js?test=${crypto.randomUUID()}`);

  await harness.sendMessage({ type: "favorite:add", tabId: 1 });
  let [favorite] = harness.getStoredFavorites();
  await harness.removeTab(favorite.tabId, true);

  [favorite] = harness.getStoredFavorites();
  assert.equal(favorite.state, "cold");
  assert.equal(favorite.tabId, null);

  await harness.events.startup.trigger();
  [favorite] = harness.getStoredFavorites();
  assert.ok(Number.isInteger(favorite.tabId));
  assert.equal(favorite.state, "cold");
  assert.equal(harness.getTab(favorite.tabId).pinned, true);
  assert.equal(harness.getTab(favorite.tabId).discarded, true);
  assert.match(harness.getTab(favorite.tabId).url, /cold\.html\?id=/);
});

test("Background starts in Chrome without Firefox-only contextMenus.onShown", async () => {
  const harness = createFakeChrome();
  delete harness.fake.contextMenus.onShown;
  globalThis.chrome = harness.fake;

  await assert.doesNotReject(
    import(`../favorites-background.js?test=${crypto.randomUUID()}`),
  );
  const snapshot = await harness.sendMessage({ type: "snapshot:get" });
  assert.deepEqual(snapshot.favorites, []);
  assert.equal(snapshot.activeTab.url, "https://example.com/");
});
