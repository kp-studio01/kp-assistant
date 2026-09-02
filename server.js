// ============================================================
// KP SALES ASSISTANT — Demo Server v1
// Receives WhatsApp messages -> thinks with AI -> replies
// ============================================================

const express = require("express");
const zlib = require("zlib");
const crypto = require("crypto");
const app = express();
// The `verify` hook stashes the raw request bytes on req.rawBody. We need
// those, untouched, to check Paystack's webhook signature later — HMACing
// the re-serialized JSON object instead of the original bytes would give
// a different signature and reject every real webhook call.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

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

// Paystack secret key, used both to create payment links and to verify
// that a webhook claiming "payment succeeded" really came from Paystack.
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ---------- PRODUCT PRICES & DELIVERY FEES (server-side source of truth) ----------
// Amara's prompt states these same numbers so she can talk about them
// naturally, but the ACTUAL amount ever charged through a payment link is
// computed here in code, never trusted from anything the AI free-texts.
// Same "prompt is a suggestion, code is the guarantee" pattern as the
// other backstops in this file (banned emojis, photo resends), just
// applied to money, where it matters most.
const PRODUCT_PRICES = {
  tee: 7500,
  hoodie: 18000,
  jacket: 25000,
  cap: 5000,
  joggers: 15500,
};
const PRODUCT_NAMES = {
  tee: "Plain white tee",
  hoodie: "Black graphic hoodie",
  jacket: "Denim jacket",
  cap: "Classic baseball cap",
  joggers: "Cargo joggers",
};
const DELIVERY_FEES = {
  lagos: 2000,
  outside: 3500,
};

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

SENDING A PAYMENT LINK:
- Once a customer has clearly confirmed they want to buy a specific
  catalog item AND told you which delivery zone they're in (Lagos, or
  outside Lagos), add an invisible tag at the very end of your message,
  on its own, in this exact format: [PAY: key, zone] using the product
  key from the catalog (tee, hoodie, jacket, cap, or joggers) and zone as
  exactly "lagos" or "outside". This tag is invisible to the customer, it
  triggers a real, correct payment link to be generated and sent right
  after your message, so never mention the tag itself or explain it.
- You do NOT need to calculate or state the exact total yourself. The
  system computes the real amount from the fixed catalog and delivery
  prices above and sends it along with the link in its own message right
  after yours. Feel free to mention the individual prices naturally in
  your own message if it helps ("18k for the hoodie plus delivery to
  Lagos"), but the actual amount ever charged always comes from the
  system, never from your words.
- Only add this tag once the order is genuinely confirmed, not while the
  customer is still deciding, asking questions, or negotiating. Only one
  [PAY: key, zone] tag per message, and only for products in the catalog.
- If the customer hasn't told you their delivery zone yet, ask first
  instead of guessing or assuming Lagos. Never invent a zone.

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
- Do not re-escalate for a plain greeting or small talk ("hey", "hi",
  "you there?") even if the same customer had an unresolved issue
  earlier in the conversation. A bare greeting is not a new request.
  Only escalate again if the customer raises something new and
  substantive, or if real time has passed with no resolution and they
  are now following up specifically about that unresolved matter (e.g.
  "any update on my refund?" is worth escalating again, "hey" alone is
  not).
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

// ---------- Durable "photo already sent" tracking ----------
// This used to live only as a note buried in the last-10-message chat
// history, which meant a busy conversation (escalations, pauses, small
// talk) could push it out and cause an accidental resend. Tracking it
// here instead, permanently, per customer, means it can never be
// forgotten no matter how long or chaotic the conversation gets.
async function markPhotoSent(phone, photoKey) {
  try {
    await redisCommand(["SADD", `photos_sent:${phone}`, photoKey]);
    await redisCommand(["EXPIRE", `photos_sent:${phone}`, "2592000"]); // 30 days
  } catch (err) {
    console.error(`markPhotoSent failed for ${phone}:`, err.message);
  }
}

async function getPhotosSent(phone) {
  try {
    return await redisCommand(["SMEMBERS", `photos_sent:${phone}`]);
  } catch (err) {
    console.error(`getPhotosSent failed for ${phone}:`, err.message);
    return [];
  }
}

// Meta accepting a photo send only means it was QUEUED, not delivered --
// it fetches the image URL itself afterward, and if that fails, it tells
// us later via a separate "failed" status event, not the original API
// response. Without this, a photo we marked "sent" could have actually
// never reached the customer, with nothing correcting that record.
async function unmarkPhotoSent(phone, photoKey) {
  try {
    await redisCommand(["SREM", `photos_sent:${phone}`, photoKey]);
  } catch (err) {
    console.error(`unmarkPhotoSent failed for ${phone}:`, err.message);
  }
}

// ---------- Tracking in-flight photo sends, so an async delivery failure
// can be traced back to exactly who/what it was ----------
// This is what closes the gap that caused "photo not delivering to
// customer, tried twice": Meta returned success on the initial API call
// both times (so our old code marked it sent and moved on), then reported
// the real failure later as a status event with nothing tying it back to
// a customer or photo. Keyed by WhatsApp's own message id, short-lived
// (failures are reported within minutes, not days).
async function trackPendingPhotoSend(messageId, phone, photoKey) {
  try {
    await redisCommand([
      "SET",
      `pending_photo:${messageId}`,
      JSON.stringify({ phone, photoKey }),
      "EX",
      "86400",
    ]);
  } catch (err) {
    console.error(`trackPendingPhotoSend failed for ${messageId}:`, err.message);
  }
}

async function getPendingPhotoSend(messageId) {
  try {
    const raw = await redisCommand(["GET", `pending_photo:${messageId}`]);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`getPendingPhotoSend failed for ${messageId}:`, err.message);
    return null;
  }
}

async function clearPendingPhotoSend(messageId) {
  try {
    await redisCommand(["DEL", `pending_photo:${messageId}`]);
  } catch (err) {
    console.error(`clearPendingPhotoSend failed for ${messageId}:`, err.message);
  }
}

