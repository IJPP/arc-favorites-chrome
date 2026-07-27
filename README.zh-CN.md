# Chrome Favorites

一个基于 Chrome 原生固定标签页（pinned tabs）实现的 Arc 风格 Favorites 原型。

[English README](README.md)

## 交互方式

- **设为 Favorite**：将当前页面 URL 登记为该 Favorite 固定的「主页」，并把标签页移入 Chrome 的固定标签区。
- **关闭 Favorite**：默认 macOS 快捷键为 `Option-W`。它会把焦点移到另一个标签页、用一个全新且静默的休眠标签替换原页面，并释放原页面的内存；固定图标和位置不会消失。
- 点击休眠的 Favorite 会直接打开保存的主页，不显示加载提示页。
- 点击仍在使用中的 Favorite，会保留当前页面、滚动位置和历史记录。
- **重置**：立即回到保存的主页。
- **移除**：取消登记为 Favorite 并取消固定，但不会关闭标签页。
- 若误用 `Command-W` 关闭，扩展会在 Chrome 关闭原标签后重新创建同一个静默的休眠标签。

本扩展不请求任何网站权限，也不会读取网页内容。它只保存 Favorite 的 URL、标题、favicon URL、排列顺序和当前标签页身份。

## 本地安装

1. 打开 `chrome://extensions`。
2. 开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择此 `arc-favorites-chrome` 文件夹。
5. 可选：打开 `chrome://extensions/shortcuts`，修改默认的 **关闭 Favorite** 快捷键。

## 使用方法

1. 打开一个普通的 `http` 或 `https` 网页。
2. 打开扩展弹窗，选择 **Make Favorite**。
3. 继续深入浏览该网站。
4. 按 `Option-W`，或在弹窗中选择 **Close Favorite**。
5. 点击 Chrome 固定标签区中的图标，它会从保存的主页打开。

网页右键菜单也提供添加/移除、关闭和重置操作。

## 验证

无需构建步骤或第三方依赖。

```sh
npm test
npm run validate
node --check favorites-background.js
node --check popup.js
node --check cold.js
```

## 已知的 Chrome 边界

Chrome 原生固定标签区中的是真实标签页，并且仅属于一个浏览器窗口。扩展无法像 Arc 的 Tab Handoff 一样，在每个窗口镜像同一个标签项。这个原型为每个 Favorite 维持一个活动实例，并在其失去归属时，把它恢复到最近使用的普通窗口中。
