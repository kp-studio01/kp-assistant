// ============================================================
// KP SALES ASSISTANT — Demo Server v1
// Receives WhatsApp messages -> thinks with AI -> replies
// ============================================================

const express = require("express");
const zlib = require("zlib");
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

// Our own public URL, so we can build image links that point back at
// ourselves. Render sets RENDER_EXTERNAL_URL automatically; the fallback
// is just a safety net in case that's ever missing.
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://kp-assistant.onrender.com";

// The owner's own WhatsApp number, where escalation alerts get sent.
// Set this in Render's environment variables. Include the country code,
// no plus sign or spaces (same format WhatsApp itself uses), e.g. 234801...
const OWNER_PHONE_NUMBER = process.env.OWNER_PHONE_NUMBER;

// A simple access key for the /customers page, so it isn't wide open to
// anyone who finds the URL. Set this in Render, then visit the page as
// /customers?key=whatever-you-set. Not bulletproof security, but enough
// to keep it private at this stage.
const ADMIN_KEY = process.env.ADMIN_KEY;

// ---------- PRODUCT PHOTOS (self-hosted, no third-party service involved) ----------
// We generate simple solid-colour placeholder images ourselves, in code,
// using nothing but Node's built-in zlib. This avoids ever depending on
// getting some other service's URL format exactly right. When you're
// ready for a real seller, swap PRODUCT_IMAGES below to point at real
// hosted photo URLs (e.g. photos uploaded to GitHub or Google Drive with
// public links) instead of "/images/<key>.png" — nothing else changes.