// ---------- PAYSTACK PAYMENT LINKS ----------
// Turns a confirmed order into a real, payable link, and later confirms
// automatically the moment Paystack tells us it's actually been paid
// (see the /paystack-webhook route below), no manual bank-screenshot
// checking needed for that path anymore.

async function initializePaystackTransaction(email, amountKobo, reference, metadata) {
  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amountKobo, // Paystack works in kobo, the smallest currency unit
        reference,
        metadata,
      }),
    });
    const data = await response.json();
    if (!data.status) {
      console.error("Paystack initialize failed:", JSON.stringify(data));
      return null;
    }
    return data.data; // { authorization_url, access_code, reference }
  } catch (err) {
    console.error("initializePaystackTransaction failed:", err.message);
    return null;
  }
}

// Pending orders live in Redis so the webhook (which only hands back a
// bare reference string) can look up who it belongs to and what was
// actually agreed, without trusting anything from the webhook body
// itself beyond that reference and a verified signature.
async function createPendingOrder(reference, order) {
  try {
    await redisCommand([
      "SET",
      `order:${reference}`,
      JSON.stringify(order),
      "EX",
      "86400", // 24h: a stale, unpaid link shouldn't linger forever
    ]);
  } catch (err) {
    console.error(`createPendingOrder failed for ${reference}:`, err.message);
  }
}

async function getPendingOrder(reference) {
  try {
    const raw = await redisCommand(["GET", `order:${reference}`]);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`getPendingOrder failed for ${reference}:`, err.message);
    return null;
  }
}

