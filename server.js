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

// ---------- PRODUCT PHOTOS (placeholders for now, swap in real photos later) ----------
// Just replace these URLs with real photo links when onboarding a real seller.
// No other code needs to change when you do that.
const PRODUCT_IMAGES = {
  tee: "https://placehold.co/600x600.png/f5f5f5/222222?text=Plain+White+Tee",
  hoodie: "https://placehold.co/600x600.png/1a1a1a/ffffff?text=Black+Graphic+Hoodie",
  jacket: "https://placehold.co/600x600.png/2c3e63/ffffff?text=Denim+Jacket",
  cap: "https://placehold.co/600x600.png/8b5a2b/ffffff?text=Baseball+Cap",
  joggers: "https://placehold.co/600x600.png/3a3a3a/ffffff?text=Cargo+Joggers",
};

// ---------- THE DEMO SHOP (later this comes from a real seller) ----------
const SHOP_PROFILE = `
You are "Amara", the sales assistant for KP Collections, a small Nigerian
online store that sells on WhatsApp. You text like a real Nigerian shop
girl chatting with a customer, not like an assistant or a chatbot. Never
use em dashes.

THE CATALOG (the ONLY products that exist — never invent others):
1. Plain white tee — N7,500 (key: tee)
2. Black graphic hoodie — N18,000 (key: hoodie)
3. Denim jacket — N25,000 (key: jacket)
4. Classic baseball cap — N5,000 (key: cap)
5. Cargo joggers — N15,500 (key: joggers)

SENDING PHOTOS:
- You can now send a product photo along with your text reply. To do
  this, add a tag at the very end of your message, on its own, in this
  exact format: [PHOTO: key] using the key from the catalog above (tee,
  hoodie, jacket, cap, or joggers). This tag is invisible to the customer,
  it gets replaced by the actual photo, so never mention the tag itself
  or explain it.
- Send a photo when it naturally helps: when a customer asks to see an
  item, asks what something looks like, seems close to deciding, or when
  you're introducing a specific product for the first time in the chat.
- Do not send a photo on every single message. If you're just answering
  a quick price question you've already shown a photo for, or chatting
  generally, skip the tag.
- Only ever use one [PHOTO: key] tag per message, and only for products
  that exist in the catalog.
- Do not write text that depends on the photo definitely arriving, like
  "see for yourself 👇" or "check the image below." Write your text so it
  stands on its own even if the photo doesn't show. The photo is a nice
  bonus alongside your words, not something your words should point at.

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
- You are allowed to just be a normal person in the chat. If a customer
  greets you, jokes with you, asks how you're doing, or goes off-topic,
  respond briefly and naturally like a real person would, the way a shop
  girl might banter with a regular customer. You do not have to steer
  every single message back to selling. If a conversation drifts far off
  topic for a while, you can warmly nudge it back toward the shop, but
  there's no need to force it on every turn.

NEGOTIATION AND PRICE INTEGRITY (read this carefully):
- Prices are fixed. Full stop. This applies no matter how the customer
  asks: direct ("give me discount"), joking ("free me jor"), guilt-trip
  ("you no sabi me"), or wearing you down with repetition.
- You can be warm, funny, and laugh things off, but you must never say
  anything, even as a joke or in a laughing tone, that could be read as
  agreeing to a lower price or a free item. Phrases like "okay okay",
  "no wahala" (in response to a discount ask), or "lol alright" are
  DANGEROUS here because a customer could screenshot them and claim you
  promised a deal. Never use agreement-shaped language in response to a
  price push, even sarcastically.
- Instead, when a customer keeps pushing after you've already held the
  price once, stay light but unmistakably firm: joke about it, tease them
  back, laugh with them, but always land clearly on the fact that the
  price has not changed. For example, laugh off the pressure while still
  restating the fixed price in the same message, so there is zero room
  for the customer to think you caved.

RULES:
- Quote prices EXACTLY as listed (never change or guess a price), even
  when writing them the casual "18k" way.
- Delivery: Lagos N2,000 (1-2 days), outside Lagos N3,500 (2-4 days).
- Payment: bank transfer to KP Collections, GTBank 0123456789. Ask the
  customer to send a screenshot after transfer, and say the owner will
  confirm it shortly.
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

    // Meta sends delivery status updates (sent/delivered/read/FAILED) as a
    // separate event from actual incoming messages. We were ignoring these
    // entirely, which is why a failed photo delivery looked silent. Log any
    // failure here so we can see Meta's real reason.
    const statuses = value?.statuses;
    if (statuses && statuses.length > 0) {
      for (const status of statuses) {
        if (status.status === "failed") {
          console.error(
            "DELIVERY FAILED:",
            JSON.stringify(status.errors || status, null, 2)
          );
        }
      }
      return; // status events aren't customer messages, nothing more to do
    }

    const message = value?.messages?.[0];
    if (!message || message.type !== "text") return; // ignore statuses etc.

    const from = message.from;             // customer's number
    const text = message.text.body;        // what they said
    console.log(`Customer ${from}: ${text}`);

    // Mark the message as read and show the "typing..." bubble right away,
    // so the customer sees a response is coming while we think.
    await markReadAndShowTyping(message.id);

    // Load this customer's history from persistent memory
    let history = await getConversation(from);
    history.push({ role: "user", content: text });
    // keep only last 10 turns to stay light
    history = history.slice(-10);

    // ---------- 3) THINK (ask the AI brain) ----------
    const rawReply = await askAI(history);

    // Pull out the invisible [PHOTO: key] tag, if she included one, and
    // clean it out of the text so the customer never sees the tag itself.
    const { cleanText, photoKey } = extractPhotoTag(rawReply);

    // Save the clean version (no tag) to memory, so future context stays tidy
    history.push({ role: "assistant", content: cleanText });
    await saveConversation(from, history);

    // A short human-feeling pause before sending, scaled to reply length.
    // Short replies feel almost instant; longer ones feel like she typed
    // them out. Capped so it never drags or outlasts the 25s typing window.
    await humanPause(cleanText);

    // ---------- 4) REPLY on WhatsApp ----------
    await sendWhatsApp(from, cleanText);
    console.log(`Amara -> ${from}: ${cleanText}`);

    // If she asked for a photo to go out, send it right after the text,
    // with a tiny natural gap so it doesn't feel like a robotic attachment dump.
    if (photoKey && PRODUCT_IMAGES[photoKey]) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const sent = await sendWhatsAppImage(from, PRODUCT_IMAGES[photoKey]);
      if (sent) {
        console.log(`Amara -> ${from}: [sent photo: ${photoKey}]`);
      } else {
        console.error(`Photo send FAILED for ${photoKey}, customer got no image.`);
      }
    }
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

// ---------- Show "typing..." on the customer's phone while we think ----------
async function markReadAndShowTyping(messageId) {
  try {
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
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      }
    );
    const data = await response.json();
    if (data.error) console.error("Typing indicator error:", JSON.stringify(data.error));
  } catch (err) {
    console.error("markReadAndShowTyping failed:", err);
  }
}

// ---------- A small human-feeling pause before sending the reply ----------
// Scales gently with reply length so short answers feel snappy and longer
// ones feel like she actually typed them, without ever dragging on too long.
function humanPause(replyText) {
  const baseMs = 700;               // never feel instant, even for "yes"
  const perCharMs = 18;             // roughly a fast-typer's pace
  const capMs = 6000;               // never make anyone wait too long
  const delay = Math.min(baseMs + replyText.length * perCharMs, capMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// ---------- Pull the invisible [PHOTO: key] tag out of the AI's reply ----------
function extractPhotoTag(text) {
  const match = text.match(/\[PHOTO:\s*(\w+)\]/i);
  if (!match) return { cleanText: text.trim(), photoKey: null };

  const photoKey = match[1].toLowerCase();
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, photoKey };
}

// ---------- Send a product photo on WhatsApp ----------
async function sendWhatsAppImage(to, imageUrl) {
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
        type: "image",
        image: { link: imageUrl },
      }),
    }
  );
  const data = await response.json();
  if (data.error) {
    console.error("WhatsApp image send error:", JSON.stringify(data.error));
    return false;
  }
  return true;
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
