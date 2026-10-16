# FORK 記錄

本 Repo 是 [JS-PACKAGE/LINE.js](https://github.com/JS-PACKAGE/LINE.js) 的 fork (origin: wuzkkavin/LINE.js, upstream: JS-PACKAGE/LINE.js), 基線 v1.6.5 (commit 8f1e481)。

## 上游檔案修改清單

- 階段二 (helper 伴隨模組): **上游檔案零修改**。所有新功能都在 `helper/` 資料夾內, 透過上游既有的 `/api/ws` 機器人接口連接, 因此沒有任何掛鉤點需要記錄。
- 若日後必須修改上游檔案, 在此逐項記錄: 檔案路徑、修改內容、原因、對應的上游版本, 方便同步時逐項核對。

## 同步注意

- `helper/package.json` 的 `ws` 版本 (8.22.0) 與上游釘選一致; 上游若升版, 同步時一併檢查。
- `helper/data/`、`helper/node_modules/` 不入版控 (見 helper/.gitignore)。