async function markOrderPaid(reference, order) {
  try {
    await redisCommand([
      "SET",
      `order:${reference}`,
      JSON.stringify({ ...order, status: "paid", paidAt: new Date().toISOString() }),
      "EX",
      "2592000", // keep paid orders around 30 days, useful for owner Q&A later
    ]);
  } catch (err) {
    console.error(`markOrderPaid failed for ${reference}:`, err.message);
  }
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

          // If this was a product photo we thought went out fine, Meta
          // just told us otherwise: it accepted the send, then couldn't
          // actually deliver the image. Left alone, the customer had
          // already been told "here you go!" and our own tracking said
          // this photo was "already sent" -- so if they followed up
          // ("did that come through?"), the resend-suppression logic
          // would brush them off instead of retrying. Fixed here, in
          // code, rather than relying on the AI to notice on some later
          // turn, which is exactly what let this go unnoticed twice.
          const pending = await getPendingPhotoSend(status.id);
          if (pending) {
            await clearPendingPhotoSend(status.id);
            await unmarkPhotoSent(pending.phone, pending.photoKey);

            await sendWhatsApp(
              pending.phone,
              "Ah, that photo didn't actually go through on my end, sending it again now, one sec."
            );
            const retry = await sendWhatsAppImage(
              pending.phone,
              PRODUCT_IMAGES[pending.photoKey]
            );
            if (retry.success) {
              await markPhotoSent(pending.phone, pending.photoKey);
              if (retry.messageId) {
                await trackPendingPhotoSend(retry.messageId, pending.phone, pending.photoKey);
              }
            }

            // Owner gets told either way. A photo that silently failed to
            // deliver once is worth knowing about even if the retry just
            // fixed it, and this alert fires from code, not from the AI
            // choosing to mention it, so it can't get missed again.
            await sendOwnerAlert(
              pending.phone,
              `Photo delivery failed for ${pending.photoKey} (WhatsApp couldn't deliver it)` +
                (retry.success ? ", auto-retried and it went through" : ", retry also failed"),
              `[product photo: ${pending.photoKey}]`
            );
          }
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
  const alreadyNotified = await hasNotifiedPaused(from);

  if (!alreadyNotified) {
    // First message since the pause started: this is a real conversation
    // turn, save it along with the holding note, same as any normal reply.
    let history = await getConversation(from);
    history.push({ role: "user", content: text });

    await markReadAndShowTyping(messageId);
    const holdingNote = "Just a moment, the owner's handling this personally right now.";
    await humanPause(holdingNote);
    await sendWhatsApp(from, holdingNote);
    await markNotifiedPaused(from);
    history.push({ role: "assistant", content: holdingNote });
    history = history.slice(-10);
    await saveConversation(from, history);
    console.log(`Amara -> ${from}: [paused, sent one-time holding note]`);
  } else {
    // Already told them once, staying quiet. Deliberately NOT saved to
    // conversation history: a customer waiting on a pause often sends
    // several "hello? you there?" style check-ins, and letting each one
    // consume a slot in the last-10-message window pushes the real,
    // meaningful conversation out before the owner even resumes. Just
    // mark it read and keep count in the customer database instead.
    await markReadOnly(messageId);
    console.log(`Customer ${from} is paused, staying quiet (already notified): "${text}"`);
  }
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
    // Look up which photos have already gone out to this customer from
    // durable storage (not chat history, which can get pushed out by a
    // busy conversation), and remind her fresh every single call so this
    // can never be forgotten no matter how the conversation has gone.
    const photosAlreadySent = await getPhotosSent(from);
    const photoReminder =
      photosAlreadySent.length > 0
        ? `You have ALREADY sent these product photos to this customer in this chat: ${photosAlreadySent.join(", ")}. Do not resend any of these unless the customer explicitly asks to see it again.`
        : "";
    const rawReply = await askAI(history, photoReminder);

    // Pull out the invisible [PHOTO: key] tag, if she included one, and
    // clean it out of the text so the customer never sees the tag itself.
    const { cleanText: photoStripped, photoKey } = extractPhotoTag(rawReply);

    // Pull out the invisible [PAY: key, zone] tag, if she flagged a
    // confirmed order. Also cleaned out before the customer ever sees it.
    const { cleanText: paymentStripped, paymentKey, paymentZone } = extractPaymentTag(photoStripped);

    // Pull out the invisible [ESCALATE: reason] tag, if she flagged that
    // the owner needs to step in. Also cleaned out before the customer
    // ever sees it.
    const { cleanText: taggedClean, escalationReason } = extractEscalationTag(paymentStripped);

    // Mechanically remove any banned emoji that slipped through despite
    // the prompt instruction. Belt and suspenders: the instruction handles
    // most cases, this guarantees the rest. Also catch and clean up any
    // leaked self-correction narration before it ever reaches a customer.
    const cleanText = stripBannedEmojis(stripSelfCorrection(taggedClean));

    // Split into separate WhatsApp bubbles if she used the ||| marker,
    // so a reply with two distinct thoughts arrives as two short
    // messages, one after another, the way a real person texts.
    const bubbles = cleanText
      .split("|||")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    // Save to memory using the clean, joined version (no raw ||| marker),
    // so future context reads naturally. Photo tracking now lives in
    // durable storage (see above), not as a note buried in this text.
    const memoryBody = bubbles.join("\n");
    history.push({ role: "assistant", content: memoryBody });
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
    //
    // HARD BACKSTOP against accidental repeats: the prompt already tells
    // her which photos went out already (the photoReminder above) and not
    // to resend them, but across a long, tag-heavy conversation (photo +
    // escalate + pause all mixed in) that reminder alone isn't reliable
    // enough, same lesson as the banned-emoji and bare-greeting rules
    // below. So a photo already recorded as sent for this customer only
    // goes out again when the customer's OWN current message actually
    // asks to see one. Otherwise the duplicate is silently dropped, no
    // matter what the model included in its reply.
    //
    // This has to recognize ANY normal way of asking to see a photo, not
    // just resend-specific wording ("send it again"). An earlier version
    // only matched "again"/"resend"/"once more", so a plain "can I see a
    // picture?" fell through: the AI said "Here you go!" anyway, the code
    // correctly blocked the actual image, and the customer was left with
    // a promise and nothing after it, worse than either sending the photo
    // or saying nothing.
    const PHOTO_REQUEST_PATTERN =
      /\b(see|show|send|share)\b[^.!?]{0,25}\b(pic|pics|picture|pictures|photo|photos|image|images)\b|\bresend\b|\bonce more\b|\bone more time\b|\bagain\b/i;
    if (photoKey && PRODUCT_IMAGES[photoKey]) {
      const alreadySentThisPhoto = photosAlreadySent.includes(photoKey);
      const explicitlyRequested = PHOTO_REQUEST_PATTERN.test(combinedText);

      if (alreadySentThisPhoto && !explicitlyRequested) {
        // Safety net: even with the broadened pattern above, some future
        // phrasing could still slip through uncaught. Rather than risk
        // repeating tonight's exact bug (a promised photo that never
        // shows up, with no explanation), say so plainly instead of
        // just going silent on the photo.
        console.log(
          `Photo resend SUPPRESSED (already sent, no explicit request): ${photoKey} for ${from}`
        );
        const clarifyText = "Already sent that one above, let me know if you want me to send it again!";
        await sendWhatsApp(from, clarifyText);
        let clarifyHistory = await getConversation(from);
        clarifyHistory.push({ role: "assistant", content: clarifyText });
        clarifyHistory = clarifyHistory.slice(-10);
        await saveConversation(from, clarifyHistory);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const imageResult = await sendWhatsAppImage(from, PRODUCT_IMAGES[photoKey]);
        if (imageResult.success) {
          console.log(`Amara -> ${from}: [sent photo: ${photoKey}]`);
          await markPhotoSent(from, photoKey); // durable, survives everything
          if (imageResult.messageId) {
            // Meta accepting the call isn't proof it actually reached the
            // customer -- see the /webhook "failed" status handling below,
            // which is what catches it if this one silently doesn't land.
            await trackPendingPhotoSend(imageResult.messageId, from, photoKey);
          }
        } else {
          // A hard, immediate rejection from the API (bad token, bad
          // format, etc). Don't just log it and leave the customer with
          // an empty promise -- say so, and get the owner involved right
          // away rather than hoping a future AI turn notices and tags it.
          console.error(`Photo send FAILED for ${photoKey}, customer got no image.`);
          await sendWhatsApp(
            from,
            "Hmm, that photo isn't sending from my side right now, let me flag this and sort it out."
          );
          await sendOwnerAlert(
            from,
            `Photo send failed immediately (${photoKey}) -- WhatsApp API rejected it`,
            combinedText
          );
        }
      }
    }

    // If she flagged a confirmed order, generate the real payment link.
    //
    // HARD BACKSTOP for money: the actual amount charged is ALWAYS
    // computed here from PRODUCT_PRICES + DELIVERY_FEES, never from
    // anything the AI said in its own reply. Same "code is the real
    // guarantee, the prompt is just a nudge" principle as everywhere
    // else in this file, just applied to the one place a slip actually
    // costs real naira.
    if (paymentKey && paymentZone) {
      const productPrice = PRODUCT_PRICES[paymentKey];
      const deliveryFee = DELIVERY_FEES[paymentZone];

      if (!PAYSTACK_SECRET_KEY) {
        console.error("Payment tag fired but PAYSTACK_SECRET_KEY isn't set, no link sent.");
      } else if (productPrice === undefined || deliveryFee === undefined) {
        console.error(
          `Payment tag had an unrecognized key/zone (${paymentKey}/${paymentZone}), no link sent.`
        );
      } else {
        const totalNaira = productPrice + deliveryFee;
        const reference = `KP-${from}-${Date.now()}`;
        // WhatsApp customers rarely have an email on hand mid-chat, and
        // Paystack requires one to initialize a transaction. A stable
        // placeholder per phone number is the standard workaround; it
        // never has to be real for the payment itself to work.
        const placeholderEmail = `${from}@customer.kpcollections.ng`;

        const transaction = await initializePaystackTransaction(
          placeholderEmail,
          totalNaira * 100,
          reference,
          { phone: from, productKey: paymentKey, zone: paymentZone }
        );

        if (transaction?.authorization_url) {
          await createPendingOrder(reference, {
            phone: from,
            productKey: paymentKey,
            zone: paymentZone,
            totalNaira,
            status: "pending",
          });

          const linkMessage =
            `Total: N${totalNaira.toLocaleString()} (N${productPrice.toLocaleString()} item + N${deliveryFee.toLocaleString()} delivery)\n` +
            `Pay here to lock in your order: ${transaction.authorization_url}`;

          await new Promise((resolve) => setTimeout(resolve, 900));
          await sendWhatsApp(from, linkMessage);
          console.log(`Amara -> ${from}: [sent payment link] ${reference}`);

          let paymentHistory = await getConversation(from);
          paymentHistory.push({ role: "assistant", content: linkMessage });
          paymentHistory = paymentHistory.slice(-10);
          await saveConversation(from, paymentHistory);
        } else {
          console.error(`Paystack link generation FAILED for ${from}, order ${reference}.`);
        }
      }
    }

    // If she flagged that the owner needs to step in, send that alert,
    // UNLESS the message that triggered it was just a bare greeting or
    // check-in. The prompt already tells her not to re-escalate on a
    // plain "hey", but that instruction alone isn't reliable enough on
    // its own, so this is a hard backstop, same idea as the emoji ban.
    // Checked per-line, since the buffer can combine several quick
    // messages ("Good morning" then "Hi") into one turn joined by
    // newlines, and each one alone still needs to count as a greeting.
    const BARE_GREETING_LINE =
      /^(h+i+|h+e+y+|hell+o+|yo+|good\s?(morning|afternoon|evening)|you\s?there\??|sup)[.!?]*$/i;
    const messageLines = combinedText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const isBareGreeting =
      messageLines.length > 0 && messageLines.every((line) => BARE_GREETING_LINE.test(line));
    if (escalationReason && isBareGreeting) {
      console.log(
        `Escalation SUPPRESSED (bare greeting, likely over-eager): "${combinedText}" | reason was: ${escalationReason}`
      );
    } else if (escalationReason) {
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
async function askAI(history, dynamicReminder = "") {
  try {
    // Safety cap: never let this hang forever if Anthropic's API is slow
    // or unreachable. 20 seconds is generous but bounded.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    // Facts that must never be forgotten (like which photos already went
    // out) get appended fresh to the system prompt on every single call,
    // rather than relying on them surviving inside the rolling chat
    // history, which can get pushed out during a long or busy conversation.
    const systemPrompt = dynamicReminder ? `${SHOP_PROFILE}\n\n${dynamicReminder}` : SHOP_PROFILE;

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
        system: systemPrompt,
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

// ---------- Pull the invisible [PAY: key, zone] tag out of the AI's reply ----------
function extractPaymentTag(text) {
  const match = text.match(/\[PAY:\s*(\w+)\s*,\s*(\w+)\]/i);
  if (!match) return { cleanText: text.trim(), paymentKey: null, paymentZone: null };

  const paymentKey = match[1].toLowerCase();
  const paymentZone = match[2].toLowerCase();
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, paymentKey, paymentZone };
}

// ---------- Guaranteed backstop: strip the banned "reflex" emoji ----------
// Prompt instructions are a strong nudge, not a hard rule, an AI can still
// slip and use a banned emoji anyway. This makes the ban actually airtight
// by removing it in code, regardless of what the AI outputs.
const BANNED_EMOJIS = /[\u{1F604}\u{1F601}]/gu; // 😄 and 😁
function stripBannedEmojis(text) {
  return text.replace(BANNED_EMOJIS, "").replace(/[ \t]{2,}/g, " ").trim();
}

// ---------- Guaranteed backstop: strip leaked self-correction ----------
// Occasionally the model drafts a reply, catches itself on something (like
// thinking it used a banned emoji), and narrates the correction out loud
// instead of just producing the fixed final text ("Wait, let me redo that
// without..."). If that happens, only the real final version should ever
// reach a customer or owner. This detects the pattern and keeps only the
// last paragraph, which is reliably where the corrected version lands.
const SELF_CORRECTION_MARKERS =
  /\b(let me redo|let me rewrite|wait,? let me|scratch that|let me try (that )?again|actually,? let me|here'?s a better (version|one)|redo(?:ing)? (that|this)|without the banned)\b/i;
function stripSelfCorrection(text) {
  if (!SELF_CORRECTION_MARKERS.test(text)) return text;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    console.error("Caught leaked self-correction, using final paragraph only. Raw:", text);
    return paragraphs[paragraphs.length - 1];
  }
  return text;
}

// ---------- Send a product photo on WhatsApp ----------
async function sendWhatsAppImage(to, imageUrl) {
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
          type: "image",
          image: { link: imageUrl },
        }),
      }
    );
    const data = await response.json();
    if (data.error) {
      console.error("WhatsApp image send error:", JSON.stringify(data.error));
      return { success: false, messageId: null };
    }
    // A successful response here means Meta QUEUED the send and will go
    // fetch imageUrl itself -- it does not mean the photo actually
    // reached the customer. If that fetch fails, Meta reports it later as
    // a separate "failed" status event carrying this message id, which is
    // why the caller tracks it instead of trusting this return value alone.
    const messageId = data.messages?.[0]?.id || null;
    return { success: true, messageId };
  } catch (err) {
    // Mirrors sendWhatsApp's own try/catch below. Without this, a network
    // blip here threw uncaught -- after the text reply ("here you go!")
    // had already gone out -- aborting the whole turn into the generic
    // "network wahala" fallback instead of anything that made sense next
    // to a broken photo promise.
    console.error("sendWhatsAppImage failed unexpectedly:", err.message);
    return { success: false, messageId: null };
  }
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
// ---------- Generate a contextual resume message ----------
// A generic "the owner's done" message doesn't reflect what the customer
// actually needed. This uses Amara's own voice to reference the real
// reason for the escalation, so a refund request and "let me speak to
// the owner" don't get the exact same boilerplate reply.
// ---------- Let the owner ask real questions, not just pause/resume ----------
// Gathers an honest snapshot of what's actually happening, so Amara can
// answer using real numbers instead of guessing or giving a static menu.
async function buildOwnerBusinessSummary() {
  const customers = await listAllCustomers();
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const activeToday = customers.filter(
    (c) => c.last_contact && c.last_contact.slice(0, 10) === todayStr
  );
  const pausedNow = customers.filter((c) => c.paused === "yes");
  const recentEscalations = customers
    .filter((c) => c.last_escalation_at)
    .sort((a, b) => new Date(b.last_escalation_at) - new Date(a.last_escalation_at))
    .slice(0, 8);

  const lines = [];
  lines.push(`Total customers ever talked to: ${customers.length}`);
  lines.push(
    `Customers active today: ${activeToday.length}` +
      (activeToday.length ? ` (${activeToday.map((c) => c.phone).join(", ")})` : "")
  );
  lines.push(`Currently paused (you're handling personally): ${pausedNow.length}`);
  for (const c of pausedNow) {
    lines.push(`  - ${c.phone}: ${c.last_escalation_reason || "no reason recorded"}`);
  }
  lines.push(`Recent escalations, most recent first:`);
  if (recentEscalations.length === 0) lines.push("  - none yet");
  for (const c of recentEscalations) {
    const status = c.paused === "yes" ? "[still paused / being handled]" : "[not currently paused]";
    lines.push(`  - ${c.phone} at ${c.last_escalation_at}: ${c.last_escalation_reason} ${status}`);
  }

  const paidCustomers = customers.filter((c) => c.last_payment_at);
  const paidToday = paidCustomers.filter((c) => c.last_payment_at.slice(0, 10) === todayStr);
  const totalPaidTodayNaira = paidToday.reduce(
    (sum, c) => sum + (Number(c.last_payment_amount) || 0),
    0
  );
  lines.push(
    `Payments today: ${paidToday.length} order(s), N${totalPaidTodayNaira.toLocaleString()} total`
  );
  lines.push(`Recent payments, most recent first:`);
  const recentPayments = paidCustomers
    .sort((a, b) => new Date(b.last_payment_at) - new Date(a.last_payment_at))
    .slice(0, 8);
  if (recentPayments.length === 0) lines.push("  - none yet");
  for (const c of recentPayments) {
    lines.push(`  - ${c.phone} at ${c.last_payment_at}: N${c.last_payment_amount} (ref ${c.last_payment_reference})`);
  }

  return lines.join("\n");
}