function makeSolidPng(width, height, r, g, b) {
  function crc32(buf) {
    let c, crcTable = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowLen + 1);
    raw[rowStart] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// Generate each product's placeholder once at startup and keep it in memory.
const PRODUCT_IMAGE_BUFFERS = {
  tee: makeSolidPng(600, 600, 245, 245, 245),
  hoodie: makeSolidPng(600, 600, 26, 26, 26),
  jacket: makeSolidPng(600, 600, 44, 62, 99),
  cap: makeSolidPng(600, 600, 139, 90, 43),
  joggers: makeSolidPng(600, 600, 58, 58, 58),
};

// Serve them at simple, predictable URLs that WhatsApp can fetch.
app.get("/images/:key.png", (req, res) => {
  const buffer = PRODUCT_IMAGE_BUFFERS[req.params.key];
  if (!buffer) return res.sendStatus(404);
  res.set("Content-Type", "image/png");
  res.send(buffer);
});

// These are the links Amara actually sends. Swap to real photo URLs later.
const PRODUCT_IMAGES = {
  tee: `${BASE_URL}/images/tee.png`,
  hoodie: `${BASE_URL}/images/hoodie.png`,
  jacket: `${BASE_URL}/images/jacket.png`,
  cap: `${BASE_URL}/images/cap.png`,
  joggers: `${BASE_URL}/images/joggers.png`,
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
- IMPORTANT: Before adding a [PHOTO: key] tag, check your own earlier
  messages in this conversation. If you see a note like "already sent the
  X photo in this chat", that photo has ALREADY gone out. Do not send it
  again, even if the customer asks another question about the same item,
  keeps negotiating on it, or the conversation continues for a while.
  Only resend a photo if the customer explicitly asks to see it again
  ("send it again", "let me see it once more").
- Only ever use one [PHOTO: key] tag per message, and only for products
  that exist in the catalog.
- Do not write text that depends on the photo definitely arriving, like
  "see for yourself 👇" or "check the image below." Write your text so it
  stands on its own even if the photo doesn't show. The photo is a nice
  bonus alongside your words, not something your words should point at.

SPLITTING INTO SEPARATE MESSAGES:
- Real people on WhatsApp rarely send one long message with everything in
  it, they send a few short separate bubbles, one thought at a time. You
  can do this too. When a reply naturally has two or three distinct
  beats (for example: the price, then a short comment about delivery; or
  a reaction, then a follow-up thought), mark the break with |||  on its
  own with a space on each side, between the two parts. This is invisible
  to the customer, it gets turned into separate message bubbles sent one
  after another.
- Use this sparingly and only when it feels like how a real person would
  naturally pause between thoughts. Most replies are still a single short
  message with no split at all. Never split a single sentence in half.
- Never use more than one ||| per reply (so at most two separate bubbles
  from one reply). Do not overuse this, a chat where every message is
  split into pieces feels just as artificial as one long paragraph.

HOW YOU TEXT (this matters as much as what you say):
- Short bursts. Most replies are 1-2 sentences. Rarely go past 3.
- In casual back-and-forth, write prices the way people actually type them
  on WhatsApp: "18k", "25k", "7.5k". Switch to the full exact figure
  ("N18,000") only at the point of confirming delivery details, giving
  the final total, or writing out the bank transfer instructions, where
  precision actually matters.
- Emojis are rare, not a habit. Aim for most messages, at least 7 or 8
  out of every 10, to have NO emoji at all. Do not use 😄 or 😁 (the big
  grinning laugh face) at all, it has become a reflex crutch, treat it as
  banned. When you do use an emoji, pull from a varied, natural mix
  depending on the mood: 🫠 😸 😺 🌚 😩 🙃 💀 👀 😭 among others. Match the
  emoji to the actual moment, a dramatic customer might get 💀 or 😭, a
  sly tease might get 🙃 or 🌚, a flat moment might get nothing at all.
  Never stack more than one emoji in a single message.
- Do not end every message with a question. A real seller often just
  answers and lets the customer decide what to say next. Ask a follow-up
  only when it genuinely moves the conversation forward, not as a reflex.
- Mirror the customer's energy and register, but let it build over the
  conversation rather than assuming it from message one. Early in a chat
  (the first greeting, the first product question), stay warm but a
  little more neutral and professional, since you don't know their style
  yet. Once the customer has clearly shown their own energy, pidgin,
  jokes, playful pushback, loosen up and match it, banter included. Don't
  go full playful mode on a total stranger's very first "hi".
- Do not sound instantly available or overly eager on every single reply.
  It is fine to sound normal and a little understated, like someone who
  has other customers too.
- Banter during price haggling is fine once the customer's tone invites
  it, but don't lean on the same joke or framing repeatedly (e.g. don't
  keep treating the price talk as a "win or lose" game message after
  message). Vary how you hold the line, and every time you banter about
  price, still land clearly on the actual fixed price in that same
  message, so the joke never replaces the firmness, it just softens it.
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

ALERTING THE OWNER:
- Whenever you tell a customer the owner will reply shortly, also alert
  the owner for real. Add an invisible tag at the very end of your
  message, on its own, in this exact format: [ESCALATE: short reason]
  using a few plain words for the reason (e.g. [ESCALATE: custom color
  request not in catalog], [ESCALATE: customer asking for a refund]).
  This tag is invisible to the customer, it triggers a real WhatsApp
  alert to the owner, so never mention the tag itself.
- Also use this tag if a customer seems genuinely upset, angry, or
  frustrated, not just confused, even if you're still able to answer
  their question. The owner should know when someone's mood needs a
  human touch, not just when a question stumps you.
- Do not use this for routine price haggling or normal back-and-forth,
  that's expected and you handle it fine on your own. This is for
  genuine "a human needs to step in" moments only.
- Only ever one [ESCALATE: reason] tag per message.
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
  // Try twice before giving up. A single transient network hiccup (most
  // likely right as the free server wakes from a nap) shouldn't make a
  // real returning customer look like a stranger. If both attempts fail,
  // we still fall back safely to an empty history rather than crashing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await redisCommand(["GET", `conv:${from}`]);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (err) {
      console.error(`getConversation attempt ${attempt} failed:`, err.message);
      if (attempt === 2) {
        console.error(`MEMORY LOAD FAILED for ${from} after retry, starting this reply with empty history.`);
        return [];
      }
      await new Promise((resolve) => setTimeout(resolve, 500)); // brief pause before retry
    }
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

// ---------- OWNER TAKEOVER (pause/resume) ----------
// The owner can tell Amara to step back from a specific customer while
// they handle it personally, and tell her to pick back up when done.
// A pause auto-expires after 6 hours so a forgotten pause never strands
// a customer forever.
const PAUSE_DURATION_SECONDS = 6 * 60 * 60; // 6 hours

