import {
  MAX_FAVORITES,
  STORAGE_KEY,
  chooseFallbackTab,
  coldUrlFor,
  favoriteIdFromColdUrl,
  isSupportedPageUrl,
  matchFavoritesToPinnedTabs,
  normalizeFavorites,
  sortFavorites,
} from "./core.js";

const MENU_TOGGLE = "favorite-toggle";
const MENU_CLOSE = "favorite-close";
const MENU_RESET = "favorite-reset";
const extensionOrigin = chrome.runtime.getURL("/");

let mutationQueue = Promise.resolve();
let lifecycleQueue = Promise.resolve();

function coldUrl(favoriteId) {
  return coldUrlFor(extensionOrigin, favoriteId);
}

function enqueueLifecycle(task) {
  const run = lifecycleQueue
    .catch(() => undefined)
    .then(task);
  lifecycleQueue = run.catch(() => undefined);
  return run;
}

async function readFavorites() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeFavorites(stored[STORAGE_KEY]);
}

async function writeFavorites(favorites) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: sortFavorites(favorites),
  });
}

function mutateFavorites(mutator) {
  const task = mutationQueue.then(async () => {
    const favorites = await readFavorites();
    const result = await mutator(favorites);
    await writeFavorites(favorites);
    return result;
  });
  mutationQueue = task.catch(() => undefined);
  return task;
}

async function patchFavorite(favoriteId, patch) {
  return mutateFavorites((favorites) => {
    const favorite = favorites.find((item) => item.id === favoriteId);
    if (!favorite) {
      return null;
    }
    Object.assign(favorite, patch);
    return { ...favorite };
  });
}

async function removeFavoriteRecord(favoriteId) {
  return mutateFavorites((favorites) => {
    const index = favorites.findIndex((item) => item.id === favoriteId);
    if (index === -1) {
      return null;
    }
    return favorites.splice(index, 1)[0];
  });
}

async function notifyChanged() {
  try {
    await chrome.runtime.sendMessage({ type: "favorites:changed" });
  } catch {
    // The popup is normally closed; no receiver is expected.
  }
}

async function syncContextMenus(tab) {
  const favorite = tab?.id ? await favoriteForTab(tab.id) : null;
  try {
    await Promise.all([
      chrome.contextMenus.update(MENU_TOGGLE, {
        title: favorite
          ? "Remove this tab from Favorites"
          : "Add this tab to Favorites",
      }),
      chrome.contextMenus.update(MENU_CLOSE, {
        enabled: Boolean(favorite),
      }),
      chrome.contextMenus.update(MENU_RESET, {
        enabled: Boolean(favorite),
      }),
    ]);
  } catch {
    // Menus do not exist until onInstalled finishes creating them.
  }
}

async function activeTab() {
  const window = await targetNormalWindow();
  if (!window?.id) {
    return null;
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    windowId: window.id,
  });
  return tab ?? null;
}

async function favoriteForTab(tabId) {
  const favorites = await readFavorites();
  return favorites.find((favorite) => favorite.tabId === tabId) ?? null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTabReadyAtUrl(
  tabId,
  targetUrl,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let sawTargetNavigation = false;
  let latest = null;

  while (Date.now() < deadline) {
    try {
      latest = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }

    sawTargetNavigation ||= [latest.url, latest.pendingUrl].includes(targetUrl);
    if (sawTargetNavigation && latest.status === "complete") {
      return latest;
    }
    await delay(50);
  }
  return latest;
}

async function discardQuietly(tabId) {
  let latest = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      latest = await chrome.tabs.get(tabId);
      if (latest.active || (latest.discarded && !latest.audible)) {
        return latest;
      }
      if (latest.discarded) {
        return latest;
      }
      await chrome.tabs.discard(tabId);
      await delay(80 * (attempt + 1));
      latest = await chrome.tabs.get(tabId);
      if (latest.discarded && !latest.audible) {
        return latest;
      }
    } catch {
      return null;
    }
  }
  return latest;
}