async function answerOwnerQuestion(ownerText, businessSummary) {
  const fallback =
    "Hey, having a bit of trouble pulling that up right now, mind trying again in a moment?";
  try {
    const instruction =
      `[Internal note: you're talking directly to the shop owner right now, ` +
      `not a customer. They just asked or said something. Answer using ONLY ` +
      `the real data below, honestly. If the data doesn't actually answer ` +
      `their question, say so plainly rather than guessing or making up ` +
      `numbers. Keep it short and natural, WhatsApp style, like texting ` +
      `your boss, not a customer.\n\n` +
      `CURRENT BUSINESS DATA:\n${businessSummary}\n\n` +
      `Reminder in case it's relevant: they can also say "pause <number>" ` +
      `or "pause last" to have you step back from a customer, and ` +
      `"resume <number>" / "resume last" to pick back up, either as exact ` +
      `commands or said naturally. Don't mention this unless it's actually ` +
      `relevant to what they asked. Output ONLY the final message itself, ` +
      `nothing else, no drafts, no narrating your own corrections, no ` +
      `"let me redo that", just the finished text ready to send.]\n\n` +
      `Owner's message: "${ownerText}"`;
    const reply = await askAI([{ role: "user", content: instruction }]);
    const { cleanText: step1 } = extractPhotoTag(reply);
    const { cleanText: step2 } = extractEscalationTag(step1);
    const finalText = stripBannedEmojis(stripSelfCorrection(step2)).trim();
    return finalText || fallback;
  } catch (err) {
    console.error("answerOwnerQuestion failed:", err.message);
    return fallback;
  }
}