async function pauseCustomer(phone) {
  try {
    await redisCommand(["SET", `paused:${phone}`, "1", "EX", String(PAUSE_DURATION_SECONDS)]);
    // Reset the "already told them someone's coming" flag so the one-time
    // holding note fires fresh for this new pause, not skipped from last time.
    await redisCommand(["DEL", `paused_notified:${phone}`]);
    await upsertCustomer(phone, { paused: "yes" });
  } catch (err) {
    console.error("pauseCustomer failed:", err.message);
  }
}

async function resumeCustomer(phone) {
  try {
    await redisCommand(["DEL", `paused:${phone}`]);
    await redisCommand(["DEL", `paused_notified:${phone}`]);
    await upsertCustomer(phone, { paused: "no" });
  } catch (err) {
    console.error("resumeCustomer failed:", err.message);
  }
}

async function isCustomerPaused(phone) {
  try {
    const result = await redisCommand(["GET", `paused:${phone}`]);
    return !!result;
  } catch (err) {
    // Fail OPEN: if Redis hiccups, Amara should keep helping the customer,
    // not go silent. Going quiet by accident is worse than one missed pause.
    console.error("isCustomerPaused check failed, defaulting to NOT paused:", err.message);
    return false;
  }
}

async function hasNotifiedPaused(phone) {
  try {
    const result = await redisCommand(["GET", `paused_notified:${phone}`]);
    return !!result;
  } catch (err) {
    return true; // fail toward NOT repeating the note, safer than spamming
  }
}

async function markNotifiedPaused(phone) {
  try {
    await redisCommand(["SET", `paused_notified:${phone}`, "1", "EX", String(PAUSE_DURATION_SECONDS)]);
  } catch (err) {
    console.error("markNotifiedPaused failed:", err.message);
  }
}

async function setLastEscalatedCustomer(phone) {
  try {
    await redisCommand(["SET", "last_escalated_customer", phone, "EX", "86400"]); // 24h
  } catch (err) {
    console.error("setLastEscalatedCustomer failed:", err.message);
  }
}

async function getLastEscalatedCustomer() {
  try {
    return await redisCommand(["GET", "last_escalated_customer"]);
  } catch (err) {
    console.error("getLastEscalatedCustomer failed:", err.message);
    return null;
  }
}

// ---------- CUSTOMER DATABASE ----------
// A real, structured record per customer, not just a pile of chat text.
// One Redis hash per phone number, plus a set listing every customer
// we've ever talked to, so they can actually be browsed as a list, not
// just looked up one at a time if you already know the number. This is
// the same data a future dashboard app would read from, so nothing here
// gets thrown away once that exists.

async function upsertCustomer(phone, fields) {
  try {
    const flatFields = [];
    for (const [key, value] of Object.entries(fields)) {
      flatFields.push(key, String(value));
    }
    await redisCommand(["HSET", `customer:${phone}`, ...flatFields]);
    await redisCommand(["SADD", "all_customers", phone]);
  } catch (err) {
    console.error(`upsertCustomer failed for ${phone}:`, err.message);
  }
}

async function getCustomer(phone) {
  try {
    const raw = await redisCommand(["HGETALL", `customer:${phone}`]);
    // Upstash returns HGETALL as a flat [key, value, key, value, ...] array
    if (!raw || raw.length === 0) return null;
    const record = { phone };
    for (let i = 0; i < raw.length; i += 2) {
      record[raw[i]] = raw[i + 1];
    }
    return record;
  } catch (err) {
    console.error(`getCustomer failed for ${phone}:`, err.message);
    return null;
  }
}

async function listAllCustomers() {
  try {
    const phones = await redisCommand(["SMEMBERS", "all_customers"]);
    if (!phones || phones.length === 0) return [];
    const records = await Promise.all(phones.map((phone) => getCustomer(phone)));
    return records.filter(Boolean);
  } catch (err) {
    console.error("listAllCustomers failed:", err.message);
    return [];
  }
}

