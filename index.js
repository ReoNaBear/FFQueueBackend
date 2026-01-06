import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch"; 
import cors from "cors";
import dotenv from "dotenv"; // 建議安裝: npm install dotenv

dotenv.config(); // 讀取 .env 檔案

const app = express();
app.use(cors());
app.use(express.json()); // ★★★ 必須加入這行，才能讀取 POST 的 body ★★★

const server = createServer(app);
const wss = new WebSocketServer({ server });

// 建議改用環境變數，若沒有則使用預設值
const REDIS_URL = process.env.REDIS_URL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD // 後台密碼

const redis = new Redis(REDIS_URL);

const KEYS = {
  PRODUCTS: "queue:products",
  GLOBAL: "queue:global",
  CLIENT_PREFIX: "queue:client:",
  SELECTIONS: "queue:selections",
  SETTINGS: "queue:settings",
  NAMES: "queue:names",
  HISTORY: "queue:history"
};

// --------------------
// ★★★ 新增：後台登入 API ★★★
// --------------------
app.post("/api/admin-login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, message: "登入成功" });
  } else {
    res.status(401).json({ success: false, message: "密碼錯誤" });
  }
});

// --------------------
// WebSocket 邏輯
// --------------------
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      const clientId = data.clientId;
      if (!clientId) return;

      switch (data.action) {
        case "adminSetSettings":
          await handleSetSettings(data.settings);
          break;
        case "adminResetQueue":
          await handleResetQueue();
          break;
        case "joinQueue":
          await handleJoinQueue(ws, clientId);
          break;
        case "redrawTicket":
          await handleRedrawTicket(ws, clientId);
          break;
        case "updateCart":
          const cartRaw = JSON.stringify(data.cart || {});
          const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
          await redis.hset(clientKey, "cart", cartRaw);
          await redis.expire(clientKey, 86400); // ★★★ 延長壽命 24h
          break;
        case "getInitialData":
          await sendInitialData(ws, clientId);
          break;
        case "adminUpdateProducts":
          console.log("收到更新商品請求:", data.products.length, "筆資料");
          await redis.set(KEYS.PRODUCTS, JSON.stringify(data.products));
          broadcast({ type: "productsUpdate", products: data.products });
          break;
        case "adminNext":
          // 確保即使沒有值也能從 1 開始
          const current = await redis.hincrby(KEYS.GLOBAL, "currentNumber", 1);
          console.log("叫號更新:", current);
          broadcast({ type: "nextUpdate", current });
          break;
        case "adminCheckout":
          await handleCheckout(data.checkoutItems, data.orderInfo);
          break;
        case "submitSelection":
          await handleSubmitSelection(ws, clientId, data.cart);
          break;
          case "updateName":
          await handleUpdateName(ws, clientId, data.name);
          break;
        case "getHistory":
          await sendHistoryData(ws);
          break;
        case "clearHistory":
          await redis.del(KEYS.HISTORY);
          ws.send(JSON.stringify({ type: "historyCleared" }));
          break;
        default:
          console.log("未知指令:", data.action);
      }
    } catch (e) {
      console.error("Error:", e);
    }
  });
});

// --------------------
// 邏輯處理函數
// --------------------
// 時間處理設定變更
async function handleSetSettings(settings) {
    // 儲存設定到 Redis
    await redis.set(KEYS.SETTINGS, JSON.stringify(settings));
    // 廣播給所有人更新設定 (Client 端需要知道時間變了)
    broadcast({ type: "settingsUpdate", settings });
}

// 處理重置隊伍
async function handleResetQueue() {
    // 1. 清除全域計數器
    await redis.del(KEYS.GLOBAL);
    
    // 2. 清除所有預選單
    await redis.del(KEYS.SELECTIONS);
    await redis.del(KEYS.NAMES);

    // 3. 清除所有 Client 資料 (比較暴力的做法，但最乾淨)
    // 取得所有 client key
    const clientKeys = await redis.keys(`${KEYS.CLIENT_PREFIX}*`);
    if (clientKeys.length > 0) {
        await redis.del(...clientKeys);
    }

    // 4. 廣播「重置」訊號，叫所有前端清空自己
    broadcast({ type: "forceReset" });
    
    // 5. 廣播最新的隊伍狀態 (歸零)
    broadcast({ type: "queueUpdate", queueCount: 0 });
    broadcast({ type: "nextUpdate", current: 0 });
}