async function generateResumeFollowUp(reason, ownerMessage) {
  const genericFallback =
    "Hey, I'm back! The owner just finished handling things on their end. Let me know if you still need anything.";

  if (!reason) return genericFallback;

  try {
    const instruction =
      `[Internal note, not a real customer message: the owner just resumed ` +
      `you on this customer's issue, which was: "${reason}". The owner's ` +
      `own message when doing this was: "${ownerMessage}".\n\n` +
      `If that message contains real, specific detail about what was said ` +
      `or done (e.g. what price was agreed, what was explained, what was ` +
      `promised), reference those specific details naturally when you tell ` +
      `the customer.\n\n` +
      `If it's just a bare confirmation with no real detail (things like ` +
      `"sure", "done", "continue", "ok", "you can continue"), do NOT assert ` +
      `a specific outcome you can't actually confirm happened, especially ` +
      `don't claim the owner personally spoke with or contacted the ` +
      `customer if you have no way of knowing that's true. Be warm but ` +
      `honest instead, for example checking in on whether the owner already ` +
      `reached them, rather than asserting it as fact.\n\n` +
      `Send a short, warm, natural message in your usual voice. Don't use ` +
      `a [PHOTO] tag or an [ESCALATE] tag here. Output ONLY the final ` +
      `message itself, nothing else, no drafts, no narrating your own ` +
      `corrections, no "let me redo that", just the finished text ready ` +
      `to send.]`;
    const reply = await askAI([{ role: "user", content: instruction }]);
    const { cleanText: step1 } = extractPhotoTag(reply);
    const { cleanText: step2 } = extractEscalationTag(step1);
    const finalText = stripBannedEmojis(stripSelfCorrection(step2)).trim();
    return finalText || genericFallback;
  } catch (err) {
    console.error("generateResumeFollowUp failed:", err.message);
    return genericFallback;
  }
}


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
    // If Amara just asked "want to pause?" (an escalation alert), a
    // short bare affirmative right after it clearly means "yes, pause",
    // even though the same word alone, with no context, would be too
    // ambiguous to guess at. Check this deterministically before
    // spending an AI call on it.
    const trimmed = text.trim().toLowerCase();
    const isShortAffirmative = /^(sure|yes|yeah|yep|yh|ok|okay|alright)[.!]?$/i.test(trimmed);
    if (isShortAffirmative) {
      let awaitingPauseConfirmation = false;
      try {
        awaitingPauseConfirmation = !!(await redisCommand(["GET", "awaiting_pause_confirmation"]));
      } catch (err) {
        console.error("Could not check awaiting_pause_confirmation flag:", err.message);
      }
      if (awaitingPauseConfirmation) {
        command = { action: "pause", target: "last" };
        try {
          await redisCommand(["DEL", "awaiting_pause_confirmation"]);
        } catch (err) {
          console.error("Could not clear awaiting_pause_confirmation flag:", err.message);
        }
      }
    }
  }

  if (!command) {
    // No exact match. Ask the AI whether this was natural-language
    // pause/resume phrasing before giving up and showing the help menu.
    const intent = await interpretOwnerIntent(text);
    if (intent === "PAUSE") command = { action: "pause", target: "last" };
    else if (intent === "RESUME") command = { action: "resume", target: "last" };
  }

  if (!command) {
    // Not a pause/resume command, exact or natural-language. Rather than a
    // static help menu, let her actually answer, using real business data,
    // the same way a normal conversation would work.
    const businessSummary = await buildOwnerBusinessSummary();
    const answer = await answerOwnerQuestion(text, businessSummary);
    await sendWhatsApp(OWNER_PHONE_NUMBER, answer);
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

    // Proactively let the customer know, rather than leaving them to
    // wonder, or risking Amara improvising a stale "still waiting" reply
    // if they happen to message again before anyone's told her otherwise.
    // What she actually says reflects what they needed, not a generic line.
    const customerRecord = await getCustomer(target);
    const followUp = await generateResumeFollowUp(customerRecord?.last_escalation_reason, text);
    const notified = await sendWhatsApp(target, followUp);
    if (notified) {
      let customerHistory = await getConversation(target);
      customerHistory.push({ role: "assistant", content: followUp });
      customerHistory = customerHistory.slice(-10);
      await saveConversation(target, customerHistory);
      console.log(`Amara -> ${target}: [proactive resume notification] ${followUp}`);
    } else {
      // Most likely cause: more than 24 hours since the customer last
      // messaged, so a free-form message isn't allowed. Not fatal, the
      // customer just won't hear from us until they message again.
      console.error(
        `Could not proactively notify customer ${target} after resume (likely outside the 24h messaging window).`
      );
    }
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

  // Remember that we just asked "want to pause?", so a short reply like
  // "Sure" or "Yes" right after this can be understood as agreement,
  // instead of being ambiguous out of context.
  try {
    await redisCommand(["SET", "awaiting_pause_confirmation", "1", "EX", "600"]); // 10 min window
  } catch (err) {
    console.error("Could not set awaiting_pause_confirmation flag:", err.message);
  }

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

// ---------- Customer list (simple read-only table; see /dashboard for the live cockpit) ----------
// Visit /customers?key=YOUR_ADMIN_KEY in any browser to see every customer
// Amara has ever talked to, in one place. Kept around as a plain,
// zero-JS fallback view of the same data the dashboard below uses.
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
      const paidBadge = c.last_payment_at
        ? `<span style="color:#15803d;font-weight:600;">N${Number(c.last_payment_amount || 0).toLocaleString()}</span>`
        : "";
      return `<tr>
        <td>${c.phone || ""}</td>
        <td>${pausedBadge}</td>
        <td>${c.first_contact ? new Date(c.first_contact).toLocaleString() : ""}</td>
        <td>${c.last_contact ? new Date(c.last_contact).toLocaleString() : ""}</td>
        <td>${c.message_count || 0}</td>
        <td>${c.last_escalation_reason || ""}</td>
        <td>${c.last_escalation_at ? new Date(c.last_escalation_at).toLocaleString() : ""}</td>
        <td>${paidBadge}</td>
        <td>${c.last_payment_at ? new Date(c.last_payment_at).toLocaleString() : ""}</td>
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
      <h1>Customers (${customers.length}) — <a href="/dashboard?key=${ADMIN_KEY}" style="font-size:14px;">Open live dashboard →</a></h1>
      <table>
        <tr>
          <th>Phone</th><th>Status</th><th>First contact</th><th>Last contact</th>
          <th>Messages</th><th>Last escalation</th><th>Escalated at</th>
          <th>Last payment</th><th>Paid at</th>
        </tr>
        ${rows || '<tr><td colspan="9">No customers yet.</td></tr>'}
      </table>
    </body>
    </html>
  `);
});