async function targetNormalWindow(preferredWindowId = null) {
  if (preferredWindowId != null) {
    try {
      const preferred = await chrome.windows.get(preferredWindowId);
      if (preferred.type === "normal") {
        return preferred;
      }
    } catch {
      // Fall through to the most recently focused normal window.
    }
  }

  try {
    return await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
  } catch {
    const windows = await chrome.windows.getAll({
      windowTypes: ["normal"],
    });
    return windows[0] ?? null;
  }
}

async function createColdInstance(favorite, preferredWindowId = null) {
  const targetWindow = await targetNormalWindow(preferredWindowId);
  if (!targetWindow?.id) {
    return null;
  }

  let tab = await chrome.tabs.create({
    active: false,
    index: Math.max(0, favorite.order),
    pinned: true,
    url: coldUrl(favorite.id),
    windowId: targetWindow.id,
  });
  try {
    tab = await chrome.tabs.move(tab.id, {
      index: Math.max(0, favorite.order),
    });
  } catch {
    // Some Chromium variants already honor the requested creation index.
  }

  await patchFavorite(favorite.id, {
    state: "cold",
    tabId: tab.id,
    windowId: tab.windowId,
  });
  await waitForTabReadyAtUrl(tab.id, coldUrl(favorite.id));
  return (await discardQuietly(tab.id)) ?? tab;
}

async function replaceWithColdInstance(favorite, tab) {
  const replacement = await createColdInstance(
    { ...favorite, order: tab.index },
    tab.windowId,
  );
  if (!replacement?.id) {
    return null;
  }

  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    // The old media tab may already have closed after focus moved away.
  }
  try {
    const moved = await chrome.tabs.move(replacement.id, {
      index: tab.index,
    });
    await patchFavorite(favorite.id, { order: tab.index });
    return moved;
  } catch {
    return replacement;
  }
}

async function addFavorite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito || !isSupportedPageUrl(tab.url)) {
    throw new Error("Favorites support regular http and https pages.");
  }

  const favorites = await readFavorites();
  const current = favorites.find((favorite) => favorite.tabId === tab.id);
  if (current) {
    return current;
  }
  if (favorites.length >= MAX_FAVORITES) {
    throw new Error(`You can keep up to ${MAX_FAVORITES} Favorites.`);
  }

  const duplicate = favorites.find((favorite) => {
    return favorite.homeUrl === tab.url;
  });
  if (duplicate) {
    await openFavorite(duplicate.id);
    return duplicate;
  }

  const pinnedTab = await chrome.tabs.update(tab.id, { pinned: true });
  const favorite = {
    id: crypto.randomUUID(),
    homeUrl: pinnedTab.url,
    lastUrl: pinnedTab.url,
    title: pinnedTab.title || new URL(pinnedTab.url).hostname,
    faviconUrl: pinnedTab.favIconUrl || "",
    order: pinnedTab.index,
    createdAt: new Date().toISOString(),
    state: "warm",
    tabId: pinnedTab.id,
    windowId: pinnedTab.windowId,
  };

  await mutateFavorites((items) => {
    items.push(favorite);
    return favorite;
  });
  await notifyChanged();
  await syncContextMenus(pinnedTab);
  return favorite;
}

async function chooseAndActivateFallback(favorite, tabs) {
  if (!tabs.some((tab) => tab.id === favorite.tabId && tab.active)) {
    return;
  }

  const favorites = await readFavorites();
  const favoriteTabIds = new Set(
    favorites.map((item) => item.tabId).filter(Number.isInteger),
  );
  const fallback = chooseFallbackTab(
    tabs,
    favoriteTabIds,
    favorite.tabId,
  );

  if (fallback?.id != null) {
    await chrome.tabs.update(fallback.id, { active: true });
    return;
  }

  await chrome.tabs.create({
    active: true,
    windowId: favorite.windowId,
  });
}

