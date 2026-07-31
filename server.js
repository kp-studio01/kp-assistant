// ============================================================
// KP SALES ASSISTANT — Demo Server v1
// Receives WhatsApp messages -> thinks with AI -> replies
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ---------- SETTINGS (come from environment variables) ----------
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;   // Meta access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // from API Setup page
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;       // any secret word you choose
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Upstash Redis (persistent memory, survives naps and restarts)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ---------- THE DEMO SHOP (later this comes from a real seller) ----------
const SHOP_PROFILE = `
You are "Amara", the sales assistant for KP Collections, a small Nigerian
online store that sells on WhatsApp. You text like a real Nigerian shop
girl chatting with a customer, not like an assistant or a chatbot. Never
use em dashes.

THE CATALOG (the ONLY products that exist — never invent others):
1. Plain white tee — N7,500
2. Black graphic hoodie — N18,000
3. Denim jacket — N25,000
4. Classic baseball cap — N5,000
5. Cargo joggers — N15,500

HOW YOU TEXT (this matters as much as what you say):
- Short bursts. Most replies are 1-2 sentences. Rarely go past 3.
- In casual back-and-forth, write prices the way people actually type them
  on WhatsApp: "18k", "25k", "7.5k". Switch to the full exact figure
  ("N18,000") only at the point of confirming delivery details, giving
  the final total, or writing out the bank transfer instructions, where
  precision actually matters.
- Emojis are rare, not a habit. Most messages have none. When you do use
  one, pick a single natural one, never stack multiple in one message.
- Do not end every message with a question. A real seller often just
  answers and lets the customer decide what to say next. Ask a follow-up
  only when it genuinely moves the conversation forward, not as a reflex.
- Mirror the customer's energy and register. If they write in pidgin,
  reply in pidgin. If they write short and dry, don't over-explain back.
  If they write formally, be a little more polished, but still human.
- Do not sound instantly available or overly eager on every single reply.
  It is fine to sound normal and a little understated, like someone who
  has other customers too.

RULES:
- Quote prices EXACTLY as listed (never change or guess a price), even
  when writing them the casual "18k" way.
- Delivery: Lagos N2,000 (1-2 days), outside Lagos N3,500 (2-4 days).
- Payment: bank transfer to KP Collections, GTBank 0123456789. Ask the
  customer to send a screenshot after transfer, and say the owner will
  confirm it shortly.
- Do NOT negotiate prices. If a customer pushes for a discount, politely
  hold the price and mention quality.
- If you are not sure about something (custom orders, complaints, refunds,
  anything outside the catalog), do NOT guess. Say the owner will reply
  shortly, and keep it warm.
- Never promise anything not listed here.
`;

// ---------- PERSISTENT MEMORY (Upstash Redis via REST) ----------
// Each customer's conversation is stored under key "conv:<phone_number>"
// as a JSON string, with a 30-day expiry so old chats don't pile up forever.

async function redisCommand(commandArray) {
  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commandArray),
  });
  const data = await response.json();
  if (data.error) console.error("Redis error:", data.error);
  return data.result;
}

async function getConversation(from) {
  try {
    const raw = await redisCommand(["GET", `conv:${from}`]);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("getConversation failed, starting fresh:", err);
    return [];
  }
}

async function saveConversation(from, history) {
  try {
    // EX 2592000 = expire after 30 days of no new messages
    await redisCommand(["SET", `conv:${from}`, JSON.stringify(history), "EX", "2592000"]);
  } catch (err) {
    console.error("saveConversation failed:", err);
  }
}

// ---------- 1) WEBHOOK VERIFICATION (Meta knocks, we answer) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified by Meta ✓");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- 2) INCOMING MESSAGES ----------
app.post("/webhook", async (req, res) => {
  // Always answer Meta fast so it doesn't retry
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== "text") return; // ignore statuses etc.

    const from = message.from;             // customer's number
    const text = message.text.body;        // what they said
    console.log(`Customer ${from}: ${text}`);

    // Load this customer's history from persistent memory
    let history = await getConversation(from);
    history.push({ role: "user", content: text });
    // keep only last 10 turns to stay light
    history = history.slice(-10);

    // ---------- 3) THINK (ask the AI brain) ----------
    const aiReply = await askAI(history);
    history.push({ role: "assistant", content: aiReply });

    // Save the updated history back to persistent memory
    await saveConversation(from, history);

    // ---------- 4) REPLY on WhatsApp ----------
    await sendWhatsApp(from, aiReply);
    console.log(`Amara -> ${from}: ${aiReply}`);
  } catch (err) {
    console.error("Error handling message:", err);
  }
});

// ---------- The AI call ----------
async function askAI(history) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SHOP_PROFILE,
      messages: history,
    }),
  });
  const data = await response.json();
  if (data?.content?.[0]?.text) return data.content[0].text;
  console.error("AI error:", JSON.stringify(data));
  return "Give me one second please, let me confirm that for you.";
}

// ---------- The WhatsApp send ----------
async function sendWhatsApp(to, text) {
  const response = await fetch(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  const data = await response.json();
  if (data.error) console.error("WhatsApp send error:", JSON.stringify(data.error));
}

// ---------- One-time fix: subscribe this app to the WhatsApp account ----------
const WABA_ID = process.env.WABA_ID || "1563052958833458"; // Test WhatsApp Business Account
app.get("/subscribe", async (req, res) => {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${WABA_ID}/subscribed_apps`,
      { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const data = await r.json();
    res.json(data); // {"success":true} means the mail will now be delivered
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Health check (visit in browser to see server is alive) ----------
app.get("/", (req, res) => {
  res.send("KP Sales Assistant is running ✓");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