// ---------- OWNER DASHBOARD (Stage 4 cockpit) ----------
// A lightweight, self-contained live dashboard: every conversation at a
// glance, the ability to open one and actually read it, and a one-click
// takeover switch that reuses the exact same pause/resume machinery the
// owner already controls today from plain WhatsApp text ("pause last" /
// "resume last"). No separate frontend app, no new dependencies — just
// another Express route serving HTML + vanilla JS that polls a small
// JSON API every few seconds. Good enough for one owner watching a
// handful of live conversations; a real realtime layer (websockets) can
// replace the polling later without touching anything else.

async function getDashboardStats(customers) {
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const activeToday = customers.filter(
    (c) => c.last_contact && c.last_contact.slice(0, 10) === todayStr
  );
  const pausedNow = customers.filter((c) => c.paused === "yes");
  const paidToday = customers.filter(
    (c) => c.last_payment_at && c.last_payment_at.slice(0, 10) === todayStr
  );
  const revenueTodayNaira = paidToday.reduce(
    (sum, c) => sum + (Number(c.last_payment_amount) || 0),
    0
  );
  return {
    totalCustomers: customers.length,
    activeToday: activeToday.length,
    pausedNow: pausedNow.length,
    paymentsToday: paidToday.length,
    revenueTodayNaira,
  };
}

