import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const failures = [];

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

async function expectFile(relativePath, reason) {
  try {
    await fs.access(path.join(root, relativePath));
  } catch {
    failures.push(`${relativePath} is missing (${reason})`);
  }
}

expect(manifest.manifest_version === 3, "manifest_version must be 3");
expect(
  manifest.background?.type === "module",
  "background service worker must be an ES module",
);
expect(
  manifest.permissions?.includes("tabs"),
  "tabs permission is required for pinned tab lifecycle",
);
expect(
  manifest.permissions?.includes("favicon"),
  "favicon permission is required for cold placeholders",
);
expect(
  !manifest.host_permissions,
  "host_permissions should stay absent; Favorites does not inspect page content",
);
const allowedPermissions = new Set([
  "contextMenus",
  "favicon",
  "storage",
  "tabs",
]);
for (const permission of manifest.permissions ?? []) {
  expect(
    allowedPermissions.has(permission),
    `unexpected permission requested: ${permission}`,
  );
}

const suggestedCommands = Object.values(manifest.commands ?? {}).filter(
  (command) => command.suggested_key,
);
expect(
  suggestedCommands.length <= 4,
  "Chrome permits at most four suggested command shortcuts",
);

await expectFile(
  manifest.background?.service_worker,
  "manifest background service worker",
);
await expectFile(
  manifest.action?.default_popup,
  "manifest action default popup",
);
for (const iconPath of Object.values(manifest.icons ?? {})) {
  await expectFile(iconPath, "manifest extension icon");
}
for (const iconPath of Object.values(
  manifest.action?.default_icon ?? {},
)) {
  await expectFile(iconPath, "toolbar action icon");
}
await expectFile("popup.css", "popup stylesheet");
await expectFile("popup.js", "popup module");
await expectFile("cold.html", "cold Favorite placeholder");
await expectFile("cold.css", "cold placeholder stylesheet");
await expectFile("cold.js", "cold placeholder module");
await expectFile("core.js", "shared state helpers");

if (failures.length) {
  console.error("Extension validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Extension manifest and referenced files are valid.");
}