async function closeFavorite(favoriteId) {
  const favorite = (await readFavorites()).find(
    (item) => item.id === favoriteId,
  );
  if (!favorite) {
    throw new Error("Favorite not found.");
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(favorite.tabId);
  } catch {
    // A native close can remove the old instance before this command settles.
  }
  if (!tab?.id) {
    const replacement = await createColdInstance(
      favorite,
      favorite.windowId,
    );
    if (!replacement?.id) {
      throw new Error("Open a Chrome window to close this Favorite.");
    }
    await notifyChanged();
    return;
  }

  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  await chooseAndActivateFallback(
    { ...favorite, tabId: tab.id, windowId: tab.windowId },
    tabs,
  );

  const replacement = await replaceWithColdInstance(favorite, tab);
  if (!replacement?.id) {
    throw new Error("Could not create a resting Favorite tab.");
  }
  await notifyChanged();
}

async function wakeFavorite(favorite) {
  if (!favorite.tabId) {
    return openFavorite(favorite.id);
  }

  await patchFavorite(favorite.id, { state: "warming" });
  try {
    const tab = await chrome.tabs.update(favorite.tabId, {
      active: true,
      pinned: true,
      url: favorite.homeUrl,
    });
    if (tab.status === "complete") {
      await patchFavorite(favorite.id, { state: "warm" });
    }
  } catch {
    await patchFavorite(favorite.id, {
      state: "cold",
      tabId: null,
      windowId: null,
    });
    return openFavorite(favorite.id);
  }
}

async function openFavorite(favoriteId) {
  const favorite = (await readFavorites()).find(
    (item) => item.id === favoriteId,
  );
  if (!favorite) {
    throw new Error("Favorite not found.");
  }

  let tab = null;
  if (favorite.tabId != null) {
    try {
      tab = await chrome.tabs.get(favorite.tabId);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    tab = await createColdInstance(favorite, favorite.windowId);
  }
  if (!tab?.id) {
    throw new Error("Open a Chrome window to use this Favorite.");
  }

  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });

  const latest = (await readFavorites()).find(
    (item) => item.id === favoriteId,
  );
  if (latest?.state === "cold") {
    await wakeFavorite(latest);
  }
}

async function resetFavorite(favoriteId) {
  const favorite = (await readFavorites()).find(
    (item) => item.id === favoriteId,
  );
  if (!favorite) {
    throw new Error("Favorite not found.");
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(favorite.tabId);
  } catch {
    tab = await createColdInstance(favorite, favorite.windowId);
  }
  if (!tab?.id) {
    throw new Error("Open a Chrome window to reset this Favorite.");
  }

  await patchFavorite(favorite.id, {
    state: "warming",
    tabId: tab.id,
    windowId: tab.windowId,
  });
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, {
    active: true,
    pinned: true,
    url: favorite.homeUrl,
  });
  await notifyChanged();
}

async function removeFavorite(favoriteId) {
  const favorite = (await readFavorites()).find(
    (item) => item.id === favoriteId,
  );
  if (!favorite) {
    return;
  }

  let tab = null;
  if (favorite.tabId != null) {
    try {
      tab = await chrome.tabs.get(favorite.tabId);
    } catch {
      // The Favorite may already be closed.
    }
  }

  await removeFavoriteRecord(favoriteId);

  if (tab?.id != null) {
    const wasCold =
      favorite.state === "cold" ||
      favoriteIdFromColdUrl(tab.url, extensionOrigin) === favorite.id;
    try {
      await chrome.tabs.update(tab.id, {
        pinned: false,
        ...(wasCold ? { url: favorite.homeUrl } : {}),
      });
    } catch {
      // The tab may have closed after its Favorite record was removed.
    }
  }
  await notifyChanged();
  await syncContextMenus(tab);
}

async function toggleActiveFavorite() {
  const tab = await activeTab();
  if (!tab?.id) {
    return;
  }
  const favorite = await favoriteForTab(tab.id);
  if (favorite) {
    await removeFavorite(favorite.id);
  } else {
    await addFavorite(tab.id);
  }
}