function dashboardHtml(key) {
  // The admin key gets embedded into the page's own JS so its fetch calls
  // can authenticate, same trust boundary as the ?key= on the page itself
  // — anyone who could load this page already has the key.
  return `
    <html>
    <head>
      <title>KP Studio — Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f8fafc; color: #1e293b; }
        header { background: #1e293b; color: white; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
        header h1 { font-size: 18px; margin: 0; }
        header a { color: #93c5fd; font-size: 12px; }
        .stats { display: flex; gap: 12px; flex-wrap: wrap; }
        .stat { background: rgba(255,255,255,0.08); padding: 6px 12px; border-radius: 6px; font-size: 13px; white-space: nowrap; }
        .stat b { font-size: 15px; }
        .layout { display: flex; height: calc(100vh - 64px); }
        .list { width: 320px; border-right: 1px solid #e2e8f0; overflow-y: auto; background: white; flex-shrink: 0; }
        .list-item { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
        .list-item:hover { background: #f8fafc; }
        .list-item.active-row { background: #eff6ff; }
        .list-item .phone { font-weight: 600; font-size: 14px; }
        .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-left: 6px; }
        .badge.paused { background: #fef3c7; color: #b45309; }
        .badge.active { background: #dcfce7; color: #15803d; }
        .badge.paid { background: #dbeafe; color: #1d4ed8; }
        .snippet { font-size: 12px; color: #64748b; margin-top: 4px; }
        .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .thread-header { padding: 16px 24px; border-bottom: 1px solid #e2e8f0; background: white; display: flex; align-items: center; justify-content: space-between; }
        .thread { flex: 1; overflow-y: auto; padding: 24px; }
        .bubble { max-width: 70%; padding: 10px 14px; border-radius: 12px; margin-bottom: 10px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
        .bubble.user { background: #e2e8f0; margin-right: auto; }
        .bubble.assistant { background: #1e293b; color: white; margin-left: auto; }
        button.takeover-btn { padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; }
        button.takeover-btn.take { background: #b45309; color: white; }
        button.takeover-btn.hand { background: #15803d; color: white; }
        .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #94a3b8; font-size: 14px; padding: 24px; text-align: center; }
      </style>
    </head>
    <body>
      <header>
        <h1>KP Studio — Live Dashboard &nbsp; <a href="/customers?key=${key}">plain table view</a></h1>
        <div class="stats" id="stats"></div>
      </header>
      <div class="layout">
        <div class="list" id="list"><div class="empty">Loading…</div></div>
        <div class="main" id="main"><div class="empty">Select a conversation on the left</div></div>
      </div>
      <script>
        const KEY = ${JSON.stringify(key)};
        let selectedPhone = null;
        let customersCache = [];

        function escapeHtml(str) {
          return String(str || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
        }

        async function loadDashboard() {
          try {
            const res = await fetch("/api/dashboard-data?key=" + encodeURIComponent(KEY));
            const data = await res.json();
            if (data.error) return;
            customersCache = data.customers;
            renderStats(data.stats);
            renderList(data.customers);
            if (selectedPhone) loadConversation(selectedPhone, false);
          } catch (err) {
            console.error("dashboard load failed", err);
          }
        }

        function renderStats(stats) {
          document.getElementById("stats").innerHTML =
            '<div class="stat"><b>' + stats.totalCustomers + '</b> total</div>' +
            '<div class="stat"><b>' + stats.activeToday + '</b> active today</div>' +
            '<div class="stat"><b>' + stats.pausedNow + '</b> paused</div>' +
            '<div class="stat"><b>N' + stats.revenueTodayNaira.toLocaleString() + '</b> today (' + stats.paymentsToday + ' order' + (stats.paymentsToday === 1 ? "" : "s") + ')</div>';
        }

        function renderList(customers) {
          const list = document.getElementById("list");
          if (customers.length === 0) {
            list.innerHTML = '<div class="empty">No customers yet.</div>';
            return;
          }
          list.innerHTML = customers.map((c) => {
            const isActiveRow = c.phone === selectedPhone;
            const statusBadge = c.paused === "yes"
              ? '<span class="badge paused">Paused</span>'
              : '<span class="badge active">Active</span>';
            const paidBadge = c.last_payment_at ? '<span class="badge paid">Paid</span>' : "";
            const lastContact = c.last_contact ? new Date(c.last_contact).toLocaleString() : "";
            const escalationLine = c.last_escalation_reason
              ? '<div class="snippet">⚠ ' + escapeHtml(c.last_escalation_reason) + '</div>'
              : "";
            return '<div class="list-item' + (isActiveRow ? " active-row" : "") + '" onclick="loadConversation(\\'' + c.phone + '\\', true)">' +
              '<div class="phone">' + escapeHtml(c.phone) + statusBadge + paidBadge + '</div>' +
              '<div class="snippet">' + (c.message_count || 0) + ' messages · last ' + lastContact + '</div>' +
              escalationLine +
              '</div>';
          }).join("");
        }

        async function loadConversation(phone, isClick) {
          selectedPhone = phone;
          if (isClick) renderList(customersCache); // re-highlight the selected row immediately
          try {
            const res = await fetch("/api/conversation?phone=" + encodeURIComponent(phone) + "&key=" + encodeURIComponent(KEY));
            const data = await res.json();
            if (data.error) return;
            renderThread(phone, data.history, data.customer);
          } catch (err) {
            console.error("conversation load failed", err);
          }
        }

        function renderThread(phone, history, customer) {
          const isPaused = customer && customer.paused === "yes";
          const main = document.getElementById("main");
          main.innerHTML =
            '<div class="thread-header">' +
              '<div><b>' + escapeHtml(phone) + '</b></div>' +
              '<button class="takeover-btn ' + (isPaused ? "hand" : "take") + '" onclick="toggleTakeover(\\'' + phone + '\\', ' + (isPaused ? "true" : "false") + ')">' +
                (isPaused ? "Hand back to Amara" : "Take over") +
              '</button>' +
            '</div>' +
            '<div class="thread" id="thread"></div>';
          const threadEl = document.getElementById("thread");
          threadEl.innerHTML = (history && history.length > 0)
            ? history.map((m) => '<div class="bubble ' + (m.role === "user" ? "user" : "assistant") + '">' + escapeHtml(m.content) + '</div>').join("")
            : '<div class="empty">No messages yet.</div>';
          threadEl.scrollTop = threadEl.scrollHeight;
        }

        async function toggleTakeover(phone, isPaused) {
          const endpoint = isPaused ? "/api/handback" : "/api/takeover";
          try {
            await fetch(endpoint + "?key=" + encodeURIComponent(KEY), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phone: phone }),
            });
            loadDashboard();
            loadConversation(phone, false);
          } catch (err) {
            console.error("takeover toggle failed", err);
          }
        }

        loadDashboard();
        setInterval(loadDashboard, 5000); // simple polling stands in for realtime for now
      </script>
    </body>
    </html>
  `;
}

