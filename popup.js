import { hostnameFor, isSupportedPageUrl } from "./core.js";

const countNode = document.querySelector("#favorite-count");
const railNode = document.querySelector("#favorite-rail");
const currentNode = document.querySelector("#current-content");
const listNode = document.querySelector("#favorite-list");
const shortcutNode = document.querySelector("#close-shortcut");
const toastNode = document.querySelector("#toast");
const shortcutsButton = document.querySelector("#open-shortcuts");
const isPreview = new URLSearchParams(location.search).has("preview");

let snapshot = null;
let toastTimer = null;

const previewSnapshot = {
  activeFavoriteId: "preview-bilibili",
  activeTab: {
    id: 102,
    title: "哔哩哔哩",
    url: "https://www.bilibili.com/video/example",
  },
  closeShortcut: "⌥W",
  maxFavorites: 12,
  favorites: [
    {
      id: "preview-youtube",
      title: "YouTube",
      homeUrl: "https://youtube.com/",
      state: "warm",
    },
    {
      id: "preview-bilibili",
      title: "哔哩哔哩",
      homeUrl: "https://www.bilibili.com/",
      state: "warm",
    },
    {
      id: "preview-feishu",
      title: "飞书",
      homeUrl: "https://www.feishu.cn/",
      state: "cold",
    },
    {
      id: "preview-deepseek",
      title: "DeepSeek",
      homeUrl: "https://chat.deepseek.com/",
      state: "cold",
    },
    {
      id: "preview-gemini",
      title: "Gemini",
      homeUrl: "https://gemini.google.com/",
      state: "warm",
    },
  ],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function faviconUrl(homeUrl) {
  if (isPreview) {
    const host = hostnameFor(homeUrl);
    const hue = [...host].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
    const label = host.slice(0, 1).toUpperCase();
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
        <rect width="32" height="32" rx="9" fill="hsl(${hue} 72% 48%)"/>
        <text x="16" y="21" text-anchor="middle" font-family="system-ui" font-size="15" font-weight="700" fill="white">${label}</text>
      </svg>
    `;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", homeUrl);
  url.searchParams.set("size", "32");
  return url.href;
}

function showToast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.classList.remove("show");
  }, 2200);
}

async function request(message) {
  if (isPreview) {
    if (message.type === "snapshot:get") {
      return structuredClone(previewSnapshot);
    }
    showToast("Preview action");
    return null;
  }

  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Favorite action failed.");
  }
  return response.result;
}

function railMarkup(favorites, maxFavorites) {
  const items = favorites
    .map((favorite) => {
      return `
        <button
          class="rail-item"
          data-action="open"
          data-id="${escapeHtml(favorite.id)}"
          data-state="${escapeHtml(favorite.state)}"
          title="${escapeHtml(favorite.title)}"
          type="button"
        >
          <img alt="" src="${escapeHtml(faviconUrl(favorite.homeUrl))}" />
          <span class="state-dot"></span>
        </button>
      `;
    })
    .join("");

  const emptySlots =
    favorites.length === 0
      ? Math.min(6, maxFavorites)
      : favorites.length < maxFavorites
        ? 1
        : 0;
  const placeholders = Array.from({ length: emptySlots }, () => {
    return `<span class="rail-empty" aria-hidden="true">+</span>`;
  }).join("");

  return items + placeholders;
}

function currentMarkup(data) {
  const tab = data.activeTab;
  if (!tab) {
    return `<p class="empty-copy">Open a regular Chrome window to begin.</p>`;
  }

  const favorite = data.favorites.find(
    (item) => item.id === data.activeFavoriteId,
  );
  if (favorite) {
    return `
      <div class="current-row">
        <img
          class="current-icon"
          alt=""
          src="${escapeHtml(faviconUrl(favorite.homeUrl))}"
        />
        <div class="current-copy">
          <p class="current-title">${escapeHtml(favorite.title)}</p>
          <p class="current-subtitle">Home · ${escapeHtml(hostnameFor(favorite.homeUrl))}</p>
        </div>
        <button
          class="primary-button close"
          data-action="close"
          data-id="${escapeHtml(favorite.id)}"
          type="button"
        >Close Favorite</button>
      </div>
    `;
  }

  const supported = isSupportedPageUrl(tab.url);
  return `
    <div class="current-row">
      <div class="current-copy">
        <p class="current-title">${escapeHtml(tab.title || "Current tab")}</p>
        <p class="current-subtitle">${escapeHtml(supported ? hostnameFor(tab.url) : "This page cannot become a Favorite")}</p>
      </div>
      <button
        class="primary-button"
        data-action="add"
        data-tab-id="${escapeHtml(tab.id)}"
        ${supported ? "" : "disabled"}
        type="button"
      >Make Favorite</button>
    </div>
  `;
}

function listMarkup(favorites) {
  if (!favorites.length) {
    return `
      <div class="empty-state">
        <strong>Your top rail is ready.</strong>
        <p class="empty-copy">Make the current tab a Favorite to keep it pinned, warm, and easy to reset.</p>
      </div>
    `;
  }

  return favorites
    .map((favorite) => {
      const isCold = favorite.state === "cold";
      return `
        <article class="favorite-row">
          <div class="favorite-meta">
            <img
              class="favorite-icon"
              alt=""
              src="${escapeHtml(faviconUrl(favorite.homeUrl))}"
            />
            <div class="favorite-copy">
              <p class="favorite-title" title="${escapeHtml(favorite.title)}">
                ${escapeHtml(favorite.title)}
              </p>
              <p class="favorite-host">${escapeHtml(hostnameFor(favorite.homeUrl))}</p>
              <span class="status ${isCold ? "cold" : ""}">
                ${isCold ? "cold · starts at home" : "warm · keeps your place"}
              </span>
            </div>
          </div>
          <div class="favorite-actions">
            <button
              class="secondary-button"
              data-action="${isCold ? "open" : "close"}"
              data-id="${escapeHtml(favorite.id)}"
              type="button"
            >${isCold ? "Open" : "Close"}</button>
            <button
              class="icon-button"
              data-action="reset"
              data-id="${escapeHtml(favorite.id)}"
              title="Reset to home"
              type="button"
            >↺</button>
            <button
              class="icon-button remove"
              data-action="remove"
              data-id="${escapeHtml(favorite.id)}"
              title="Remove Favorite and unpin the tab"
              type="button"
            >−</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function render(data) {
  snapshot = data;
  countNode.textContent = `${data.favorites.length} / ${data.maxFavorites}`;
  railNode.innerHTML = railMarkup(data.favorites, data.maxFavorites);
  currentNode.innerHTML = currentMarkup(data);
  listNode.innerHTML = listMarkup(data.favorites);
  shortcutNode.textContent = data.closeShortcut || "Set shortcut";
}

async function refresh() {
  try {
    render(await request({ type: "snapshot:get" }));
  } catch (error) {
    showToast(error.message);
  }
}

async function runAction(target) {
  const action = target.dataset.action;
  const favoriteId = target.dataset.id;
  target.disabled = true;

  const messages = {
    add: {
      type: "favorite:add",
      tabId: Number(target.dataset.tabId),
    },
    close: {
      type: "favorite:close",
      favoriteId,
    },
    open: {
      type: "favorite:open",
      favoriteId,
    },
    remove: {
      type: "favorite:remove",
      favoriteId,
    },
    reset: {
      type: "favorite:reset",
      favoriteId,
    },
  };

  try {
    await request(messages[action]);
    await refresh();
  } catch (error) {
    target.disabled = false;
    showToast(error.message);
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target) {
    runAction(target);
  }
});

shortcutsButton.addEventListener("click", async () => {
  if (isPreview) {
    showToast("Shortcut settings open from the installed extension.");
    return;
  }
  await chrome.tabs.create({
    url: "chrome://extensions/shortcuts",
  });
  window.close();
});

if (!isPreview) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "favorites:changed") {
      refresh();
    }
  });
}

refresh();