async function syncFavoriteOrder(windowId) {
  const pinnedTabs = await chrome.tabs.query({
    pinned: true,
    windowId,
  });
  const positionByTabId = new Map(
    pinnedTabs.map((tab) => [tab.id, tab.index]),
  );

  await mutateFavorites((favorites) => {
    for (const favorite of favorites) {
      const order = positionByTabId.get(favorite.tabId);
      if (order != null) {
        favorite.order = order;
        favorite.windowId = windowId;
      }
    }
  });
  await notifyChanged();
}

async function getSnapshot() {
  const favorites = await readFavorites();
  const tab = await activeTab();
  const activeFavorite =
    favorites.find((favorite) => favorite.tabId === tab?.id) ?? null;
  const commands = await chrome.commands.getAll();
  const closeCommand = commands.find(
    (command) => command.name === "close-favorite",
  );

  return {
    activeFavoriteId: activeFavorite?.id ?? null,
    activeTab: tab
      ? {
          id: tab.id,
          title: tab.title || "",
          url: tab.url || "",
        }
      : null,
    closeShortcut: closeCommand?.shortcut || "",
    favorites: sortFavorites(favorites),
    maxFavorites: MAX_FAVORITES,
  };
}

async function reconcileFavorites() {
  const favorites = await readFavorites();
  if (!favorites.length) {
    return;
  }

  const pinnedTabs = await chrome.tabs.query({ pinned: true });
  const matches = matchFavoritesToPinnedTabs(
    favorites,
    pinnedTabs,
    extensionOrigin,
  );

  await mutateFavorites((items) => {
    for (const match of matches) {
      const item = items.find(
        (candidate) => candidate.id === match.favorite.id,
      );
      if (!item) {
        continue;
      }
      item.state = match.state === "orphaned" ? "cold" : match.state;
      item.tabId = match.tab?.id ?? null;
      item.windowId = match.tab?.windowId ?? null;
      if (match.tab) {
        item.order = match.tab.index;
      }
    }
  });

  const latest = await readFavorites();
  for (const favorite of latest.filter(
    (item) => item.state === "cold" && item.tabId != null,
  )) {
    try {
      const tab = await chrome.tabs.get(favorite.tabId);
      const isSilentInstance =
        favoriteIdFromColdUrl(tab.url, extensionOrigin) === favorite.id;
      if (isSilentInstance) {
        await discardQuietly(tab.id);
      } else {
        await replaceWithColdInstance(favorite, tab);
      }
    } catch {
      // A concurrent window close will be recovered by the next reconciliation.
    }
  }

  for (const favorite of latest.filter((item) => item.tabId == null)) {
    await createColdInstance(favorite);
  }
  await notifyChanged();
}

async function installMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_TOGGLE,
    contexts: ["page"],
    title: "Add this tab to Favorites",
  });
  chrome.contextMenus.create({
    id: MENU_CLOSE,
    contexts: ["page"],
    enabled: false,
    title: "Close Favorite",
  });
  chrome.contextMenus.create({
    id: MENU_RESET,
    contexts: ["page"],
    enabled: false,
    title: "Reset Favorite to Home",
  });
  await syncContextMenus(await activeTab());
}

chrome.runtime.onInstalled.addListener(() => {
  return enqueueLifecycle(async () => {
    await installMenus();
    await reconcileFavorites();
  });
});

chrome.runtime.onStartup.addListener(() => {
  return enqueueLifecycle(reconcileFavorites);
});

chrome.windows.onCreated.addListener((window) => {
  if (window.type === "normal") {
    return enqueueLifecycle(reconcileFavorites);
  }
  return undefined;
});

