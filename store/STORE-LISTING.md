# Chrome Web Store 上架材料 / Store listing

## 压缩包 / Package

`dist/x-likes-exporter-v0.2.0.zip`（上传到 Chrome Web Store「上传软件包」）

截图 / Screenshots（1280×800 PNG，符合商店要求）：

- `store/shot-panel.png` — 页面内的导出面板
- `store/shot-popup.png` — 工具栏弹窗

如需重出图：`python3 -m http.server 8765` 后用无头 Chrome 打开 `store/shot-*.html`
（`--lang=zh-CN` 出中文，`--lang=en-US` 出英文）。

---

## 简体中文

**名称**（≤45 字符）

> X 点赞导出 Markdown

**简短说明**（≤132 字符）

> 把 X(Twitter) 上点赞过的推文导出到本地 Markdown 文件，支持增量追加、按条数或日期范围筛选，数据不离开本机。

**详细说明**

把你在 X（Twitter）上点赞过的推文，一键导出为排版整洁的 Markdown 文件，方便存档、检索和做笔记。

主要功能：
• 增量导出：第一次选好 .md 文件，之后每次只往文件末尾追加新点赞的内容，不会重复
• 三种拉取范围：全部 / 限制条数 / 按发布日期区间筛选（结束日期默认为今天）
• 内容完整：作者、发布时间、正文全文、图片、视频链接、被引用的推文
• 10 种界面语言：简体中文、繁體中文、English、日本語、Español、Français、Deutsch、한국어、ไทย、Русский
• 支持输入用户名、@name 或个人页完整链接直达点赞页

工作原理与隐私：
• 扩展只在你自己打开的 x.com 点赞页上运行，读取的是页面自己加载的数据；不会向任何第三方服务器发送你的数据
• 导出结果直接写入你在本机选择的文件，全部数据保存在本地

使用方法：
1. 点击扩展图标，输入用户名（可留空自动识别），打开你的点赞页
2. 在页面右下角面板中「选择文件」并「开始导出」，保持标签页可见直到完成

**类别**：工作效率　**语言**：中文（简体/繁体）等 10 种

---

## English

**Name** (≤45 chars)

> X Likes to Markdown

**Short description** (≤132 chars)

> Export your X (Twitter) liked tweets to a local Markdown file. Incremental append, count or date-range filters. No data leaves your device.

**Detailed description**

Archive every tweet you liked on X (Twitter) as a clean, readable Markdown file — perfect for personal archives, search and note-taking.

Key features:
• Incremental export: pick a .md file once; afterwards only new likes are appended, never duplicated
• Three range modes: all / limited count / filter by tweet date range (end date defaults to today)
• Complete content: author, timestamp, full text, images, video links and quoted tweets
• 10 UI languages: English, 简体中文, 繁體中文, 日本語, Español, Français, Deutsch, 한국어, ไทย, Русский
• Open your likes page by username, @name or full profile URL

How it works & privacy:
• The extension only runs on the x.com likes page you open yourself and reads data the page already loads; nothing is sent to any third-party server
• Output is written directly to a local file you choose — all data stays on your device

How to use:
1. Click the extension icon, enter a username (or leave empty to auto-detect) and open your likes page
2. In the panel at the bottom right, "Choose file" then "Start export", keeping the tab visible until done

**Category**: Productivity　**Languages**: English + 9 more
