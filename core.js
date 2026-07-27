export const STORAGE_KEY = "arcFavorites.v1";
export const MAX_FAVORITES = 12;
export const COLD_PAGE = "cold.html";

export function isSupportedPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostnameFor(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function coldUrlFor(extensionOrigin, favoriteId) {
  const url = new URL(COLD_PAGE, extensionOrigin);
  url.searchParams.set("id", favoriteId);
  return url.href;
}

export function favoriteIdFromColdUrl(value, extensionOrigin) {
  try {
    const url = new URL(value);
    const expected = new URL(COLD_PAGE, extensionOrigin);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return null;
    }
    return url.searchParams.get("id");
  } catch {
    return null;
  }
}

export function sortFavorites(favorites) {
  return [...favorites].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function chooseFallbackTab(tabs, favoriteTabIds, excludedTabId) {
  return tabs
    .filter((tab) => {
      return (
        tab.id !== excludedTabId &&
        !favoriteTabIds.has(tab.id) &&
        !tab.incognito
      );
    })
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? 1 : -1;
      }
      return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
    })[0];
}

export function matchFavoritesToPinnedTabs(
  favorites,
  pinnedTabs,
  extensionOrigin,
) {
  const usedTabIds = new Set();
  return sortFavorites(favorites).map((favorite) => {
    const exactId = pinnedTabs.find((tab) => {
      return tab.id === favorite.tabId && !usedTabIds.has(tab.id);
    });

    const coldPage = pinnedTabs.find((tab) => {
      return (
        !usedTabIds.has(tab.id) &&
        favoriteIdFromColdUrl(tab.url, extensionOrigin) === favorite.id
      );
    });

    const rememberedUrl = pinnedTabs.find((tab) => {
      return (
        !usedTabIds.has(tab.id) &&
        [favorite.lastUrl, favorite.homeUrl].includes(tab.url)
      );
    });

    const match = exactId ?? coldPage ?? rememberedUrl ?? null;
    if (match?.id != null) {
      usedTabIds.add(match.id);
    }

    return {
      favorite,
      tab: match,
      state:
        match &&
        (favoriteIdFromColdUrl(match.url, extensionOrigin) === favorite.id ||
          (favorite.state === "cold" && match.url === favorite.homeUrl))
          ? "cold"
          : match
            ? "warm"
            : "orphaned",
    };
  });
}

export function normalizeFavorites(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return sortFavorites(
    value
      .filter((item) => {
        return (
          item &&
          typeof item.id === "string" &&
          typeof item.homeUrl === "string" &&
          isSupportedPageUrl(item.homeUrl)
        );
      })
      .map((item, index) => ({
        id: item.id,
        homeUrl: item.homeUrl,
        lastUrl: isSupportedPageUrl(item.lastUrl)
          ? item.lastUrl
          : item.homeUrl,
        title: item.title || hostnameFor(item.homeUrl),
        faviconUrl: item.faviconUrl || "",
        order: Number.isFinite(item.order) ? item.order : index,
        createdAt: item.createdAt || new Date(0).toISOString(),
        state: ["cold", "warming", "warm"].includes(item.state)
          ? item.state
          : "cold",
        tabId: Number.isInteger(item.tabId) ? item.tabId : null,
        windowId: Number.isInteger(item.windowId) ? item.windowId : null,
      })),
  );
}