// Called on every incoming customer message: keeps first/last contact
// time and message count up to date without needing any separate step.
async function recordCustomerContact(phone) {
  const existing = await getCustomer(phone);
  const now = new Date().toISOString();
  await upsertCustomer(phone, {
    phone,
    first_contact: existing?.first_contact || now,
    last_contact: now,
    message_count: existing?.message_count ? Number(existing.message_count) + 1 : 1,
  });
}

// ---------- MESSAGE BUFFERING ----------
// Real WhatsApp users often fire off several quick messages in a row
// ("Hi", "I want the hoodie", "can I get discount") instead of one full
// thought. Replying to the first one immediately means Amara jumps in
// before the customer has finished. Instead, we wait a short window to
// see if more messages are coming, then combine them into one turn.
const BUFFER_WAIT_MS = 4000; // 4 seconds of quiet before we reply
const pendingBuffers = new Map(); // from -> { texts: [], lastMessageId, timer }

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

    const from = message.from;             // sender's number
    const text = message.text.body;        // what they said

    // If this message is from the owner's own number, treat it as a
    // control command (pause/resume), not a customer conversation.
    // Handled immediately, no buffering delay, since the owner wants
    // an instant confirmation, especially in an urgent moment.
    if (OWNER_PHONE_NUMBER && from === OWNER_PHONE_NUMBER) {
      console.log(`Owner ${from}: ${text}`);
      await handleOwnerCommand(text);
      return;
    }

    console.log(`Customer ${from}: ${text}`);

    // Keep the customer database up to date: when we first heard from
    // them, when we last did, and how many messages total.
    await recordCustomerContact(from);

    // If the owner has paused this customer, handle it separately and
    // stop here. This must happen BEFORE we show any typing indicator,
    // otherwise the customer sees "typing..." for a reply that may
    // never come, which is misleading.
    const paused = await isCustomerPaused(from);
    if (paused) {
      await handlePausedCustomerMessage(from, text, message.id);
      return;
    }

    // Mark the message as read and show the "typing..." bubble right away,
    // so the customer sees a response is coming even while we wait to see
    // if more messages are on the way.
    await markReadAndShowTyping(message.id);

    // Add this message to the customer's pending buffer. If they send
    // another message within the wait window, we cancel the old timer and
    // start a fresh one, so we only reply once they've paused.
    let buffer = pendingBuffers.get(from);
    if (!buffer) {
      buffer = { texts: [], lastMessageId: null };
      pendingBuffers.set(from, buffer);
    }
    buffer.texts.push(text);
    buffer.lastMessageId = message.id;

    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      processBufferedTurn(from).catch((err) =>
        console.error("processBufferedTurn crashed:", err)
      );
    }, BUFFER_WAIT_MS);
  } catch (err) {
    console.error("Error handling incoming webhook:", err);
  }
});

// ---------- Handle a customer's turn once they've paused sending ----------
// ---------- Handle a message from a customer the owner has paused ----------
// Bypasses the normal buffer/typing flow entirely, since we already know
// whether Amara is going to say anything. Only shows typing when she's
// actually about to send the one-time holding note.
async function handlePausedCustomerMessage(from, text, messageId) {
  let history = await getConversation(from);
  history.push({ role: "user", content: text });
  history = history.slice(-10);

  const alreadyNotified = await hasNotifiedPaused(from);

  if (!alreadyNotified) {
    // First message since the pause started: show typing, since we ARE
    // about to reply once, then mark it so we don't repeat this.
    await markReadAndShowTyping(messageId);
    const holdingNote = "Just a moment, the owner's handling this personally right now.";
    await humanPause(holdingNote);
    await sendWhatsApp(from, holdingNote);
    await markNotifiedPaused(from);
    history.push({ role: "assistant", content: holdingNote });
    console.log(`Amara -> ${from}: [paused, sent one-time holding note]`);
  } else {
    // Already told them once. Mark it read so they see it was received,
    // but no typing bubble, since nothing else is coming.
    await markReadOnly(messageId);
    console.log(`Customer ${from} is paused, staying quiet (already notified).`);
  }

  await saveConversation(from, history);
}