app.get("/dashboard", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL.");
  }
  res.send(dashboardHtml(req.query.key));
});

app.get("/api/dashboard-data", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  try {
    const customers = await listAllCustomers();
    customers.sort((a, b) => new Date(b.last_contact || 0) - new Date(a.last_contact || 0));
    const stats = await getDashboardStats(customers);
    res.json({ stats, customers });
  } catch (err) {
    console.error("api/dashboard-data failed:", err.message);
    res.status(500).json({ error: "failed to load dashboard data" });
  }
});

app.get("/api/conversation", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    const history = await getConversation(phone);
    const customer = await getCustomer(phone);
    res.json({ history, customer });
  } catch (err) {
    console.error("api/conversation failed:", err.message);
    res.status(500).json({ error: "failed to load conversation" });
  }
});

app.post("/api/takeover", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const phone = req.body?.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    // Same pauseCustomer() the owner already triggers via "pause last" on
    // WhatsApp — the dashboard button is just a second door into the
    // identical, already-tested mechanism, not a separate code path.
    await pauseCustomer(phone);
    console.log(`Dashboard takeover: owner took over ${phone} from the web dashboard.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/takeover failed:", err.message);
    res.status(500).json({ error: "failed to take over" });
  }
});

app.post("/api/handback", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const phone = req.body?.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    await resumeCustomer(phone);

    // Same proactive, context-aware notification the customer already
    // gets when the owner resumes via WhatsApp text — the dashboard is
    // just a different door into the same handback, so the customer
    // experience should be identical either way, not a lesser version.
    const customerRecord = await getCustomer(phone);
    const followUp = await generateResumeFollowUp(
      customerRecord?.last_escalation_reason,
      "Handled directly, resumed from the owner dashboard."
    );
    const notified = await sendWhatsApp(phone, followUp);
    if (notified) {
      let history = await getConversation(phone);
      history.push({ role: "assistant", content: followUp });
      history = history.slice(-10);
      await saveConversation(phone, history);
    }
    console.log(`Dashboard handback: owner resumed ${phone} from the web dashboard.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/handback failed:", err.message);
    res.status(500).json({ error: "failed to hand back" });
  }
});

// ---------- PAYSTACK WEBHOOK (automatic payment confirmation) ----------
// Paystack calls this the instant a payment actually completes. We verify
// the signature so nobody can fake a "payment succeeded" call by hitting
// this URL directly with a browser or curl, then confirm the customer and
// alert the owner automatically, no manual bank-screenshot matching
// needed for anything paid through this link.
app.post("/paystack-webhook", async (req, res) => {
  // Always acknowledge fast, same reasoning as the WhatsApp webhook above:
  // don't make Paystack retry just because our own processing is slow.
  res.sendStatus(200);

  try {
    if (!PAYSTACK_SECRET_KEY) {
      console.error("Paystack webhook fired but PAYSTACK_SECRET_KEY isn't set, ignoring.");
      return;
    }

    // Signature check using the RAW request bytes (captured by the
    // express.json() verify hook up top), not the re-serialized body —
    // those can differ in whitespace/key order and silently break this.
    const signature = req.headers["x-paystack-signature"];
    const expectedSignature = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("Paystack webhook signature mismatch, ignoring (possible spoofed call).");
      return;
    }

    const event = req.body;
    if (event.event !== "charge.success") return; // only care about successful payments

    const reference = event.data?.reference;
    if (!reference) return;

    const order = await getPendingOrder(reference);
    if (!order) {
      console.error(`Paystack webhook: no matching pending order for reference ${reference}.`);
      return;
    }
    if (order.status === "paid") {
      console.log(`Paystack webhook: order ${reference} already processed, ignoring duplicate call.`);
      return;
    }

    await markOrderPaid(reference, order);

    const productName = PRODUCT_NAMES[order.productKey] || order.productKey;

    // Deterministic confirmation text, NOT AI-generated: this is a real
    // money confirmation reaching a real customer, not a place to risk
    // any AI phrasing drift or hallucinated detail.
    const confirmationText =
      `Payment received! ✅ Your ${productName} (N${order.totalNaira.toLocaleString()}) is confirmed, ` +
      `we'll get it sorted for delivery. Thank you!`;
    await sendWhatsApp(order.phone, confirmationText);

    let history = await getConversation(order.phone);
    history.push({ role: "assistant", content: confirmationText });
    history = history.slice(-10);
    await saveConversation(order.phone, history);

    await upsertCustomer(order.phone, {
      last_payment_reference: reference,
      last_payment_amount: order.totalNaira,
      last_payment_at: new Date().toISOString(),
    });

    if (OWNER_PHONE_NUMBER) {
      const ownerNote =
        `💰 Payment received\n\n` +
        `Customer: ${order.phone}\n` +
        `Item: ${productName}\n` +
        `Amount: N${order.totalNaira.toLocaleString()}\n` +
        `Ref: ${reference}`;
      const notified = await sendWhatsApp(OWNER_PHONE_NUMBER, ownerNote);
      if (!notified) {
        // Most likely cause: more than 24h since the owner last messaged
        // Amara, so a free-form message isn't allowed. Unlike escalation
        // alerts, there's no approved template fallback for this yet —
        // worth adding one (e.g. "payment_alert_v1") if this ever bites.
        console.error(
          `Could not notify owner of payment ${reference} (likely outside the 24h window, no template fallback set up for this yet).`
        );
      }
    }

    console.log(
      `Payment CONFIRMED: ${reference} — ${order.phone} paid N${order.totalNaira} for ${order.productKey}`
    );
  } catch (err) {
    console.error("Paystack webhook handler crashed:", err);
  }
});

// ---------- Health check (visit in browser to see server is alive) ----------
app.get("/", (req, res) => {
  res.send("KP Sales Assistant is running ✓");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