// Firefox exposes contextMenus.onShown, while Chrome does not. Keep the
// optional hook for compatible Chromium variants and synchronize from tab
// lifecycle events below in Chrome.
chrome.contextMenus.onShown?.addListener((_info, tab) => {
  return syncContextMenus(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }
  const favorite = await favoriteForTab(tab.id);
  if (info.menuItemId === MENU_TOGGLE) {
    if (favorite) {
      await removeFavorite(favorite.id);
    } else {
      await addFavorite(tab.id);
    }
  }
  if (info.menuItemId === MENU_CLOSE && favorite) {
    await closeFavorite(favorite.id);
  }
  if (info.menuItemId === MENU_RESET && favorite) {
    await resetFavorite(favorite.id);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-favorite") {
    await toggleActiveFavorite();
    return;
  }
  if (command === "close-favorite") {
    const tab = await activeTab();
    const favorite = tab?.id ? await favoriteForTab(tab.id) : null;
    if (favorite) {
      await closeFavorite(favorite.id);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  await syncContextMenus(tab);

  const favorite = await favoriteForTab(tabId);
  if (!favorite) {
    return;
  }
  const isCold =
    favorite.state === "cold" ||
    favoriteIdFromColdUrl(tab.url, extensionOrigin) === favorite.id;
  if (isCold) {
    await wakeFavorite(favorite);
  }
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  const favorite = await favoriteForTab(tabId);
  if (!favorite) {
    return;
  }
  await syncFavoriteOrder(moveInfo.windowId);
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const favorite = await favoriteForTab(tabId);
  if (!favorite) {
    return;
  }
  await patchFavorite(favorite.id, {
    order: attachInfo.newPosition,
    windowId: attachInfo.newWindowId,
  });
  await syncFavoriteOrder(attachInfo.newWindowId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const favorite = await favoriteForTab(removedTabId);
  if (!favorite) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(addedTabId);
    await patchFavorite(favorite.id, {
      order: tab.index,
      tabId: addedTabId,
      windowId: tab.windowId,
    });
    await notifyChanged();
  } catch {
    // Reconciliation will recover the Favorite if replacement races a close.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const favorite = await favoriteForTab(tabId);
  if (!favorite) {
    return;
  }

  if (changeInfo.pinned === false) {
    await removeFavoriteRecord(favorite.id);
    const wasCold =
      favorite.state === "cold" ||
      favoriteIdFromColdUrl(tab.url, extensionOrigin) === favorite.id;
    if (wasCold) {
      try {
        await chrome.tabs.update(tabId, {
          url: favorite.homeUrl,
        });
      } catch {
        // The user may have closed the newly unpinned tab immediately.
      }
    }
    await notifyChanged();
    return;
  }

  const coldId = favoriteIdFromColdUrl(
    changeInfo.url || tab.url,
    extensionOrigin,
  );
  if (coldId === favorite.id) {
    await patchFavorite(favorite.id, {
      state: "cold",
      tabId,
      windowId: tab.windowId,
    });
    return;
  }

  const patch = {
    tabId,
    windowId: tab.windowId,
  };
  const isInternalHomeReset =
    favorite.state === "cold" &&
    !tab.active &&
    changeInfo.url === favorite.homeUrl;
  if (
    changeInfo.url &&
    isSupportedPageUrl(changeInfo.url) &&
    !isInternalHomeReset
  ) {
    patch.lastUrl = changeInfo.url;
    patch.state = "warm";
  }
  if (changeInfo.status === "complete" && favorite.state === "warming") {
    patch.state = "warm";
  }
  await patchFavorite(favorite.id, patch);
  await notifyChanged();
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const favorite = await favoriteForTab(tabId);
  if (!favorite) {
    return;
  }

  await patchFavorite(favorite.id, {
    state: "cold",
    tabId: null,
    windowId: null,
  });

  if (!removeInfo.isWindowClosing) {
    try {
      await createColdInstance(favorite, removeInfo.windowId);
    } catch {
      // A closing browser may make the destination window unavailable.
    }
  }
  await notifyChanged();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    "favorite:add": () => addFavorite(message.tabId),
    "favorite:close": () => closeFavorite(message.favoriteId),
    "favorite:open": () => openFavorite(message.favoriteId),
    "favorite:remove": () => removeFavorite(message.favoriteId),
    "favorite:reset": () => resetFavorite(message.favoriteId),
    "snapshot:get": () => getSnapshot(),
  };

  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }

  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Favorite action failed.",
      });
  });
  return true;
});