async function processBufferedTurn(from) {
  const buffer = pendingBuffers.get(from);
  if (!buffer) return; // safety, shouldn't happen
  pendingBuffers.delete(from);

  // Combine everything they sent in this burst into one turn, so Amara
  // replies to the whole thought instead of just the first fragment.
  const combinedText = buffer.texts.join("\n");
  const messageId = buffer.lastMessageId;

  try {
    // Load this customer's history from persistent memory
    let history = await getConversation(from);
    history.push({ role: "user", content: combinedText });
    // keep only last 10 turns to stay light
    history = history.slice(-10);

    // If the owner has taken over this specific customer, Amara stays
    // quiet rather than replying on top of whatever the owner is doing.
    // Still save the customer's message to history for continuity, and
    // send one quiet note the first time this happens per pause, not
    // on every message, so it doesn't feel repetitive or robotic.
    const paused = await isCustomerPaused(from);
    if (paused) {
      let holdingNote = null;
      const alreadyNotified = await hasNotifiedPaused(from);
      if (!alreadyNotified) {
        holdingNote = "Just a moment, the owner's handling this personally right now.";
        await humanPause(holdingNote);
        await sendWhatsApp(from, holdingNote);
        await markNotifiedPaused(from);
        console.log(`Amara -> ${from}: [paused, sent one-time holding note]`);
      } else {
        console.log(`Customer ${from} is paused, staying quiet (already notified).`);
      }
      history.push({ role: "assistant", content: holdingNote || "[paused: owner is handling this personally]" });
      await saveConversation(from, history);
      return;
    }

    // ---------- 3) THINK (ask the AI brain) ----------
    const rawReply = await askAI(history);

    // Pull out the invisible [PHOTO: key] tag, if she included one, and
    // clean it out of the text so the customer never sees the tag itself.
    const { cleanText: photoStripped, photoKey } = extractPhotoTag(rawReply);

    // Pull out the invisible [ESCALATE: reason] tag, if she flagged that
    // the owner needs to step in. Also cleaned out before the customer
    // ever sees it.
    const { cleanText: taggedClean, escalationReason } = extractEscalationTag(photoStripped);

    // Mechanically remove any banned emoji that slipped through despite
    // the prompt instruction. Belt and suspenders: the instruction handles
    // most cases, this guarantees the rest.
    const cleanText = stripBannedEmojis(taggedClean);

    // Split into separate WhatsApp bubbles if she used the ||| marker,
    // so a reply with two distinct thoughts arrives as two short
    // messages, one after another, the way a real person texts.
    const bubbles = cleanText
      .split("|||")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    // Save to memory using the clean, joined version (no raw ||| marker),
    // so future context reads naturally. If a photo went out, leave an
    // invisible note in what WE remember (never sent to the customer) so
    // future replies in this chat know a photo was already shown.
    const memoryBody = bubbles.join("\n");
    const textForMemory =
      photoKey && PRODUCT_IMAGES[photoKey]
        ? `${memoryBody}\n[note to self: already sent the ${photoKey} photo in this chat, do not resend unless they ask again]`
        : memoryBody;
    history.push({ role: "assistant", content: textForMemory });
    await saveConversation(from, history);

    // ---------- 4) REPLY on WhatsApp, one bubble at a time ----------
    for (let i = 0; i < bubbles.length; i++) {
      // Re-show the typing bubble before each message after the first,
      // so multi-part replies feel like separate thoughts, not a dump.
      if (i > 0 && messageId) {
        await markReadAndShowTyping(messageId);
      }
      await humanPause(bubbles[i]);
      await sendWhatsApp(from, bubbles[i]);
      console.log(`Amara -> ${from}: ${bubbles[i]}`);
    }

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

    // If she flagged that the owner needs to step in, send that alert now,
    // after the customer's own reply has gone out.
    if (escalationReason) {
      await sendOwnerAlert(from, escalationReason, combinedText);
      console.log(`Owner alerted: ${escalationReason}`);
    }
  } catch (err) {
    console.error("Error handling message:", err);

    // LAST RESORT: something unexpected broke the normal flow. Rather than
    // leaving the customer with a typing bubble and then nothing forever,
    // try once to send a plain, honest fallback message. If even this
    // fails, we've at least logged it clearly above.
    try {
      await sendWhatsApp(
        from,
        "Sorry, small network wahala my side. Still here, please try that again."
      );
    } catch (fallbackErr) {
      console.error("Fallback reply also failed:", fallbackErr);
    }
  }
}

