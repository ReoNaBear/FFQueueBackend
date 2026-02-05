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

const requireAdmin = (req, res, next) => {
  // 前端可以在 headers 帶 'x-admin-password' 或 body 帶 'password'
  const password = req.headers['x-admin-password'] || req.body.password;
  
  if (password === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ success: false, message: "權限不足：密碼錯誤" });
  }
};
// 2. 設定時間/公告
app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    await redis.set(KEYS.SETTINGS, JSON.stringify(settings));
    broadcast({ type: "settingsUpdate", settings });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. 更新商品列表 (上架/修改)
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { products } = req.body;
    console.log("API: 更新商品", products.length, "筆");
    await redis.set(KEYS.PRODUCTS, JSON.stringify(products));
    
    // 通知所有前端更新畫面
    broadcast({ type: "productsUpdate", products });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. 叫號 (下一位)
app.post("/api/admin/next", requireAdmin, async (req, res) => {
  try {
    const current = await redis.hincrby(KEYS.GLOBAL, "currentNumber", 1);
    console.log("API: 叫號更新:", current);
    
    broadcast({ type: "nextUpdate", current });
    res.json({ success: true, current });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. ★★★ 結帳 (核心功能) ★★★
app.post("/api/admin/checkout", requireAdmin, async (req, res) => {
  try {
    const { checkoutItems, orderInfo } = req.body;
    
    // 呼叫邏輯處理函數
    const result = await performCheckoutLogic(checkoutItems, orderInfo);
    
    if (result.success) {
      // 只有成功時才廣播庫存變動
      broadcast({ type: "productsUpdate", products: result.products });
      res.json({ success: true, message: "結帳成功" });
    } else {
      // 失敗 (如庫存不足) 回傳 400
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (e) {
    console.error("Checkout Error:", e);
    res.status(500).json({ success: false, message: "伺服器錯誤" });
  }
});

// 6. 重置隊伍 (危險操作)
app.post("/api/admin/reset", requireAdmin, async (req, res) => {
  try {
    await handleResetQueue(); // 呼叫原本的邏輯
    res.json({ success: true, message: "隊伍已重置" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7. 取得預選名單 (GET)
app.get("/api/admin/names", requireAdmin, async (req, res) => {
  try {
    const allNames = await redis.hgetall(KEYS.NAMES);
    res.json({ success: true, names: allNames });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 8. 取得歷史訂單 (GET)
app.get("/api/admin/history", requireAdmin, async (req, res) => {
  try {
    const historyRaw = await redis.lrange(KEYS.HISTORY, 0, -1);
    const history = historyRaw.map(item => JSON.parse(item));
    res.json({ success: true, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 9. 清除歷史訂單 (DELETE)
app.delete("/api/admin/history", requireAdmin, async (req, res) => {
  try {
    await redis.del(KEYS.HISTORY);
    // 通知前端(如果有在看歷史頁面的話)
    // ws.send... 這裡可以選擇性廣播，或者前端重新整理就好
    res.json({ success: true, message: "歷史紀錄已清除" });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
        case "submitSelection":
          await handleSubmitSelection(ws, clientId, data.cart);
          break;
        case "updateName":
          await handleUpdateName(ws, clientId, data.name);
          break;
        default:
          console.log("未知指令:", data.action);
      }
    } catch (e) {
      console.error("Error:", e);
    }
  });
});

async function getNames(ws, clientId) {
  const allNames = await redis.hgetall(KEYS.NAMES);
  ws.send(JSON.stringify({ type: "adminNamesData", names: allNames })); 
}

// --------
// ------------
// 邏輯處理函數
// --------------------
async function performCheckoutLogic(checkoutItems, orderInfo) {
  const productsRaw = await redis.get(KEYS.PRODUCTS);
  let products = productsRaw ? JSON.parse(productsRaw) : [];
  let isUpdated = false;
  let errorMessage = null;

  // 1. 檢查與扣庫存
  for (const item of checkoutItems) {
    const target = products.find(p => p.id === item.id);
    
    // 如果是純「斗內」項目 (沒有 ID 或 ID 是特殊的)，不需要扣庫存
    if (item.id === 'DONATE_999' || item.name === '斗內') {
        continue; 
    }

    if (!target) {
        // 如果找不到商品但又不是斗內，略過或報錯
        continue;
    }

    // 庫存檢查
    if (target.qty < item.checkoutQty) {
        errorMessage = `庫存不足: ${target.name} (剩餘: ${target.qty})`;
        break; // 中斷迴圈
    }

    // 執行扣庫存
    if (target.content) {
        // 組合商品邏輯
        let ingredientsEnough = true;
        // 檢查原料
        for (const [subId, subQty] of Object.entries(target.content)) {
            const subProduct = products.find(p => p.id == subId);
            if (!subProduct || subProduct.qty < (item.checkoutQty * subQty)) {
                ingredientsEnough = false;
                errorMessage = `原料不足: ${subProduct ? subProduct.name : '未知原料'}`;
                break;
            }
        }
        if (!ingredientsEnough) break;

        // 扣除
        target.qty = Math.max(0, target.qty - item.checkoutQty);
        Object.entries(target.content).forEach(([subId, subQty]) => {
            const subProduct = products.find(p => p.id == subId);
            subProduct.qty = Math.max(0, subProduct.qty - (item.checkoutQty * subQty));
        });
        isUpdated = true;

    } else {
        // 一般商品
        target.qty = Math.max(0, target.qty - item.checkoutQty);
        isUpdated = true;
    }
  }

  // 2. 如果有錯誤，回傳失敗
  if (errorMessage) {
      return { success: false, message: errorMessage };
  }

  // 3. 如果有更新，寫入 Redis 並記錄歷史
  if (isUpdated || checkoutItems.some(i => i.name === '斗內')) {
    // 即使只有斗內沒有扣庫存，也可能需要記錄歷史，這裡假設有扣庫存才更新 Redis Products
    if (isUpdated) {
        await redis.set(KEYS.PRODUCTS, JSON.stringify(products));
    }

    // 寫入歷史訂單
    const orderRecord = {
      id: Date.now(),
      timestamp: Date.now(),
      number: orderInfo.number,
      name: orderInfo.clientName || '未具名',
      items: checkoutItems,
      total: orderInfo.totalAmount
    };
    await redis.rpush(KEYS.HISTORY, JSON.stringify(orderRecord));
    
    // 回傳成功與新的商品狀態
    return { success: true, products };
  }

  return { success: true, products }; // 沒有變動也算成功
}

async function handleResetQueue() {
  await redis.del(KEYS.GLOBAL);
  await redis.del(KEYS.SELECTIONS);
  await redis.del(KEYS.NAMES);
  const clientKeys = await redis.keys(`${KEYS.CLIENT_PREFIX}*`);
  if (clientKeys.length > 0) await redis.del(...clientKeys);

  broadcast({ type: "forceReset" });
  broadcast({ type: "queueUpdate", queueCount: 0 });
  broadcast({ type: "nextUpdate", current: 0 });
}

async function handleUpdateName(ws, clientId, name) {
  const clientKey = `${KEYS.CLIENT_PREFIX}${clientId}`;
  const userData = await redis.hgetall(clientKey);
  
  if (userData && userData.number) {
    // 1. 更新 Redis
    await redis.hset(clientKey, "name", name);
    await redis.hset(KEYS.NAMES, userData.number, name);
    
    // 2. 回傳給該使用者 (確認更新成功)
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "updateMyNameSuccess", name }));
    }

    // 3. 廣播給 Admin (只廣播這一筆變動，減少流量)
    // 格式：{ type: "singleNameUpdate", number: "1", name: "小明" }
    broadcast({ 
        type: "singleNameUpdate", 
        number: userData.number, 
        name: name 
    });
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
  const [productsRaw, globalData, settingsRaw] = await Promise.all([
    redis.get(KEYS.PRODUCTS),
    redis.hgetall(KEYS.GLOBAL),
    redis.get(KEYS.SETTINGS)
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

async function handleCheckout(checkoutItems, orderInfo) {
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