async function handleUpdateName(ws, clientId, name) {
  const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
  const userData = await redis.hgetall(clientKey);
  
  if (userData && userData.number) {
    // 存入 user 資料
    await redis.hset(clientKey, "name", name);
    // 存入號碼對照表 (方便 Admin 快速查詢)
    await redis.hset(KEYS.NAMES, userData.number, name);
    
    // 廣播給 Admin 更新名字顯示
    const allNames = await redis.hgetall(KEYS.NAMES);
    broadcast({ type: "namesUpdate", names: allNames });
  }
}

async function handleJoinQueue(ws, clientId) {
  const settingsRaw = await redis.get(KEYS.SETTINGS);
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
  
  // 檢查是否已到開始時間
  if (settings.startTime) {
      const now = Date.now();
      const start = new Date(settings.startTime).getTime();
      if (now < start) {
          // 時間未到，回傳錯誤或特定狀態
          ws.send(JSON.stringify({ 
              type: "error", 
              message: "活動尚未開始，請稍候！" 
          }));
          return;
      }
  }

  const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
  const [userData, currentNumberStr] = await Promise.all([
    redis.hgetall(clientKey),
    redis.hget(KEYS.GLOBAL, "currentNumber")
  ]);
  const currentNumber = Number(currentNumberStr || 0);
  let needNewTicket = true;
  let myNumber, myCart = {}, isSubmitted = false;

  if (userData && userData.number) {
    const oldNumber = Number(userData.number);

    if (oldNumber >= currentNumber) {
      myNumber = oldNumber;
      myCart = userData.cart ? JSON.parse(userData.cart) : {};
      isSubmitted = userData.isSubmitted === "1";
      needNewTicket = false; // 不需要新號碼
    }
  } 
  if (needNewTicket) {
    myNumber = await redis.hincrby(KEYS.GLOBAL, "totalCount", 1);
    await redis.hset(clientKey, {
      number: myNumber,
      cart: "{}",
      isSubmitted: "0",
      joinedAt: Date.now()
    });
    await redis.expire(clientKey, 86400); // ★★★ 設定 24小時後自動刪除
    broadcastQueueCount();
  }

  ws.send(JSON.stringify({ type: "joinResult", myNumber, myCart, isSubmitted }));
}

async function handleRedrawTicket(ws, clientId) {
  const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
  const oldNumber = await redis.hget(clientKey, "number");
  if (oldNumber) await redis.hdel(KEYS.SELECTIONS, oldNumber);

  const newNumber = await redis.hincrby(KEYS.GLOBAL, "totalCount", 1);
  await redis.hset(clientKey, { number: newNumber, cart: "{}", isSubmitted: "0", updatedAt: Date.now() });
  await redis.expire(clientKey, 86400); // ★★★ 延長壽命
  
  broadcastQueueCount();
  ws.send(JSON.stringify({ type: "joinResult", myNumber: newNumber, myCart: {}, isSubmitted: false }));
}

async function handleSubmitSelection(ws, clientId, incomingCart) { // ★★★ 接收 ws 參數
  const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
  const userData = await redis.hgetall(clientKey);

  if (userData && userData.number) {
    let cartToSave = "{}";
    if (incomingCart) {
        cartToSave = JSON.stringify(incomingCart);
        // 順便更新 User 自己的紀錄，確保一致性
        await redis.hset(clientKey, "cart", cartToSave);
    } else if (userData.cart) {
        cartToSave = userData.cart;
    }

    // 更新狀態
    await redis.hset(clientKey, "isSubmitted", "1");
    
    // 寫入 Selections (給 Admin 看的)
    await redis.hset(KEYS.SELECTIONS, userData.number, cartToSave);
    
    // 廣播給所有人更新清單
    const allSelections = await getParsedSelections();
    broadcast({ type: "selectionUpdate", selections: allSelections });

    // 發送「操作成功」給該使用者
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ 
        type: "actionSuccess", 
        action: "submitSelection",
        message: "預選清單已成功送達伺服器！" 
      }));
    }
  }
}

async function sendInitialData(ws, clientId) {
  const [productsRaw, globalData, settingsRaw, allNames] = await Promise.all([
    redis.get(KEYS.PRODUCTS),
    redis.hgetall(KEYS.GLOBAL),
    redis.get(KEYS.SETTINGS),
    redis.hgetall(KEYS.NAMES) // ★ 讀取名字
  ]);
  
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
  const allSelections = await getParsedSelections();

  const products = productsRaw ? JSON.parse(productsRaw) : [];
  const queueCount = Number(globalData?.totalCount || 0);
  const currentNumber = Number(globalData?.currentNumber || 0);

  let myState = null;
  if (clientId) {
      const userData = await redis.hgetall(`${KEYS.CLIENT_PREFIX}${clientId}`);
      if (userData && userData.number) {
          myState = {
              myNumber: Number(userData.number),
              myName: userData.name || "",
              myCart: userData.cart ? JSON.parse(userData.cart) : {},
              isSubmitted: userData.isSubmitted === "1"
          };
      }
  }

  ws.send(JSON.stringify({
    type: "initialData",
    products,
    queueCount,
    currentNumber,
    clientSelections: allSelections, 
    clientNames: allNames,
    myState,
    settings
  }));
}

