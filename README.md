# X Likes to Markdown

把 X(Twitter) 上点赞过的推文导出到本地 Markdown 文件，支持**增量追加**（同一个文件反复导出不会重复）。

## 安装

1. 打开 `chrome://extensions/`，右上角打开「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录
3. 固定扩展图标（可选）

需要 Chrome 111+（用到 Manifest V3 的主世界注入和 File System Access API）。

## 使用

1. 在 X 网页端登录，点扩展图标 → 填用户名（留空会自动尝试识别）→「打开点赞页」
2. 页面右下角出现面板：
   - **选择文件**：第一次弹窗让你挑一个 `.md`（比如 `~/Documents/x-likes.md`）。句柄会记住，之后一直往这个文件末尾追加
   - **最多条数**：默认 0 = 不限
   - **开始导出**：自动向下滚动加载，期间**保持这个标签页可见**（切走会自动暂停，切回来继续）
3. 结束/点「停止」后自动把新内容写入文件

输出格式：

```markdown
# X 点赞存档

## 导出批次 2026-09-24 15:04 · 新增 137 条

### 2025-05-12 22:03 · 张三 (@zhangsan)

推文正文

> 引用 李四 (@lisi)：
> 被引用的内容

- 图片 1: ![](https://pbs.twimg.com/media/xxx.jpg)
- 视频: [视频](https://video.twimg.com/xxx.mp4)

链接: https://x.com/zhangsan/status/1789012345678901234

---
```

## 原理

- **不自己调接口**：脚本运行在页面主世界，patch 了 `window.fetch` / `XMLHttpRequest`，直接读 X 网页端自己请求的 GraphQL 响应。因此不需要 Bearer Token、不拼接 queryId，X 换接口也不用跟着改。
- 解析用「递归找长得像推文的对象」，而不是写死 JSON 路径，结构微调时不容易全挂。
- 滚动由脚本驱动（默认 1.2s 一轮），X 自己翻页，脚本只负责收集。连续 12 轮无新增就判定到底。
- 写文件用 File System Access API，句柄存在 IndexedDB（站点 origin 下），已写过的推文 id 也记在 IndexedDB 里用于去重。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 右下角没有面板 | 确认地址是 `https://x.com/<用户名>/likes`；改过代码后要在扩展页点刷新，并硬刷新页面 |
| 面板出现但一直 0 条 | X 可能改了接口路径（不再是 `/i/api/graphql/`）。打开 DevTools 看 Network，确认 X 拉点赞数据的请求 URL，把 `app.js` 里的 `API_RE` 改掉 |
| 收集到很多条但写不进文件 | 浏览器重启后文件授权会失效，重新点「选择文件」授权一次即可 |
| 写入时报「不支持 File System Access API」 | 会自动降级为下载一个 `.md` 到下载目录 |
| 卡住不动 | 标签页在后台会被浏览器限流，切回该标签页即可继续 |
| 主世界脚本被 CSP 拦 | 目前 X 允许注入，若被拦，改用 `chrome.scripting.executeScript` 从扩展里注入（需要给 popup 加注入逻辑） |

## 目录

```
manifest.json
src/content/app.js   # 全部逻辑：抓包、解析、面板、写文件
src/popup/           # 图标弹窗：输入用户名并打开点赞页
```
