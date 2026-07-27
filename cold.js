import { STORAGE_KEY, hostnameFor, normalizeFavorites } from "./core.js";

const params = new URLSearchParams(location.search);
const favoriteId = params.get("id");
const titleNode = document.querySelector("#title");
const hostNode = document.querySelector("#host");
const faviconNode = document.querySelector("#favicon");

async function render() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const favorite = normalizeFavorites(stored[STORAGE_KEY]).find(
    (item) => item.id === favoriteId,
  );

  if (!favorite) {
    document.title = "Favorite removed";
    titleNode.textContent = "Favorite removed";
    hostNode.textContent = "This resting tab is no longer registered.";
    return;
  }

  const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
  faviconUrl.searchParams.set("pageUrl", favorite.homeUrl);
  faviconUrl.searchParams.set("size", "32");

  const tab = await chrome.tabs.getCurrent();
  if (tab?.active) {
    location.replace(favorite.homeUrl);
    return;
  }

  document.title = favorite.title;
  titleNode.textContent = favorite.title;
  hostNode.textContent = `${hostnameFor(favorite.homeUrl)} · resting · opens at Home`;
  faviconNode.href = faviconUrl.href;
}

render();