// ---------- The AI call ----------
async function askAI(history) {
  try {
    // Safety cap: never let this hang forever if Anthropic's API is slow
    // or unreachable. 20 seconds is generous but bounded.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

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
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    if (data?.content?.[0]?.text) return data.content[0].text;
    console.error("AI error (bad response shape):", JSON.stringify(data));
    return "Give me one second please, let me confirm that for you.";
  } catch (err) {
    // Network failure, timeout, or anything else unexpected: never let this
    // bubble up as a crash that leaves the customer with no reply at all.
    console.error("askAI failed (network/timeout):", err.message);
    return "Sorry, network wahala for my side just now, still here! Please send that again.";
  }
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

// ---------- Mark a message read WITHOUT showing typing ----------
// Used when we already know Amara isn't going to reply (e.g. a paused
// customer who's already been told someone will be with them). Showing
// "typing..." when nothing is actually coming is misleading.
async function markReadOnly(messageId) {
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
        }),
      }
    );
    const data = await response.json();
    if (data.error) console.error("markReadOnly error:", JSON.stringify(data.error));
  } catch (err) {
    console.error("markReadOnly failed:", err);
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

// ---------- Pull the invisible [ESCALATE: reason] tag out of the AI's reply ----------
function extractEscalationTag(text) {
  const match = text.match(/\[ESCALATE:\s*([^\]]+)\]/i);
  if (!match) return { cleanText: text.trim(), escalationReason: null };

  const escalationReason = match[1].trim();
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, escalationReason };
}

// ---------- Guaranteed backstop: strip the banned "reflex" emoji ----------
// Prompt instructions are a strong nudge, not a hard rule, an AI can still
// slip and use a banned emoji anyway. This makes the ban actually airtight
// by removing it in code, regardless of what the AI outputs.
const BANNED_EMOJIS = /[\u{1F604}\u{1F601}]/gu; // 😄 and 😁
function stripBannedEmojis(text) {
  return text.replace(BANNED_EMOJIS, "").replace(/[ \t]{2,}/g, " ").trim();
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
          to: to,
          type: "text",
          text: { body: text },
        }),
      }
    );
    const data = await response.json();
    if (data.error) {
      console.error("WhatsApp send error:", JSON.stringify(data.error));
      return false;
    }
    return true;
  } catch (err) {
    // Meta occasionally returns a non-JSON error page during outages or
    // rate limiting. Don't let that crash the whole flow, just log it.
    console.error("sendWhatsApp failed unexpectedly:", err.message);
    return false;
  }
}

// ---------- Send a pre-approved WhatsApp template message ----------
// Templates are the only message type Meta allows OUTSIDE the 24-hour
// customer service window, which is exactly the situation owner alerts
// run into (the owner may not have messaged Amara's number recently).
// The template must be created and approved in Meta's WhatsApp Manager
// first; see OWNER_ALERT_TEMPLATE_NAME below.
const OWNER_ALERT_TEMPLATE_NAME = "owner_alert_v1";
const OWNER_ALERT_TEMPLATE_LANGUAGE = "en_US";

async function sendWhatsAppTemplate(to, templateName, languageCode, parameters) {
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
          to: to,
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            components: [
              {
                type: "body",
                parameters: parameters.map((text) => ({ type: "text", text })),
              },
            ],
          },
        }),
      }
    );
    const data = await response.json();
    if (data.error) {
      console.error("WhatsApp template send error:", JSON.stringify(data.error));
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendWhatsAppTemplate failed unexpectedly:", err.message);
    return false;
  }
}

