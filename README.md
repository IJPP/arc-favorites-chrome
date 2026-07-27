# Favorites for Chrome

An Arc-style Favorites prototype built on Chrome's native pinned tabs.

## The interaction

- **Make Favorite** registers the current page's URL as its permanent Home and
  moves the tab into Chrome's pinned area.
- **Close Favorite** (`Option-W` by default on macOS) moves focus to another tab,
  replaces the old media session with a fresh, silent resting tab, and discards
  it from memory. Its pinned site icon and position never disappear.
- Clicking a cold Favorite transitions straight to its saved Home URL. The
  resting page contains no visible loading/status message.
- Clicking a warm Favorite keeps the current page, scroll position, and history.
- **Reset** returns a Favorite to Home immediately.
- **Remove** unregisters the Favorite and unpins its tab without closing it.
- If `Command-W` is used accidentally, the extension recreates the same silent
  resting tab after Chrome closes the original.

The extension intentionally requests no host permissions and never reads page
content. It stores only the Favorite's URL, title, favicon URL, order, and current
tab identity.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `arc-favorites-chrome` directory.
5. Optional: open `chrome://extensions/shortcuts` to change the default
   **Close Favorite** shortcut.

## Use it

1. Open a normal `http` or `https` page.
2. Open the extension popup and choose **Make Favorite**.
3. Browse deeper into the site.
4. Press `Option-W` or choose **Close Favorite** in the popup.
5. Click its icon in Chrome's pinned row. It opens from the saved Home URL.

The page context menu also provides Add/Remove, Close, and Reset actions.

## Validate

No build step or third-party packages are required.

```sh
npm test
npm run validate
node --check favorites-background.js
node --check popup.js
node --check cold.js
```

## Known Chrome boundary

Chrome's native pinned row contains real tabs and is scoped to one browser
window. An extension cannot mirror a single tab entry into every window the way
Arc's Tab Handoff does. This prototype keeps one live instance for each Favorite
and restores orphaned Favorites into the most recently focused normal window.
