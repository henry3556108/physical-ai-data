# physical-ai-data：遠端都更挖土機（Hackathon）

用遊戲化的方式操作重型機械：玩家付費玩，同時替我們產生真實世界的遙控操作數據。

## 階段藍圖
1. 娛樂：咖啡廳 / VR 體驗開重機，賺營收、蒐集操作數據
2. 遠端：解決通訊延遲，遠端操作外地工地機具
3. 生產：玩家經篩選、培訓、考照後成為遠端工人
4. 飛輪：持續累積 real world data，拿去訓練自主重機 AI

## Demo（無硬體）

線上：https://physical-ai-data.senseharbor.dev/game/ ・ [後台](https://physical-ai-data.senseharbor.dev/dashboard/) ・ [waitlist](https://physical-ai-data.senseharbor.dev/waitlist/)

內網：http://192.168.0.198:8400 （systemd 服務 `excavator`，部署說明在 `/root/deploy/excavator/README.md`）

| 路徑 | 內容 |
|---|---|
| `game/` | 第一人稱駕駛艙視角的 3D 拆除遊戲。Three.js＋Rapier 物理：手臂是由關節角度驅動的運動學剛體（模擬液壓遲滯、負載降速、挖斗不能鑽地），建築是一塊塊磚堆起來的，會照物理倒塌。有打擊感（鏡頭震動、粉塵、合成音效、手把／手機震動）、星等、排行榜、隨機寶物（鏟進卡車加分）、可調的模擬通訊延遲 |
| `pad/` | 手機遙控器：掃遊戲畫面的 QR code，手機變成 ISO 配置的雙搖桿。WebSocket 30Hz 送出，遊戲端 400ms 沒收到訊號就自動放開搖桿 |
| `dashboard/` | 即時遙測後台（SSE）：指令和實際動作的落差、輸入延遲、液壓負載、挖斗俯視軌跡、事件流、排行榜、各場次匯出 JSON／CSV |
| `waitlist/` | Waiting list 報名頁（email、姓名、生日），管理端匯出要 token |
| `pitch/` | 簡報（還沒做） |
| `server.js` | 零框架 Node server：靜態檔、遙測 API、SSE、WebSocket 遙控轉送、QR code |

本機開發：`npm install && PORT=8411 DATA_DIR=/tmp/exc node server.js`

### 操作（ISO 配置）
- 左搖桿：`A`/`D` 迴轉、`W`/`S` 小臂伸出／收回
- 右搖桿：`I`/`K` 大臂下降／上升、`J`/`L` 收斗／倒斗
- 履帶：方向鍵；`V` 切第三人稱（除錯）；`[` `]` 調延遲；右鍵拖曳轉頭；拆除率 75% 後 `Enter` 收工

### 遙測欄位（每秒 20 筆）
`t, src, latencyMs, in*`（玩家原始輸入）`, d*`（延遲後送達機具的輸入）`, swing/boom/arm/bucket`（實際角度°）`, tgt*`（無延遲理想角度°）`, tip XYZ, base XZ, heading, load, impulse(kN)`，另有事件（撞擊、拆除進度、寶物、附帶損害、延遲調整、手機連線）。