// ---------- Alert the owner when Amara needs a human ----------
// ---------- Owner control commands (pause/resume a specific customer) ----------
// The owner texts these from OWNER_PHONE_NUMBER. "last" refers to whoever
// was most recently escalated, so the owner doesn't need to type or find
// a phone number while dealing with a real, possibly stressful moment.
function parseOwnerCommand(text) {
  const trimmed = text.trim();
  if (/^pause\s+last$/i.test(trimmed)) return { action: "pause", target: "last" };
  if (/^resume\s+last$/i.test(trimmed)) return { action: "resume", target: "last" };
  const pauseMatch = trimmed.match(/^pause\s+(\d{7,15})$/i);
  if (pauseMatch) return { action: "pause", target: pauseMatch[1] };
  const resumeMatch = trimmed.match(/^resume\s+(\d{7,15})$/i);
  if (resumeMatch) return { action: "resume", target: resumeMatch[1] };
  return null;
}

// ---------- Understand natural phrasing, not just exact commands ----------
// A real person under pressure won't always type "pause last" exactly.
// If the quick pattern match above finds nothing, ask the AI what they
// meant. Cheap (tiny prompt, tiny reply) and only runs on owner messages,
// which are rare. Defaults to "last" since that's who the owner is
// almost always reacting to when they use natural language.
async function interpretOwnerIntent(text) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        system:
          `The owner of a small business just texted their AI sales ` +
          `assistant. Decide what they want:\n` +
          `PAUSE - they want the AI to stop replying to a customer so ` +
          `they can handle it themselves (e.g. "I'll take this one", ` +
          `"let me handle it", "I got this", "pause, I'll deal with it")\n` +
          `RESUME - they want the AI to start replying to that customer ` +
          `again (e.g. "ok you can continue", "I'm done", "go ahead and ` +
          `take back over")\n` +
          `NONE - neither, or genuinely unclear\n\n` +
          `Reply with ONLY one word: PAUSE, RESUME, or NONE.`,
        messages: [{ role: "user", content: text }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    const reply = data?.content?.[0]?.text?.trim().toUpperCase();
    if (reply === "PAUSE" || reply === "RESUME") return reply;
    return "NONE";
  } catch (err) {
    console.error("interpretOwnerIntent failed:", err.message);
    return "NONE"; // fail safe: don't guess on a broken call, fall through to help text
  }
}

async function handleOwnerCommand(text) {
  let command = parseOwnerCommand(text);

  if (!command) {
    // No exact match. Ask the AI whether this was natural-language
    // pause/resume phrasing before giving up and showing the help menu.
    const intent = await interpretOwnerIntent(text);
    if (intent === "PAUSE") command = { action: "pause", target: "last" };
    else if (intent === "RESUME") command = { action: "resume", target: "last" };
  }

  if (!command) {
    // Genuinely unrecognized: send a short, self-documenting help message
    // rather than staying silent, so the commands are discoverable.
    await sendWhatsApp(
      OWNER_PHONE_NUMBER,
      "Hi! I listen for a few commands here:\n\n" +
        `pause <number> — I'll stop replying to that customer so you can handle them\n` +
        `pause last — same, but for whoever I most recently alerted you about\n` +
        `resume <number> / resume last — I'll pick back up\n\n` +
        `You can also just say it naturally, like "I'll take this one" or "ok you can continue".\n\n` +
        `Pauses lift automatically after 6 hours either way.`
    );
    return;
  }

  let target = command.target;
  if (target === "last") {
    target = await getLastEscalatedCustomer();
    if (!target) {
      await sendWhatsApp(
        OWNER_PHONE_NUMBER,
        `No recent customer to ${command.action}. Try "${command.action} <their number>" instead.`
      );
      return;
    }
  }

  if (command.action === "pause") {
    await pauseCustomer(target);
    await sendWhatsApp(
      OWNER_PHONE_NUMBER,
      `Got it, I'll step back for ${target}. Text "resume ${target}" (or just tell me naturally) when you're done, or I'll pick back up automatically in 6 hours.`
    );
  } else {
    await resumeCustomer(target);
    await sendWhatsApp(OWNER_PHONE_NUMBER, `Back on it for ${target}.`);
  }
}