// ★ 新增：傳送歷史資料
async function sendHistoryData(ws) {
  // lrange 0 -1 取出全部
  const historyRaw = await redis.lrange(KEYS.HISTORY, 0, -1);
  const history = historyRaw.map(item => JSON.parse(item));
  ws.send(JSON.stringify({ type: "historyData", history }));
}

// ★★★ 輔助函數：解析 Redis Hash 中的 JSON 字串 ★★★
async function getParsedSelections() {
  const raw = await redis.hgetall(KEYS.SELECTIONS);
  const parsed = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      parsed[key] = JSON.parse(value);
    } catch (e) {
      parsed[key] = {};
    }
  }
  return parsed;
}

async function handleCheckout(checkoutItems) {
  const productsRaw = await redis.get(KEYS.PRODUCTS);
  let products = productsRaw ? JSON.parse(productsRaw) : [];
  let isUpdated = false;

  checkoutItems.forEach(item => {
    const target = products.find(p => p.id === item.id);
    
    // 基本檢查：庫存夠才能買
    if (target && item.checkoutQty > 0 && target.qty >= item.checkoutQty) {
        
        // 情境 A: 這是組合商品
        if (target.content) {
            // 1. 檢查所有原料夠不夠扣 (雙重保險)
            let ingredientsEnough = true;
            Object.entries(target.content).forEach(([subId, subQty]) => {
                const subProduct = products.find(p => p.id == subId);
                const required = item.checkoutQty * subQty;
                if (!subProduct || subProduct.qty < required) {
                    ingredientsEnough = false;
                }
            });

            if (ingredientsEnough) {
                // 2. 扣除組合包「自己」的庫存
                target.qty = Math.max(0, target.qty - item.checkoutQty);

                // 3. 扣除「原料」的庫存
                Object.entries(target.content).forEach(([subId, subQty]) => {
                    const subProduct = products.find(p => p.id == subId);
                    const deductAmount = item.checkoutQty * subQty;
                    subProduct.qty = Math.max(0, subProduct.qty - deductAmount);
                });
                isUpdated = true;
            }
        } 
        // 情境 B: 普通商品
        else {
            target.qty = Math.max(0, target.qty - item.checkoutQty);
            isUpdated = true;
        }
    }
  });

  if (isUpdated) {
    await redis.set(KEYS.PRODUCTS, JSON.stringify(products));
    broadcast({ type: "productsUpdate", products });
    
    // ★★★ 寫入歷史訂單 ★★★
    const orderRecord = {
      id: Date.now(), // 訂單編號
      timestamp: Date.now(),
      number: orderInfo.number,
      name: orderInfo.clientName || '未具名',
      items: checkoutItems,
      total: orderInfo.totalAmount
    };
    // RPUSH 加到列表尾端
    await redis.rpush(KEYS.HISTORY, JSON.stringify(orderRecord));
  }
}

async function broadcastQueueCount() {
  const count = await redis.hget(KEYS.GLOBAL, "totalCount");
  broadcast({ type: "queueUpdate", queueCount: Number(count) });
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

// --------------------
// 伺服器保活機制 (Keep-Alive)
// --------------------

// 1. WebSocket 心跳檢測 (每 30 秒移除斷線者)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

// 2. Render 免費方案自我 Ping (防止休眠)
// 請在 Render 環境變數設定 RENDER_EXTERNAL_URL
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || "http://localhost:3000"; 
setInterval(async () => {
    try {
        // 這裡只是一個簡單的請求，確保 Server 有在動
        // 建議在 express 加一個簡單的 router
        await fetch(RENDER_URL); 
        console.log("Keep-Alive ping sent.");
    } catch (err) {
        // 忽略錯誤，可能是還沒啟動或網路問題
    }
}, 14 * 60 * 1000); // 每 14 分鐘 ping 一次 (Render 休眠時間約 15 分鐘)

// Express 簡單路由 (給 Ping 用)
app.get("/", (req, res) => {
    res.send("Server is running...");
});

// 啟動 Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));