async function sendOwnerAlert(customerNumber, reason, lastCustomerMessage) {
  if (!OWNER_PHONE_NUMBER) {
    console.error(
      "ESCALATION happened but OWNER_PHONE_NUMBER isn't set, no alert sent. Reason:",
      reason
    );
    return;
  }

  // Remember who this was about, so "pause last" / "resume last" work
  // without the owner needing to type or copy a phone number under pressure.
  await setLastEscalatedCustomer(customerNumber);

  // Template parameters can't contain newlines, keep them single-line.
  const cleanReason = reason.replace(/\s+/g, " ").trim();
  const cleanLastMessage = lastCustomerMessage.replace(/\s+/g, " ").trim();

  // Keep this on the customer's own record too, so it's visible at a
  // glance in the customer list, not just buried in a WhatsApp alert.
  await upsertCustomer(customerNumber, {
    last_escalation_reason: cleanReason,
    last_escalation_at: new Date().toISOString(),
  });

  // Try the cheap, simple path first: a plain free-form message. This
  // works whenever the owner has messaged Amara within the last 24
  // hours. If that fails (most likely because that window is closed),
  // automatically fall back to the pre-approved template, which Meta
  // allows to reach the owner regardless of the window.
  const alertText =
    `🔔 Amara needs you\n\n` +
    `Customer: ${customerNumber}\n` +
    `Why: ${cleanReason}\n` +
    `They said: "${cleanLastMessage}"\n\n` +
    `Want to handle this yourself? Reply "pause last" and I'll step back.`;

  const freeFormSucceeded = await sendWhatsApp(OWNER_PHONE_NUMBER, alertText);
  if (freeFormSucceeded) return;

  console.log("Free-form owner alert failed, falling back to template message.");
  const templateSucceeded = await sendWhatsAppTemplate(
    OWNER_PHONE_NUMBER,
    OWNER_ALERT_TEMPLATE_NAME,
    OWNER_ALERT_TEMPLATE_LANGUAGE,
    [customerNumber, cleanReason, cleanLastMessage]
  );
  if (!templateSucceeded) {
    console.error(
      "BOTH free-form and template owner alerts failed. Owner was NOT notified. Reason was:",
      cleanReason
    );
  }
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

// ---------- Customer list (simple viewable database, no dashboard yet) ----------
// Visit /customers?key=YOUR_ADMIN_KEY in any browser to see every customer
// Amara has ever talked to, in one place. This is the seed of the real
// dashboard app planned for later; the underlying data is the same.
app.get("/customers", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL.");
  }

  const customers = await listAllCustomers();
  // Most recently contacted first, so the busiest/newest conversations are on top.
  customers.sort((a, b) => new Date(b.last_contact || 0) - new Date(a.last_contact || 0));

  const rows = customers
    .map((c) => {
      const pausedBadge =
        c.paused === "yes"
          ? '<span style="color:#b45309;font-weight:600;">Paused</span>'
          : '<span style="color:#15803d;">Active</span>';
      return `<tr>
        <td>${c.phone || ""}</td>
        <td>${pausedBadge}</td>
        <td>${c.first_contact ? new Date(c.first_contact).toLocaleString() : ""}</td>
        <td>${c.last_contact ? new Date(c.last_contact).toLocaleString() : ""}</td>
        <td>${c.message_count || 0}</td>
        <td>${c.last_escalation_reason || ""}</td>
        <td>${c.last_escalation_at ? new Date(c.last_escalation_at).toLocaleString() : ""}</td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html>
    <head>
      <title>KP Studio - Customers</title>
      <style>
        body { font-family: -apple-system, sans-serif; margin: 24px; background: #f8fafc; }
        h1 { font-size: 20px; }
        table { border-collapse: collapse; width: 100%; background: white; }
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
        th { background: #1e293b; color: white; }
        tr:hover { background: #f1f5f9; }
      </style>
    </head>
    <body>
      <h1>Customers (${customers.length})</h1>
      <table>
        <tr>
          <th>Phone</th><th>Status</th><th>First contact</th><th>Last contact</th>
          <th>Messages</th><th>Last escalation</th><th>Escalated at</th>
        </tr>
        ${rows || '<tr><td colspan="7">No customers yet.</td></tr>'}
      </table>
    </body>
    </html>
  `);
});

// ---------- Health check (visit in browser to see server is alive) ----------
app.get("/", (req, res) => {
  res.send("KP Sales Assistant is running ✓");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
