// ============================================================
// KP SALES ASSISTANT — Demo Server v1
// Receives WhatsApp messages -> thinks with AI -> replies
// ============================================================

const express = require("express");
const zlib = require("zlib");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const app = express();
app.use(cookieParser());
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
// Needed for the signup/login HTML forms below (plain <form method="POST">
// submissions arrive as x-www-form-urlencoded, not JSON).
app.use(express.urlencoded({ extended: true }));

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

// Signs seller login session cookies (see SELLER ACCOUNTS below). Set a
// real random value in Render — the fallback here only exists so local
// boot-testing doesn't crash, and is deliberately obvious/unsafe so nobody
// mistakes it for production-ready.
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";

// ---------- PRODUCT PRICES & DELIVERY FEES (server-side source of truth) ----------
// Amara's prompt states these same numbers so she can talk about them
// naturally, but the ACTUAL amount ever charged through a payment link is
// computed here in code, never trusted from anything the AI free-texts.
// Same "prompt is a suggestion, code is the guarantee" pattern as the
// other backstops in this file (banned emojis, photo resends), just
// applied to money, where it matters most.
//
// These start out as the hardcoded demo catalog below, but from here on
// they're editable live from the dashboard's Catalog tab (add/edit/remove
// a product, change delivery fees) and persisted in Redis, so a restart
// or redeploy never reverts an owner's real edits back to this demo data.
// They're declared with `let` and mutated in place (see loadCatalogFromRedis
// and the /api/catalog routes near the bottom of this file) rather than
// reassigned, so every other place in this file that reads from these same
// objects automatically sees the current catalog without needing its own
// Redis call.
// NOTE (Phase C, multi-tenant rewrite): these are no longer THE live
// catalog — that's now per-seller (see sellerCatalogs / ensureCatalogEntry
// below). These stay as literal, hardcoded values used ONLY to seed
// seller1 (the original KP Collections shop) the very first time it ever
// loads with nothing in Redis yet -- exactly what used to happen anyway.
// A brand new seller signing up later starts with a genuinely empty
// catalog of their own, never this demo data.
const DEFAULT_PRODUCT_PRICES = {
  tee: 7500,
  hoodie: 18000,
  jacket: 25000,
  cap: 5000,
  joggers: 15500,
};
const DEFAULT_PRODUCT_NAMES = {
  tee: "Plain white tee",
  hoodie: "Black graphic hoodie",
  jacket: "Denim jacket",
  cap: "Classic baseball cap",
  joggers: "Cargo joggers",
};
const DEFAULT_DELIVERY_FEES = {
  lagos: 2000,
  outside: 3500,
};

// ---------- NIGERIA-WIDE DELIVERY (state-level coverage) ----------
// The canonical list of Nigerian states (36) + the FCT, used to (a) drive
// the "add a state" dropdown on the dashboard's Delivery fees card and
// (b) validate any slug a seller tries to save, so a stored delivery zone
// can never be something Amara can't actually reason about. Slugs are
// deliberately plain lowercase words with no spaces or hyphens -- they
// double as the "zone" code inside the AI's [PAY: key, zone] tag (see
// extractPaymentTag), and that tag is parsed with a \w+ regex, so a slug
// with a space or hyphen in it would silently fail to match. "outside" is
// reserved separately (never a real state) as the zone code for the
// fallback/default fee below, exactly like the old two-tier model.
const NIGERIA_STATES = [
  { slug: "abia", name: "Abia" },
  { slug: "adamawa", name: "Adamawa" },
  { slug: "akwaibom", name: "Akwa Ibom" },
  { slug: "anambra", name: "Anambra" },
  { slug: "bauchi", name: "Bauchi" },
  { slug: "bayelsa", name: "Bayelsa" },
  { slug: "benue", name: "Benue" },
  { slug: "borno", name: "Borno" },
  { slug: "crossriver", name: "Cross River" },
  { slug: "delta", name: "Delta" },
  { slug: "ebonyi", name: "Ebonyi" },
  { slug: "edo", name: "Edo" },
  { slug: "ekiti", name: "Ekiti" },
  { slug: "enugu", name: "Enugu" },
  { slug: "fct", name: "FCT (Abuja)" },
  { slug: "gombe", name: "Gombe" },
  { slug: "imo", name: "Imo" },
  { slug: "jigawa", name: "Jigawa" },
  { slug: "kaduna", name: "Kaduna" },
  { slug: "kano", name: "Kano" },
  { slug: "katsina", name: "Katsina" },
  { slug: "kebbi", name: "Kebbi" },
  { slug: "kogi", name: "Kogi" },
  { slug: "kwara", name: "Kwara" },
  { slug: "lagos", name: "Lagos" },
  { slug: "nasarawa", name: "Nasarawa" },
  { slug: "niger", name: "Niger" },
  { slug: "ogun", name: "Ogun" },
  { slug: "ondo", name: "Ondo" },
  { slug: "osun", name: "Osun" },
  { slug: "oyo", name: "Oyo" },
  { slug: "plateau", name: "Plateau" },
  { slug: "rivers", name: "Rivers" },
  { slug: "sokoto", name: "Sokoto" },
  { slug: "taraba", name: "Taraba" },
  { slug: "yobe", name: "Yobe" },
  { slug: "zamfara", name: "Zamfara" },
];
const NIGERIA_STATE_NAMES = Object.fromEntries(NIGERIA_STATES.map((s) => [s.slug, s.name]));
const VALID_STATE_SLUGS = new Set(NIGERIA_STATES.map((s) => s.slug));

// Bank transfer details, offered as a fallback alongside the Paystack
// payment link (see buildShopProfile's RULES section). Owner-editable
// from the dashboard's Catalog tab, same live-update + Redis-persist
// pattern as everything else on this page -- not editable by customers,
// this is purely an owner-facing setting, same trust boundary as the
// rest of the dashboard (gated by ADMIN_KEY).
const DEFAULT_BANK_DETAILS = {
  bankName: "GTBank",
  accountNumber: "0123456789",
  accountName: "KP Collections",
};

// ---------- PER-SELLER STATE (Phase C: multi-tenant message engine) ----------
// Everything that used to be one global shop -- catalog, WhatsApp
// credentials, owner phone, bank details -- now lives per-seller, keyed by
// sellerId, so the same running server can serve many independent sellers
// at once, each with their own catalog, their own connected WhatsApp
// number, and their own fully separate customer/conversation/order data.
//
// The original demo shop becomes "seller1" below. ADMIN_KEY keeps working
// exactly as before as a fixed alias to seller1, and seller1's Redis keys
// stay completely UNPREFIXED (conv:<phone>, customer:<phone>,
// catalog:products, etc, exactly as they've always been) -- no data
// migration needed, nothing about the live dashboard or the current dry
// run changes underneath it. Every other seller's keys get an
// `s:<sellerId>:` prefix instead. See nsKey() below.
const SELLER1_ID = "seller1";

function nsKey(sellerId, key) {
  return sellerId === SELLER1_ID ? key : `s:${sellerId}:${key}`;
}

// In-memory catalog cache, one entry per seller -- same shape and same
// cache-aside pattern as the old globals (mutated in place, persisted to
// Redis separately, rebuilt into the AI prompt on every message).
const sellerCatalogs = {};

function ensureCatalogEntry(sellerId) {
  if (!sellerCatalogs[sellerId]) {
    sellerCatalogs[sellerId] = {
      PRODUCT_PRICES: {},
      PRODUCT_NAMES: {},
      PRODUCT_IMAGES: {},
      PRODUCT_DESCRIPTIONS: {},
      // Per-state delivery fees. Only states a seller explicitly added
      // show up here (that's what "which states do you deliver to" means
      // in practice), keyed by the slugs in NIGERIA_STATES above.
      // DELIVERY_DEFAULT_FEE is an optional catch-all price for any
      // Nigerian state NOT explicitly listed -- null means "we don't
      // deliver anywhere else yet," matching the old behavior before a
      // seller had opted into a fallback.
      DELIVERY_STATES: {},
      DELIVERY_DEFAULT_FEE: null,
      BANK_DETAILS: { bankName: "", accountNumber: "", accountName: "" },
      // Optional second account -- e.g. a different bank, or a second
      // person's account, offered as an alternative to the primary one.
      // Stays empty (bankName: "") until a seller explicitly adds it from
      // the dashboard; Amara only ever mentions it if it's actually set.
      BANK_DETAILS_2: { bankName: "", accountNumber: "", accountName: "" },

      // ---- Bookable-seller fields (businessType "bookable") ----
      // Sit empty and unused for a goods seller, same cache-aside pattern
      // as everything above. See the Stage 2 services architecture plan
      // for the reasoning: one shared calendar per seller (a single
      // resource), the seller owns every fact here, nothing is ever
      // decided by the AI.
      OFFERINGS: {}, // key -> { name, price, durationMinutes, description }
      WEEKLY_AVAILABILITY: [], // [{ id, day (0=Sun..6=Sat), startTime "HH:MM", endTime "HH:MM" }]
      BLOCKED_DATES: [], // ["YYYY-MM-DD", ...] -- specific exception days
      BOOKINGS: [], // [{ id, offeringKey, date, time, phone, reference, status, createdAt }]
    };
  }
  return sellerCatalogs[sellerId];
}

// Reverse index: Meta's phone_number_id -> which seller that WhatsApp
// number belongs to. This is what lets one shared /webhook URL route each
// incoming message to the right seller's data, catalog, and AI prompt.
const phoneNumberIdToSellerId = {};
function registerSellerPhoneNumberId(sellerId, phoneNumberId) {
  if (phoneNumberId) phoneNumberIdToSellerId[phoneNumberId] = sellerId;
}

// Full seller context (identity + WhatsApp credentials + catalog),
// resolved once per process per seller and cached in memory from then on
// -- same cache-aside philosophy as everything else in this file. Call
// invalidateSellerContextCache(sellerId) after changing a seller's stored
// credentials so the next access picks up the change.
const sellerContextCache = {};

async function loadSellerCreds(sellerId) {
  const stored = await getSellerById(sellerId);
  if (sellerId === SELLER1_ID) {
    // seller1's credentials are the original env vars, unless an admin
    // has explicitly reconnected seller1 to a different number via the
    // same manual-connect route every other seller uses -- that write
    // overwrites these fields in Redis, which then take priority.
    return {
      phoneNumberId: stored?.phoneNumberId || PHONE_NUMBER_ID,
      whatsappToken: stored?.whatsappToken || WHATSAPP_TOKEN,
      ownerPhoneNumber: stored?.ownerPhoneNumber || OWNER_PHONE_NUMBER,
    };
  }
  return {
    phoneNumberId: stored?.phoneNumberId || null,
    whatsappToken: stored?.whatsappToken || null,
    ownerPhoneNumber: stored?.ownerPhoneNumber || null,
  };
}

async function getSellerContext(sellerId) {
  if (sellerContextCache[sellerId]) return sellerContextCache[sellerId];
  const record = await getSellerById(sellerId);
  if (sellerId !== SELLER1_ID && !record) return null; // unknown seller
  const creds = await loadSellerCreds(sellerId);
  await loadCatalogFromRedis(sellerId); // populates sellerCatalogs[sellerId]
  const context = {
    sellerId,
    businessName: record?.businessName || (sellerId === SELLER1_ID ? "KP Collections" : "Your shop"),
    status: record?.status || (sellerId === SELLER1_ID ? "active" : "pending_whatsapp_connection"),
    // "goods" (physical products, delivery, the original shop model) or
    // "bookable" (appointment-style services -- consultations and similar,
    // see the Stage 2 services architecture plan). Missing/unrecognized
    // always falls back to "goods", so every seller that existed before
    // this field was introduced (including seller1) keeps behaving exactly
    // as it always has, with zero migration needed.
    businessType: record?.businessType === "bookable" ? "bookable" : "goods",
    // Admin-only kill switch (see /api/admin/suspend-seller): true means the
    // webhook drops every incoming message for this seller without replying,
    // without touching any of their stored data. Independent of `status`
    // above, which tracks WhatsApp connection state, not whether the seller
    // is allowed to talk to customers right now.
    suspended: record?.suspended === "1",
    phoneNumberId: creds.phoneNumberId,
    whatsappToken: creds.whatsappToken,
    ownerPhoneNumber: creds.ownerPhoneNumber,
    catalog: ensureCatalogEntry(sellerId),
  };
  sellerContextCache[sellerId] = context;
  if (context.phoneNumberId) registerSellerPhoneNumberId(sellerId, context.phoneNumberId);
  return context;
}

function invalidateSellerContextCache(sellerId) {
  delete sellerContextCache[sellerId];
}

// Resolves which seller's data a dashboard/API request is acting on.
// Path 1 (legacy, unchanged): ?key=ADMIN_KEY always resolves to seller1 --
// every existing dashboard URL and bookmark keeps working exactly as
// before. Path 2 (new): a logged-in seller's own session cookie resolves
// to their own sellerId, so once a seller's WhatsApp is connected, this
// same dashboard UI works for them too, scoped to only their own data,
// with no separate frontend needed.
async function resolveActingSeller(req) {
  if (ADMIN_KEY && req.query.key === ADMIN_KEY) {
    // The master admin key can act as ANY seller by adding &sellerId=<id>
    // to the URL -- the /admin panel builds these links so nobody has to
    // type or remember a sellerId by hand. With no sellerId at all, this
    // still resolves to seller1 exactly as it always has, so every
    // existing bookmark and URL keeps working unchanged.
    const requestedSellerId = String(req.query.sellerId || "").trim();
    if (requestedSellerId) {
      const seller = await getSellerContext(requestedSellerId);
      if (seller) return seller;
      // Unknown sellerId: fall through to seller1 rather than silently
      // acting on the wrong account.
    }
    return await getSellerContext(SELLER1_ID);
  }
  const sellerId = verifySession(req.cookies?.session);
  if (sellerId) {
    const seller = await getSellerContext(sellerId);
    if (seller) return seller;
  }
  return null;
}

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

// Placeholders for the original 5 demo products, generated once at
// startup. Any product added later from the dashboard's Catalog tab
// doesn't have a fixed color baked in here, so its placeholder gets
// generated the first time it's actually requested (see getOrMakePlaceholder
// below) and cached from then on, rather than needing a server restart.
const PRODUCT_IMAGE_BUFFERS = {
  tee: makeSolidPng(600, 600, 245, 245, 245),
  hoodie: makeSolidPng(600, 600, 26, 26, 26),
  jacket: makeSolidPng(600, 600, 44, 62, 99),
  cap: makeSolidPng(600, 600, 139, 90, 43),
  joggers: makeSolidPng(600, 600, 58, 58, 58),
};

// A new product (added from the dashboard, with no photo URL of its own)
// still needs *some* image to send, or the [PHOTO: key] flow would just
// fail. Derive a color deterministically from the key so different new
// products at least look visually distinct from one another, rather than
// every single one defaulting to identical grey.
function getOrMakePlaceholder(key) {
  if (PRODUCT_IMAGE_BUFFERS[key]) return PRODUCT_IMAGE_BUFFERS[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const r = 40 + (hash % 180);
  const g = 40 + ((hash >> 8) % 180);
  const b = 40 + ((hash >> 16) % 180);
  PRODUCT_IMAGE_BUFFERS[key] = makeSolidPng(600, 600, r, g, b);
  return PRODUCT_IMAGE_BUFFERS[key];
}

// Serve them at simple, predictable URLs that WhatsApp can fetch.
app.get("/images/:key.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(getOrMakePlaceholder(req.params.key));
});

// ---------- REAL PRODUCT PHOTOS (self-hosted, still no third-party service) ----------
// Sellers can now upload an actual photo of a product from the dashboard
// instead of only pasting a URL to somewhere it's already hosted. Kept
// consistent with the placeholder photos above: no S3, no Cloudinary, no
// new account to sign up for anywhere. The uploaded image bytes go straight
// into the same Redis instance already storing everything else, base64-
// encoded under catalog:photo:<key>, so they survive a restart or redeploy
// exactly like the rest of a seller's catalog -- unlike Render's own disk,
// which is wiped on every deploy and can't be used for this. An in-memory
// cache (same cache-aside pattern as everywhere else in this file) avoids
// re-fetching from Redis on every single request.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024 }, // 1.5MB -- plenty for a product photo, small enough to keep Redis usage sane
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
const sellerPhotoCache = {};

app.get("/catalog-photo/:sellerId/:key", async (req, res) => {
  const { sellerId, key } = req.params;
  const cacheKey = `${sellerId}:${key}`;
  let entry = sellerPhotoCache[cacheKey];
  if (!entry) {
    try {
      const raw = await redisCommand(["GET", nsKey(sellerId, `catalog:photo:${key}`)]);
      if (!raw) return res.status(404).send("Not found");
      const parsed = JSON.parse(raw);
      entry = { mime: parsed.mime, buffer: Buffer.from(parsed.data, "base64") };
      sellerPhotoCache[cacheKey] = entry;
    } catch (err) {
      console.error("catalog-photo fetch failed:", err.message);
      return res.status(500).send("Failed to load photo");
    }
  }
  res.set("Content-Type", entry.mime || "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(entry.buffer);
});

// The links Amara actually sends for the original demo catalog. Same
// "DEFAULT_ = seed data for seller1 only" pattern as the other DEFAULT_*
// constants above -- a new seller's catalog never uses these.
const DEFAULT_PRODUCT_IMAGES = {
  tee: `${BASE_URL}/images/tee.png`,
  hoodie: `${BASE_URL}/images/hoodie.png`,
  jacket: `${BASE_URL}/images/jacket.png`,
  cap: `${BASE_URL}/images/cap.png`,
  joggers: `${BASE_URL}/images/joggers.png`,
};

// ---------- CATALOG PERSISTENCE (Redis-backed, editable from the dashboard) ----------
// Each seller's own PRODUCT_PRICES / PRODUCT_NAMES / PRODUCT_IMAGES (see
// sellerCatalogs / ensureCatalogEntry above) is the live, in-memory
// catalog everything else in this file reads from. These
// functions are what keep that in sync with Redis, so an owner's edits
// from the dashboard survive a restart or redeploy instead of quietly
// reverting to the demo data hardcoded above.
async function loadCatalogFromRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  try {
    const rawProducts = await redisCommand(["GET", nsKey(sellerId, "catalog:products")]);
    if (rawProducts) {
      const products = JSON.parse(rawProducts);
      // Replace the in-memory catalog wholesale with what's actually
      // stored, so a product removed on a previous edit doesn't come
      // back from stale in-memory defaults after a restart.
      for (const key of Object.keys(catalog.PRODUCT_PRICES)) delete catalog.PRODUCT_PRICES[key];
      for (const key of Object.keys(catalog.PRODUCT_NAMES)) delete catalog.PRODUCT_NAMES[key];
      for (const key of Object.keys(catalog.PRODUCT_IMAGES)) delete catalog.PRODUCT_IMAGES[key];
      for (const key of Object.keys(catalog.PRODUCT_DESCRIPTIONS)) delete catalog.PRODUCT_DESCRIPTIONS[key];
      for (const [key, p] of Object.entries(products)) {
        catalog.PRODUCT_PRICES[key] = p.price;
        catalog.PRODUCT_NAMES[key] = p.name;
        catalog.PRODUCT_IMAGES[key] = p.imageUrl || `${BASE_URL}/images/${key}.png`;
        catalog.PRODUCT_DESCRIPTIONS[key] = p.description || "";
      }
      console.log(`Catalog loaded from Redis for ${sellerId}: ${Object.keys(catalog.PRODUCT_PRICES).length} product(s).`);
    } else if (sellerId === SELLER1_ID) {
      // First run ever for the original shop: nothing saved yet, so seed
      // with the built-in demo catalog and persist it as the real
      // starting point from now on. A brand new seller who signs up
      // later does NOT hit this branch -- see below -- they start with a
      // genuinely empty catalog of their own, never this demo data.
      Object.assign(catalog.PRODUCT_PRICES, DEFAULT_PRODUCT_PRICES);
      Object.assign(catalog.PRODUCT_NAMES, DEFAULT_PRODUCT_NAMES);
      Object.assign(catalog.PRODUCT_IMAGES, DEFAULT_PRODUCT_IMAGES);
      await saveCatalogToRedis(sellerId);
      console.log("No catalog in Redis yet for seller1, saved the built-in demo catalog as the starting point.");
    }
    // else: a brand new seller with nothing saved yet just starts empty --
    // ensureCatalogEntry already gave them {}, nothing more to do here.

    const rawFees = await redisCommand(["GET", nsKey(sellerId, "catalog:delivery_fees")]);
    if (rawFees) {
      const fees = JSON.parse(rawFees);
      if (fees.states && typeof fees.states === "object") {
        // Current shape: per-state fees + an optional default fallback.
        for (const [slug, fee] of Object.entries(fees.states)) {
          if (VALID_STATE_SLUGS.has(slug) && typeof fee === "number") catalog.DELIVERY_STATES[slug] = fee;
        }
        catalog.DELIVERY_DEFAULT_FEE = typeof fees.defaultFee === "number" ? fees.defaultFee : null;
      } else if (typeof fees.lagos === "number") {
        // One-time migration from the old two-tier {lagos, outside} shape
        // (pre Nigeria-wide delivery). Preserves whatever the seller had
        // actually set, just reinterpreted as "Lagos" + a default fee for
        // everywhere else, then saved back in the new shape so this branch
        // only ever runs once per seller.
        catalog.DELIVERY_STATES.lagos = fees.lagos;
        catalog.DELIVERY_DEFAULT_FEE = typeof fees.outside === "number" ? fees.outside : null;
        await saveDeliveryFeesToRedis(sellerId);
      }
    } else if (sellerId === SELLER1_ID) {
      catalog.DELIVERY_STATES.lagos = DEFAULT_DELIVERY_FEES.lagos;
      catalog.DELIVERY_DEFAULT_FEE = DEFAULT_DELIVERY_FEES.outside;
      await saveDeliveryFeesToRedis(sellerId);
    }

    const rawBankDetails = await redisCommand(["GET", nsKey(sellerId, "shop:bank_details")]);
    if (rawBankDetails) {
      const bd = JSON.parse(rawBankDetails);
      if (bd.bankName) catalog.BANK_DETAILS.bankName = bd.bankName;
      if (bd.accountNumber) catalog.BANK_DETAILS.accountNumber = bd.accountNumber;
      if (bd.accountName) catalog.BANK_DETAILS.accountName = bd.accountName;
    } else if (sellerId === SELLER1_ID) {
      Object.assign(catalog.BANK_DETAILS, DEFAULT_BANK_DETAILS);
      await saveBankDetailsToRedis(sellerId);
    }

    const rawBankDetails2 = await redisCommand(["GET", nsKey(sellerId, "shop:bank_details_2")]);
    if (rawBankDetails2) {
      const bd2 = JSON.parse(rawBankDetails2);
      catalog.BANK_DETAILS_2.bankName = bd2.bankName || "";
      catalog.BANK_DETAILS_2.accountNumber = bd2.accountNumber || "";
      catalog.BANK_DETAILS_2.accountName = bd2.accountName || "";
    }
    // No seller1 default seeding here -- a second account only ever exists
    // once a seller explicitly adds one from the dashboard.

    // ---- Bookable-seller data. Empty/no-op for a goods seller (nothing
    // ever gets saved under these keys for one, so these all just stay []
    // / {} as initialized). ----
    const rawOfferings = await redisCommand(["GET", nsKey(sellerId, "catalog:offerings")]);
    if (rawOfferings) Object.assign(catalog.OFFERINGS, JSON.parse(rawOfferings));

    const rawAvailability = await redisCommand(["GET", nsKey(sellerId, "catalog:weekly_availability")]);
    if (rawAvailability) catalog.WEEKLY_AVAILABILITY = JSON.parse(rawAvailability);

    const rawBlockedDates = await redisCommand(["GET", nsKey(sellerId, "catalog:blocked_dates")]);
    if (rawBlockedDates) catalog.BLOCKED_DATES = JSON.parse(rawBlockedDates);

    const rawBookings = await redisCommand(["GET", nsKey(sellerId, "catalog:bookings")]);
    if (rawBookings) catalog.BOOKINGS = JSON.parse(rawBookings);
  } catch (err) {
    // If Redis is unreachable, keep running on whatever's already in
    // memory (the demo catalog for seller1, or empty for a new seller)
    // rather than crashing the whole server over this.
    console.error(`loadCatalogFromRedis failed for ${sellerId}, continuing on in-memory catalog:`, err.message);
  }
}

async function saveCatalogToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  const products = {};
  for (const key of Object.keys(catalog.PRODUCT_PRICES)) {
    const selfHostedUrl = `${BASE_URL}/images/${key}.png`;
    products[key] = {
      name: catalog.PRODUCT_NAMES[key],
      price: catalog.PRODUCT_PRICES[key],
      // Only persist an imageUrl when it's a real external photo the
      // owner supplied -- a self-hosted placeholder link is regenerated
      // from the key on every load, no need to store it explicitly.
      imageUrl: catalog.PRODUCT_IMAGES[key] && catalog.PRODUCT_IMAGES[key] !== selfHostedUrl ? catalog.PRODUCT_IMAGES[key] : undefined,
      description: catalog.PRODUCT_DESCRIPTIONS[key] || undefined,
    };
  }
  await redisCommand(["SET", nsKey(sellerId, "catalog:products"), JSON.stringify(products)]);
}

async function saveDeliveryFeesToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand([
    "SET",
    nsKey(sellerId, "catalog:delivery_fees"),
    JSON.stringify({ states: catalog.DELIVERY_STATES, defaultFee: catalog.DELIVERY_DEFAULT_FEE }),
  ]);
}

async function saveBankDetailsToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "shop:bank_details"), JSON.stringify(catalog.BANK_DETAILS)]);
}

async function saveBankDetails2ToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "shop:bank_details_2"), JSON.stringify(catalog.BANK_DETAILS_2)]);
}

// ---------- BOOKABLE SELLERS: PERSISTENCE ----------
async function saveOfferingsToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "catalog:offerings"), JSON.stringify(catalog.OFFERINGS)]);
}

async function saveWeeklyAvailabilityToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "catalog:weekly_availability"), JSON.stringify(catalog.WEEKLY_AVAILABILITY)]);
}

async function saveBlockedDatesToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "catalog:blocked_dates"), JSON.stringify(catalog.BLOCKED_DATES)]);
}

async function saveBookingsToRedis(sellerId) {
  const catalog = ensureCatalogEntry(sellerId);
  await redisCommand(["SET", nsKey(sellerId, "catalog:bookings"), JSON.stringify(catalog.BOOKINGS)]);
}

// ---------- BOOKABLE SELLERS: THE AVAILABILITY ENGINE ----------
// The bookable-seller equivalent of the PRODUCT_PRICES / DELIVERY_STATES
// hard backstop. The real open slots for a given offering on a given date
// are ALWAYS computed here, fresh, from the seller's actual weekly
// availability windows minus actual existing bookings and blocked dates --
// never trusted from anything the AI said or remembered earlier in the
// chat. Same "the prompt is a suggestion, the code is the guarantee"
// principle as prices and delivery, just applied to time, where a mistake
// (double-booking a real person's real slot) is if anything harder to
// undo gracefully than a wrong price.
//
// One shared calendar per seller (a single resource, e.g. one consultant),
// matching the Stage 2 plan: a booking for ANY offering blocks that time
// range for every OTHER offering too, since two different services can't
// both claim the same slice of the same person's day.

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// Returns the real open slots (array of "HH:MM" strings, in order) for one
// offering on one date ("YYYY-MM-DD") for a given seller. This is what
// Amara's [AVAILABILITY] tag reads from, and what [BOOK] re-checks against
// right before actually writing a booking.
function getAvailableSlots(seller, offeringKey, dateStr) {
  const catalog = seller.catalog;
  const offering = catalog.OFFERINGS[offeringKey];
  if (!offering || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return [];
  if (catalog.BLOCKED_DATES.includes(dateStr)) return [];

  // Parsed as a plain date-only value via Date.UTC, deliberately not
  // `new Date(dateStr)` (which some environments interpret with an
  // implicit local timezone) -- this file assumes a single timezone,
  // Africa/Lagos, throughout, so the day-of-week must never drift with
  // wherever the server process happens to be running.
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat

  const windowsForDay = catalog.WEEKLY_AVAILABILITY.filter((w) => w.day === dayOfWeek);
  if (windowsForDay.length === 0) return [];

  const duration = offering.durationMinutes;

  const occupiedRanges = catalog.BOOKINGS.filter((b) => b.date === dateStr && b.status !== "cancelled").map((b) => {
    const bookedOffering = catalog.OFFERINGS[b.offeringKey];
    const bookedDuration = bookedOffering ? bookedOffering.durationMinutes : duration;
    const start = timeToMinutes(b.time);
    return [start, start + bookedDuration];
  });
  const overlapsExisting = (start, end) => occupiedRanges.some(([os, oe]) => start < oe && end > os);

  const slots = [];
  for (const window of windowsForDay) {
    const start = timeToMinutes(window.startTime);
    const end = timeToMinutes(window.endTime);
    for (let t = start; t + duration <= end; t += duration) {
      if (!overlapsExisting(t, t + duration)) slots.push(minutesToTime(t));
    }
  }
  return slots;
}

// Creates a booking IF the slot is still genuinely open right now --
// re-checked here, not trusted from whatever was true a message or two
// ago. There's no `await` between this check and writing it into
// catalog.BOOKINGS below, so the check-and-write is atomic with respect
// to any other concurrent request on this same seller (Node never
// context-switches in the middle of synchronous code), closing the race
// where two customers could otherwise grab the same slot seconds apart.
// Persisting to Redis happens after, same "live change takes effect
// immediately, Redis is what makes it survive a restart" pattern as
// everywhere else.
async function createBookingIfAvailable(seller, offeringKey, dateStr, time, phone, reference) {
  const catalog = seller.catalog;
  const stillOpen = getAvailableSlots(seller, offeringKey, dateStr).includes(time);
  if (!stillOpen) return { ok: false };

  const booking = {
    id: crypto.randomBytes(6).toString("hex"),
    offeringKey,
    date: dateStr,
    time,
    phone,
    reference,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  catalog.BOOKINGS.push(booking);
  await saveBookingsToRedis(seller.sellerId);
  return { ok: true, booking };
}

// ---------- THE DEMO SHOP (later this comes from a real seller) ----------
// This used to be one static template literal with the catalog and
// delivery fees typed directly into the prompt text. Now that both are
// editable live from the dashboard's Catalog tab (see PRODUCT_PRICES,
// PRODUCT_NAMES, DELIVERY_STATES above), the prompt has to be rebuilt fresh
// from whatever the current catalog actually is every time Amara replies
// — otherwise an owner could correct a price on the dashboard and Amara
// would keep quoting the old one from a stale, baked-in copy. Everything
// else about the prompt is unchanged.
function buildShopProfile(seller) {
  // The one fork point in the whole prompt-building pipeline: a bookable
  // seller gets an entirely different prompt (offerings + availability
  // instead of a catalog + delivery), built by its own function below,
  // rather than threading businessType checks through this function line
  // by line. A goods seller (every seller that existed before this field
  // existed, including seller1) is completely unaffected -- this branch
  // is simply never taken for them.
  if (seller.businessType === "bookable") return buildBookableShopProfile(seller);
  return buildGoodsShopProfile(seller);
}

function buildGoodsShopProfile(seller) {
  const catalog = seller.catalog;
  // seller1 (the original, live shop) keeps this exact literal name, byte
  // for byte, so its prompt text -- and therefore Amara's behavior for the
  // real customers already talking to it -- doesn't shift at all just
  // because the engine underneath is now multi-tenant. Any other seller
  // gets Amara introduced as their own business instead, since she can't
  // be "KP Collections" for every shop on the platform.
  const shopName = seller.sellerId === SELLER1_ID ? "KP Collections" : (seller.businessName || "the shop");
  const catalogLines = Object.keys(catalog.PRODUCT_NAMES)
    .map((key, i) => {
      const line = `${i + 1}. ${catalog.PRODUCT_NAMES[key]} — N${catalog.PRODUCT_PRICES[key].toLocaleString()} (key: ${key})`;
      const description = catalog.PRODUCT_DESCRIPTIONS && catalog.PRODUCT_DESCRIPTIONS[key];
      // Seller-supplied details (material, sizes, colors, etc.) so Amara can
      // answer a customer's specific questions accurately instead of
      // guessing or making something up -- "the prompt is a suggestion,
      // the code is the guarantee" doesn't apply to product facts, so this
      // is the one place Amara's knowledge of a product is only ever as
      // good as what the seller actually typed in.
      return description ? `${line}\n   Details: ${description}` : line;
    })
    .join("\n");

  // Delivery fees, state by state. Only states the seller actually added
  // are listed by name; DELIVERY_DEFAULT_FEE (zone code "outside") is the
  // optional fallback price for any other Nigerian state -- if it isn't
  // set, Amara is told plainly not to invent a price for a state that
  // isn't listed.
  const stateFeeLines = Object.entries(catalog.DELIVERY_STATES)
    .map(([slug, fee]) => ({ slug, fee, name: NIGERIA_STATE_NAMES[slug] || slug }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `${s.name} (zone: ${s.slug}) — N${s.fee.toLocaleString()}`)
    .join(", ");
  const deliveryLine = typeof catalog.DELIVERY_DEFAULT_FEE === "number"
    ? `${stateFeeLines || "no state-specific prices set yet"}. Any other Nigerian state not listed above (zone: outside) — N${catalog.DELIVERY_DEFAULT_FEE.toLocaleString()}.`
    : `${stateFeeLines || "no delivery prices set yet"}. We do not currently deliver to any state not listed above -- if a customer is somewhere else, say delivery isn't available there yet and use [ESCALATE: ...] so the owner can decide.`;

  return `
You are "Amara", the sales assistant for ${shopName}, a small Nigerian
online store that sells on WhatsApp. You text like a real Nigerian shop
girl chatting with a customer, not like an assistant or a chatbot. Never
use em dashes.

THE CATALOG (the ONLY products that exist — never invent others):
${catalogLines}

SENDING PHOTOS:
- You can now send a product photo along with your text reply. To do
  this, add a tag at the very end of your message, on its own, in this
  exact format: [PHOTO: key] using the exact key shown next to the
  product in the catalog above. This tag is invisible to the customer,
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
- Delivery fees by state: ${deliveryLine} Ask which state the customer is
  in (not just "Lagos or outside Lagos") and match it to the right zone
  code above -- never guess or assume Lagos.
- Payment: the automatic payment link (see SENDING A PAYMENT LINK below)
  is the preferred way, use it once an order is confirmed. If a customer
  specifically asks to pay by direct bank transfer instead, that's fine
  too: bank transfer to ${catalog.BANK_DETAILS.accountName}, ${catalog.BANK_DETAILS.bankName} ${catalog.BANK_DETAILS.accountNumber}.${
    catalog.BANK_DETAILS_2 && catalog.BANK_DETAILS_2.bankName
      ? ` A second account also works if that's easier for them: ${catalog.BANK_DETAILS_2.accountName}, ${catalog.BANK_DETAILS_2.bankName} ${catalog.BANK_DETAILS_2.accountNumber}. Only mention this second option if they ask for an alternative account (e.g. their bank can't send to the first one) -- otherwise just offer the first.`
      : ""
  }
  Ask them to send a screenshot after transferring, and say the owner
  will confirm it shortly. Don't bring up bank transfer yourself
  unprompted, only offer it if the customer asks for it.
- If you are not sure about something (custom orders, complaints, refunds,
  anything outside the catalog), do NOT guess. Say the owner will reply
  shortly, and keep it warm.
- Never promise anything not listed here.

SENDING A PAYMENT LINK:
- Once a customer has clearly confirmed they want to buy a specific
  catalog item AND told you which Nigerian state they're in, add an
  invisible tag at the very end of your message, on its own, in this
  exact format: [PAY: key, zone] using the product key from the catalog
  above and zone as the exact zone code shown next to their state in the
  delivery fees list (e.g. "lagos", "ogun", "fct"). If their state isn't
  individually listed but a fallback price was given, use "outside" as
  the zone. If their state isn't listed AND no fallback price was given,
  do not send a payment link at all -- delivery isn't available there,
  say so and escalate instead.
  This tag is invisible to the customer, it
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
- If the customer hasn't told you their state yet, ask first instead of
  guessing or assuming Lagos. Never invent a zone.

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
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The bookable-seller prompt: offerings + real-time availability checks
// instead of a product catalog + delivery zones. Shares the same Amara
// voice and escalation behavior as the goods prompt, but the actual
// selling mechanics are different enough (time, not stock) that this is
// its own self-contained template rather than a patchwork of businessType
// checks inside buildGoodsShopProfile above. See the Stage 2 services
// architecture plan for the full reasoning.
function buildBookableShopProfile(seller) {
  const catalog = seller.catalog;
  const shopName = seller.businessName || "the business";

  const offeringLines = Object.keys(catalog.OFFERINGS)
    .map((key, i) => {
      const o = catalog.OFFERINGS[key];
      const line = `${i + 1}. ${o.name} — N${o.price.toLocaleString()}, ${o.durationMinutes} minutes (key: ${key})`;
      return o.description ? `${line}\n   Details: ${o.description}` : line;
    })
    .join("\n");

  // General weekly pattern, for Amara's own orientation only -- NEVER the
  // source of truth for whether a specific time is actually free. That
  // guarantee only ever comes from a real [AVAILABILITY] check, same
  // "prompt is a suggestion, code is the guarantee" principle as prices,
  // just applied to time.
  const availabilityLines = catalog.WEEKLY_AVAILABILITY.length > 0
    ? catalog.WEEKLY_AVAILABILITY
        .slice()
        .sort((a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime))
        .map((w) => `${DAY_NAMES[w.day]}: ${w.startTime}-${w.endTime}`)
        .join(", ")
    : "no weekly availability set yet";

  const todayStr = new Date().toISOString().slice(0, 10); // Africa/Lagos-assumed, YYYY-MM-DD

  return `
You are "Amara", the booking assistant for ${shopName}, a Nigerian service
business that takes appointments on WhatsApp. You text like a real person
helping someone book a slot, not like an assistant or a chatbot. Never use
em dashes.

Today's date is ${todayStr}. When a customer says a day in words ("tomorrow",
"next Tuesday", "this Friday"), work out the actual YYYY-MM-DD yourself
from today's date before using it in any tag below.

THE SERVICES (the ONLY services that exist — never invent others):
${offeringLines || "no services set up yet"}

GENERAL WEEKLY AVAILABILITY (for your own orientation ONLY — never promise
or rule out a specific time from this alone, always run a real
[AVAILABILITY] check first, exact openings can differ from this general
pattern because of existing bookings):
${availabilityLines}

CHECKING AVAILABILITY:
- When a customer asks about booking a service, or asks what's free on a
  given day, add an invisible tag at the very end of your message, on its
  own, in this exact format: [AVAILABILITY: key, date] using the service
  key from the list above and date as an exact YYYY-MM-DD. This tag is
  invisible to the customer, it triggers a real check of what's actually
  still open right now, and the real open times are handed back to you as
  a system note right after, for you to relay in your NEXT reply.
- Never state a specific available time to a customer without having
  actually run this check first in this conversation. You have no way of
  knowing what's really free otherwise, don't guess or estimate from the
  general weekly pattern above.
- If nothing comes back free for a date the customer asked about, say so
  plainly and offer to check a different day, don't invent a time anyway.
- Only one [AVAILABILITY: key, date] tag per message.

CONFIRMING A BOOKING:
- Once a customer has picked one of the times you actually offered them
  moments ago (from a real availability check, never a guess or something
  from earlier in memory), add an invisible tag at the very end of your
  message, on its own, in this exact format: [BOOK: key, date, time]
  using the service key, the date (YYYY-MM-DD), and the time (HH:MM,
  24-hour) exactly as it was offered. This tag is invisible to the
  customer, it triggers one final real check and actually writes the
  booking, so never mention the tag itself.
- Do not declare the booking done in your own words before this tag has a
  chance to fire ("let me lock that in for you" is safe, "you're all
  booked" is not) -- the system's own confirmation message right after
  yours is what actually means it's booked. On the rare chance someone
  else took that exact slot a moment earlier, you'll be told so right
  after and should apologize and offer to check fresh availability, not
  pretend it went through.
- Only one [BOOK: key, date, time] tag per message, and only for a
  key/date/time combination that was genuinely offered from a real
  [AVAILABILITY] check earlier in this same conversation.

RULES:
- Quote prices EXACTLY as listed (never change or guess a price), even
  when writing them the casual "15k" way.
- Prices are fixed, same as any firm quote -- if a customer pushes for a
  discount, stay warm but don't cave or use agreement-shaped language
  ("okay okay", "no wahala") in response to a price push, even jokingly.
- Payment happens directly at the time of the appointment, not through
  this chat -- there is no payment link to send for a booking. Once a
  booking is confirmed, simply let the customer know payment is handled
  at the session itself.
- If you are not sure about something (a custom request, rescheduling
  something already booked, a complaint, anything outside the services
  listed), do NOT guess. Say the owner will reply shortly, and keep it
  warm.
- Never promise anything not listed here.

SPLITTING INTO SEPARATE MESSAGES:
- Real people on WhatsApp rarely send one long message with everything in
  it, they send a few short separate bubbles, one thought at a time. You
  can do this too. When a reply naturally has two or three distinct
  beats, mark the break with |||  on its own with a space on each side,
  between the two parts. This is invisible to the customer, it gets
  turned into separate message bubbles sent one after another.
- Use this sparingly, only when it feels like how a real person would
  naturally pause between thoughts. Never use more than one ||| per
  reply, and never split a single sentence in half.

HOW YOU TEXT (this matters as much as what you say):
- Short bursts. Most replies are 1-2 sentences. Rarely go past 3.
- Emojis are rare, not a habit. Aim for most messages to have no emoji at
  all. Never stack more than one emoji in a single message.
- Do not end every message with a question. A real person often just
  answers and lets the other person decide what to say next.
- Mirror the customer's energy and register, but let it build over the
  conversation rather than assuming it from message one.
- You are allowed to just be a normal person in the chat. If a customer
  greets you, jokes with you, or goes off-topic, respond briefly and
  naturally, the way someone coordinating a real booking would. You do
  not have to steer every message back to booking.

ALERTING THE OWNER:
- Whenever you tell a customer the owner will reply shortly, also alert
  the owner for real. Add an invisible tag at the very end of your
  message, on its own, in this exact format: [ESCALATE: short reason]
  using a few plain words for the reason. This tag is invisible to the
  customer, it triggers a real WhatsApp alert to the owner, so never
  mention the tag itself.
- Also use this tag if a customer seems genuinely upset or frustrated,
  not just confused, even if you're still able to answer their question.
- Do not use this for routine back-and-forth, that's expected and you
  handle it fine on your own. This is for genuine "a human needs to step
  in" moments only, and never twice in a row for a bare greeting.
- Only ever one [ESCALATE: reason] tag per message.
`;
}

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

async function getConversation(sellerId, from) {
  // Try twice before giving up. A single transient network hiccup (most
  // likely right as the free server wakes from a nap) shouldn't make a
  // real returning customer look like a stranger. If both attempts fail,
  // we still fall back safely to an empty history rather than crashing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await redisCommand(["GET", nsKey(sellerId, `conv:${from}`)]);
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

async function saveConversation(sellerId, from, history) {
  try {
    // EX 2592000 = expire after 30 days of no new messages
    await redisCommand(["SET", nsKey(sellerId, `conv:${from}`), JSON.stringify(history), "EX", "2592000"]);
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

async function pauseCustomer(sellerId, phone) {
  try {
    await redisCommand(["SET", nsKey(sellerId, `paused:${phone}`), "1", "EX", String(PAUSE_DURATION_SECONDS)]);
    // Reset the "already told them someone's coming" flag so the one-time
    // holding note fires fresh for this new pause, not skipped from last time.
    await redisCommand(["DEL", nsKey(sellerId, `paused_notified:${phone}`)]);
    await upsertCustomer(sellerId, phone, { paused: "yes" });
  } catch (err) {
    console.error("pauseCustomer failed:", err.message);
  }
}

async function resumeCustomer(sellerId, phone) {
  try {
    await redisCommand(["DEL", nsKey(sellerId, `paused:${phone}`)]);
    await redisCommand(["DEL", nsKey(sellerId, `paused_notified:${phone}`)]);
    await upsertCustomer(sellerId, phone, { paused: "no" });
  } catch (err) {
    console.error("resumeCustomer failed:", err.message);
  }
}

async function isCustomerPaused(sellerId, phone) {
  try {
    const result = await redisCommand(["GET", nsKey(sellerId, `paused:${phone}`)]);
    return !!result;
  } catch (err) {
    // Fail OPEN: if Redis hiccups, Amara should keep helping the customer,
    // not go silent. Going quiet by accident is worse than one missed pause.
    console.error("isCustomerPaused check failed, defaulting to NOT paused:", err.message);
    return false;
  }
}

async function hasNotifiedPaused(sellerId, phone) {
  try {
    const result = await redisCommand(["GET", nsKey(sellerId, `paused_notified:${phone}`)]);
    return !!result;
  } catch (err) {
    return true; // fail toward NOT repeating the note, safer than spamming
  }
}

async function markNotifiedPaused(sellerId, phone) {
  try {
    await redisCommand(["SET", nsKey(sellerId, `paused_notified:${phone}`), "1", "EX", String(PAUSE_DURATION_SECONDS)]);
  } catch (err) {
    console.error("markNotifiedPaused failed:", err.message);
  }
}

async function setLastEscalatedCustomer(sellerId, phone) {
  try {
    await redisCommand(["SET", nsKey(sellerId, "last_escalated_customer"), phone, "EX", "86400"]); // 24h
  } catch (err) {
    console.error("setLastEscalatedCustomer failed:", err.message);
  }
}

async function getLastEscalatedCustomer(sellerId) {
  try {
    return await redisCommand(["GET", nsKey(sellerId, "last_escalated_customer")]);
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

async function upsertCustomer(sellerId, phone, fields) {
  try {
    const flatFields = [];
    for (const [key, value] of Object.entries(fields)) {
      flatFields.push(key, String(value));
    }
    await redisCommand(["HSET", nsKey(sellerId, `customer:${phone}`), ...flatFields]);
    await redisCommand(["SADD", nsKey(sellerId, "all_customers"), phone]);
  } catch (err) {
    console.error(`upsertCustomer failed for ${phone}:`, err.message);
  }
}

async function getCustomer(sellerId, phone) {
  try {
    const raw = await redisCommand(["HGETALL", nsKey(sellerId, `customer:${phone}`)]);
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

async function listAllCustomers(sellerId) {
  try {
    const phones = await redisCommand(["SMEMBERS", nsKey(sellerId, "all_customers")]);
    if (!phones || phones.length === 0) return [];
    const records = await Promise.all(phones.map((phone) => getCustomer(sellerId, phone)));
    return records.filter(Boolean);
  } catch (err) {
    console.error("listAllCustomers failed:", err.message);
    return [];
  }
}

// Called on every incoming customer message: keeps first/last contact
// time and message count up to date without needing any separate step.
async function recordCustomerContact(sellerId, phone) {
  const existing = await getCustomer(sellerId, phone);
  const now = new Date().toISOString();
  await upsertCustomer(sellerId, phone, {
    phone,
    first_contact: existing?.first_contact || now,
    last_contact: now,
    message_count: existing?.message_count ? Number(existing.message_count) + 1 : 1,
  });
}

// ---------- SELLER ACCOUNTS (multi-tenant foundation) ----------
// Phase A of the self-serve onboarding plan: a real account + login layer,
// so sellers register themselves instead of being added by hand.
//
// Phase C (below, see PER-SELLER STATE near the top of this file, and the
// message-handling engine further down) is what actually wires incoming
// WhatsApp traffic to route per-seller instead of serving one shop. See
// the build log for the full phased plan.

// Server-side HTML escaping for the signup/login/seller pages below —
// distinct from the client-side escapeHtml() inside dashboardHtml()'s
// <script>, which only runs in the browser. Needed here because business
// name and email are arbitrary text a seller typed in, then echoed back
// into a real HTML response (e.g. a failed-login page).
function escapeHtmlServer(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function makeSellerId() {
  return crypto.randomBytes(12).toString("hex");
}

async function createSeller({ businessName, email, passwordHash, businessType }) {
  const sellerId = makeSellerId();
  await redisCommand([
    "HSET",
    `seller:${sellerId}`,
    "sellerId", sellerId,
    "businessName", businessName,
    "email", email.toLowerCase(),
    "passwordHash", passwordHash,
    "status", "pending_whatsapp_connection",
    "businessType", businessType === "bookable" ? "bookable" : "goods",
    "createdAt", new Date().toISOString(),
  ]);
  await redisCommand(["SADD", "all_sellers", sellerId]);
  await redisCommand(["SET", `seller_by_email:${email.toLowerCase()}`, sellerId]);
  return sellerId;
}

async function getSellerById(sellerId) {
  try {
    const raw = await redisCommand(["HGETALL", `seller:${sellerId}`]);
    if (!raw || raw.length === 0) return null;
    const record = {};
    for (let i = 0; i < raw.length; i += 2) record[raw[i]] = raw[i + 1];
    return record;
  } catch (err) {
    console.error(`getSellerById failed for ${sellerId}:`, err.message);
    return null;
  }
}

async function getSellerByEmail(email) {
  try {
    const sellerId = await redisCommand(["GET", `seller_by_email:${email.toLowerCase()}`]);
    if (!sellerId) return null;
    return await getSellerById(sellerId);
  } catch (err) {
    console.error(`getSellerByEmail failed for ${email}:`, err.message);
    return null;
  }
}

// Signed, stateless session token (sellerId + expiry + HMAC signature) in
// an httpOnly cookie — no session store needed, consistent with keeping
// this a single self-contained file. A constant-time comparison on the
// signature avoids a timing side-channel.
function signSession(sellerId) {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const payload = `${sellerId}.${expires}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sellerId, expires, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(`${sellerId}.${expires}`).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  if (Date.now() > Number(expires)) return null;
  return sellerId;
}

async function requireSellerAuth(req, res, next) {
  const sellerId = verifySession(req.cookies?.session);
  if (!sellerId) return res.redirect("/login");
  const seller = await getSellerById(sellerId);
  if (!seller) return res.redirect("/login");
  req.seller = seller;
  next();
}

// ---------- Bootstrapping seller1 (the original shop) as a real seller ----------
// Runs once at startup. Creates seller1's own `seller:seller1` Redis record
// if it doesn't already exist (so it shows up in admin tooling like every
// other seller), and registers its real phone_number_id (from the
// PHONE_NUMBER_ID env var) in the routing index right away, so the very
// first webhook call after a restart routes correctly without waiting on
// a lazy load. Deliberately does NOT write phoneNumberId/whatsappToken/
// ownerPhoneNumber into Redis for seller1 -- those stay absent so
// loadSellerCreds() keeps falling back to the env vars, exactly as today,
// unless an admin explicitly reconnects seller1 via the same manual
// WhatsApp-connect route every other seller uses.
async function ensureSeller1() {
  try {
    const existing = await getSellerById(SELLER1_ID);
    if (!existing) {
      await redisCommand([
        "HSET", `seller:${SELLER1_ID}`,
        "sellerId", SELLER1_ID,
        "businessName", "KP Collections",
        "status", "active",
        "createdAt", new Date().toISOString(),
      ]);
      await redisCommand(["SADD", "all_sellers", SELLER1_ID]);
      console.log("Bootstrapped seller1 (the original shop) as a real seller record.");
    }
  } catch (err) {
    console.error("ensureSeller1 failed (non-fatal, seller1 still works via env vars as fallback):", err.message);
  }
  if (PHONE_NUMBER_ID) registerSellerPhoneNumberId(SELLER1_ID, PHONE_NUMBER_ID);
}

// Warms the phone_number_id -> sellerId routing index for every seller
// who already has a connected number, so a restart never causes a brief
// window of misrouted webhook traffic while it lazy-loads.
async function warmPhoneNumberIdIndex() {
  try {
    const ids = (await redisCommand(["SMEMBERS", "all_sellers"])) || [];
    const sellers = await Promise.all(ids.map((id) => getSellerById(id)));
    for (const s of sellers) {
      if (s?.phoneNumberId) registerSellerPhoneNumberId(s.sellerId, s.phoneNumberId);
    }
  } catch (err) {
    console.error("warmPhoneNumberIdIndex failed (non-fatal):", err.message);
  }
}

// ---------- Durable "photo already sent" tracking ----------
// This used to live only as a note buried in the last-10-message chat
// history, which meant a busy conversation (escalations, pauses, small
// talk) could push it out and cause an accidental resend. Tracking it
// here instead, permanently, per customer, means it can never be
// forgotten no matter how long or chaotic the conversation gets.
async function markPhotoSent(sellerId, phone, photoKey) {
  try {
    await redisCommand(["SADD", nsKey(sellerId, `photos_sent:${phone}`), photoKey]);
    await redisCommand(["EXPIRE", nsKey(sellerId, `photos_sent:${phone}`), "2592000"]); // 30 days
  } catch (err) {
    console.error(`markPhotoSent failed for ${phone}:`, err.message);
  }
}

async function getPhotosSent(sellerId, phone) {
  try {
    return await redisCommand(["SMEMBERS", nsKey(sellerId, `photos_sent:${phone}`)]);
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
async function unmarkPhotoSent(sellerId, phone, photoKey) {
  try {
    await redisCommand(["SREM", nsKey(sellerId, `photos_sent:${phone}`), photoKey]);
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
async function trackPendingPhotoSend(sellerId, messageId, phone, photoKey) {
  try {
    await redisCommand([
      "SET",
      nsKey(sellerId, `pending_photo:${messageId}`),
      JSON.stringify({ phone, photoKey }),
      "EX",
      "86400",
    ]);
  } catch (err) {
    console.error(`trackPendingPhotoSend failed for ${messageId}:`, err.message);
  }
}

async function getPendingPhotoSend(sellerId, messageId) {
  try {
    const raw = await redisCommand(["GET", nsKey(sellerId, `pending_photo:${messageId}`)]);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`getPendingPhotoSend failed for ${messageId}:`, err.message);
    return null;
  }
}

async function clearPendingPhotoSend(sellerId, messageId) {
  try {
    await redisCommand(["DEL", nsKey(sellerId, `pending_photo:${messageId}`)]);
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

// NOTE (Phase C): order:<reference> stays a GLOBAL, unprefixed key
// deliberately, unlike everything else in this file. Paystack's webhook
// hands back only a bare reference string with no way to know which
// seller it belongs to -- so instead of trying to namespace this key by
// seller (impossible before we've even looked it up), the seller is
// stored INSIDE the order record itself (see processBufferedTurn, which
// sets order.sellerId when creating it), and the paystack-webhook handler
// reads it back out of there to resolve the right seller context.
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

// ---------- ANALYTICS ----------
// Durable, aggregate counters recorded at the moment of each confirmed
// payment. Deliberately NOT reconstructed later from customer records or
// individual order keys — a customer's record only keeps their LATEST
// payment (a repeat buyer would silently erase their earlier one from any
// derived view), and paid orders themselves expire after 30 days. These
// counters are separate, dedicated, and never expire, so trends and
// best-sellers stay correct regardless of either of those.
async function recordOrderAnalytics(sellerId, order) {
  try {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await redisCommand(["INCRBYFLOAT", nsKey(sellerId, `analytics:day:${dateStr}:revenue`), String(order.totalNaira)]);
    await redisCommand(["INCR", nsKey(sellerId, `analytics:day:${dateStr}:orders`)]);
    await redisCommand(["INCR", nsKey(sellerId, `analytics:product:${order.productKey}:sold`)]);
    await redisCommand(["INCRBYFLOAT", nsKey(sellerId, `analytics:product:${order.productKey}:revenue`), String(order.totalNaira)]);
    // Tracked in its own set (same pattern as all_customers) so a product
    // removed from the catalog later doesn't lose its sales history from
    // the best-sellers list, and so we never need a slow Redis KEYS scan
    // to find out which products have ever sold anything.
    await redisCommand(["SADD", nsKey(sellerId, "analytics:products_sold"), order.productKey]);
    // Unique paying customers, for the chat-to-order conversion stat.
    await redisCommand(["SADD", nsKey(sellerId, "analytics:paid_customers"), order.phone]);
  } catch (err) {
    console.error("recordOrderAnalytics failed:", err.message);
  }
}

async function getAnalyticsSummary(sellerId, customers, catalog) {
  // Last 14 days of revenue + order count, oldest to newest. Always
  // generates the full 14-day range and lets a missing key read as 0,
  // rather than needing a separate index of "which days have data" —
  // one GET per day per metric, cheap at this scale.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const trend = [];
  for (const dateStr of days) {
    let revenue = 0;
    let orders = 0;
    try {
      const [revenueRaw, ordersRaw] = await Promise.all([
        redisCommand(["GET", nsKey(sellerId, `analytics:day:${dateStr}:revenue`)]),
        redisCommand(["GET", nsKey(sellerId, `analytics:day:${dateStr}:orders`)]),
      ]);
      revenue = Number(revenueRaw) || 0;
      orders = Number(ordersRaw) || 0;
    } catch (err) {
      console.error(`getAnalyticsSummary: trend lookup failed for ${dateStr}:`, err.message);
    }
    trend.push({ date: dateStr, revenue, orders });
  }

  // Best sellers, sorted by units sold.
  let bestSellers = [];
  try {
    const soldKeys = (await redisCommand(["SMEMBERS", nsKey(sellerId, "analytics:products_sold")])) || [];
    const rows = await Promise.all(
      soldKeys.map(async (key) => {
        const [soldRaw, revenueRaw] = await Promise.all([
          redisCommand(["GET", nsKey(sellerId, `analytics:product:${key}:sold`)]),
          redisCommand(["GET", nsKey(sellerId, `analytics:product:${key}:revenue`)]),
        ]);
        return {
          key,
          name: (catalog && catalog.PRODUCT_NAMES[key]) || key, // falls back to the raw key if the product was since removed from the catalog
          sold: Number(soldRaw) || 0,
          revenue: Number(revenueRaw) || 0,
        };
      })
    );
    bestSellers = rows.sort((a, b) => b.sold - a.sold);
  } catch (err) {
    console.error("getAnalyticsSummary: best-sellers lookup failed:", err.message);
  }

  // Chat-to-order conversion: unique paying customers vs everyone who's
  // ever messaged. Whole-history, not date-limited — with volumes this
  // low a daily conversion rate would be too noisy to mean anything yet.
  let paidCustomerCount = 0;
  try {
    const paidPhones = (await redisCommand(["SMEMBERS", nsKey(sellerId, "analytics:paid_customers")])) || [];
    paidCustomerCount = paidPhones.length;
  } catch (err) {
    console.error("getAnalyticsSummary: paid-customers lookup failed:", err.message);
  }
  const totalCustomers = customers.length;
  const conversionPct = totalCustomers > 0 ? Math.round((paidCustomerCount / totalCustomers) * 1000) / 10 : 0;

  return {
    trend,
    bestSellers,
    conversion: { totalCustomers, paidCustomers: paidCustomerCount, conversionPct },
  };
}

// ---------- MESSAGE BUFFERING ----------
// Real WhatsApp users often fire off several quick messages in a row
// ("Hi", "I want the hoodie", "can I get discount") instead of one full
// thought. Replying to the first one immediately means Amara jumps in
// before the customer has finished. Instead, we wait a short window to
// see if more messages are coming, then combine them into one turn.
const BUFFER_WAIT_MS = 4000; // 4 seconds of quiet before we reply
const pendingBuffers = new Map(); // "<sellerId>:<from>" -> { texts: [], lastMessageId, timer }
// Same real customer phone number could, in principle, be messaging two
// different sellers' shops -- keying by sellerId+phone (not just phone)
// keeps their buffers, and everything downstream, fully separate.
function bufferKey(sellerId, from) {
  return `${sellerId}:${from}`;
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

    // ---------- Route this call to the right seller ----------
    // Meta's own phone_number_id tells us which seller's WhatsApp number
    // this call is actually about -- the only thing that does, since every
    // seller's number calls this exact same shared URL. Falls back to
    // seller1 if it's missing or unrecognized (shouldn't happen with real
    // Meta traffic, but seller1 is the one existing, working shop, so
    // that's the safe default rather than silently dropping a message).
    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    let sellerId = incomingPhoneNumberId ? phoneNumberIdToSellerId[incomingPhoneNumberId] : null;
    if (!sellerId) {
      if (incomingPhoneNumberId) {
        console.error(`Webhook: unrecognized phone_number_id "${incomingPhoneNumberId}", falling back to seller1.`);
      }
      sellerId = SELLER1_ID;
    }
    const seller = await getSellerContext(sellerId);
    if (!seller) {
      console.error(`Webhook: resolved sellerId "${sellerId}" has no context, dropping this call.`);
      return;
    }
    if (seller.suspended) {
      console.log(`Webhook: seller ${sellerId} is suspended by admin, dropping this call.`);
      return;
    }

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
          const pending = await getPendingPhotoSend(seller.sellerId, status.id);
          if (pending) {
            await clearPendingPhotoSend(seller.sellerId, status.id);
            await unmarkPhotoSent(seller.sellerId, pending.phone, pending.photoKey);

            await sendWhatsApp(
              seller,
              pending.phone,
              "Ah, that photo didn't actually go through on my end, sending it again now, one sec."
            );
            const retry = await sendWhatsAppImage(
              seller,
              pending.phone,
              seller.catalog.PRODUCT_IMAGES[pending.photoKey]
            );
            if (retry.success) {
              await markPhotoSent(seller.sellerId, pending.phone, pending.photoKey);
              if (retry.messageId) {
                await trackPendingPhotoSend(seller.sellerId, retry.messageId, pending.phone, pending.photoKey);
              }
            }

            // Owner gets told either way. A photo that silently failed to
            // deliver once is worth knowing about even if the retry just
            // fixed it, and this alert fires from code, not from the AI
            // choosing to mention it, so it can't get missed again.
            await sendOwnerAlert(
              seller,
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

    // If this message is from THIS SELLER's own owner number, treat it as
    // a control command (pause/resume), not a customer conversation.
    // Handled immediately, no buffering delay, since the owner wants an
    // instant confirmation, especially in an urgent moment.
    if (seller.ownerPhoneNumber && from === seller.ownerPhoneNumber) {
      console.log(`Owner (${seller.sellerId}) ${from}: ${text}`);
      await handleOwnerCommand(seller, text);
      return;
    }

    console.log(`Customer (${seller.sellerId}) ${from}: ${text}`);

    // Keep the customer database up to date: when we first heard from
    // them, when we last did, and how many messages total.
    await recordCustomerContact(seller.sellerId, from);

    // If the owner has paused this customer, handle it separately and
    // stop here. This must happen BEFORE we show any typing indicator,
    // otherwise the customer sees "typing..." for a reply that may
    // never come, which is misleading.
    const paused = await isCustomerPaused(seller.sellerId, from);
    if (paused) {
      await handlePausedCustomerMessage(seller, from, text, message.id);
      return;
    }

    // Mark the message as read and show the "typing..." bubble right away,
    // so the customer sees a response is coming even while we wait to see
    // if more messages are on the way.
    await markReadAndShowTyping(seller, message.id);

    // Add this message to the customer's pending buffer. If they send
    // another message within the wait window, we cancel the old timer and
    // start a fresh one, so we only reply once they've paused.
    const key = bufferKey(seller.sellerId, from);
    let buffer = pendingBuffers.get(key);
    if (!buffer) {
      buffer = { texts: [], lastMessageId: null };
      pendingBuffers.set(key, buffer);
    }
    buffer.texts.push(text);
    buffer.lastMessageId = message.id;

    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      processBufferedTurn(seller, from).catch((err) =>
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
async function handlePausedCustomerMessage(seller, from, text, messageId) {
  const alreadyNotified = await hasNotifiedPaused(seller.sellerId, from);

  if (!alreadyNotified) {
    // First message since the pause started: this is a real conversation
    // turn, save it along with the holding note, same as any normal reply.
    let history = await getConversation(seller.sellerId, from);
    history.push({ role: "user", content: text });

    await markReadAndShowTyping(seller, messageId);
    const holdingNote = "Just a moment, the owner's handling this personally right now.";
    await humanPause(holdingNote);
    await sendWhatsApp(seller, from, holdingNote);
    await markNotifiedPaused(seller.sellerId, from);
    history.push({ role: "assistant", content: holdingNote });
    history = history.slice(-10);
    await saveConversation(seller.sellerId, from, history);
    console.log(`Amara -> ${from}: [paused, sent one-time holding note]`);
  } else {
    // Already told them once, staying quiet. Deliberately NOT saved to
    // conversation history: a customer waiting on a pause often sends
    // several "hello? you there?" style check-ins, and letting each one
    // consume a slot in the last-10-message window pushes the real,
    // meaningful conversation out before the owner even resumes. Just
    // mark it read and keep count in the customer database instead.
    await markReadOnly(seller, messageId);
    console.log(`Customer ${from} is paused, staying quiet (already notified): "${text}"`);
  }
}


async function processBufferedTurn(seller, from) {
  const key = bufferKey(seller.sellerId, from);
  const buffer = pendingBuffers.get(key);
  if (!buffer) return; // safety, shouldn't happen
  pendingBuffers.delete(key);

  // Combine everything they sent in this burst into one turn, so Amara
  // replies to the whole thought instead of just the first fragment.
  const combinedText = buffer.texts.join("\n");
  const messageId = buffer.lastMessageId;

  try {
    // Load this customer's history from persistent memory
    let history = await getConversation(seller.sellerId, from);
    history.push({ role: "user", content: combinedText });
    // keep only last 10 turns to stay light
    history = history.slice(-10);

    // If the owner has taken over this specific customer, Amara stays
    // quiet rather than replying on top of whatever the owner is doing.
    // Still save the customer's message to history for continuity, and
    // send one quiet note the first time this happens per pause, not
    // on every message, so it doesn't feel repetitive or robotic.
    const paused = await isCustomerPaused(seller.sellerId, from);
    if (paused) {
      let holdingNote = null;
      const alreadyNotified = await hasNotifiedPaused(seller.sellerId, from);
      if (!alreadyNotified) {
        holdingNote = "Just a moment, the owner's handling this personally right now.";
        await humanPause(holdingNote);
        await sendWhatsApp(seller, from, holdingNote);
        await markNotifiedPaused(seller.sellerId, from);
        console.log(`Amara -> ${from}: [paused, sent one-time holding note]`);
      } else {
        console.log(`Customer ${from} is paused, staying quiet (already notified).`);
      }
      history.push({ role: "assistant", content: holdingNote || "[paused: owner is handling this personally]" });
      await saveConversation(seller.sellerId, from, history);
      return;
    }

    // ---------- 3) THINK (ask the AI brain) ----------
    // Look up which photos have already gone out to this customer from
    // durable storage (not chat history, which can get pushed out by a
    // busy conversation), and remind her fresh every single call so this
    // can never be forgotten no matter how the conversation has gone.
    const photosAlreadySent = await getPhotosSent(seller.sellerId, from);
    const photoReminder =
      photosAlreadySent.length > 0
        ? `You have ALREADY sent these product photos to this customer in this chat: ${photosAlreadySent.join(", ")}. Do not resend any of these unless the customer explicitly asks to see it again.`
        : "";
    let rawReply = await askAI(seller, history, photoReminder);

    // Bookable sellers only: if she asked for a real availability check,
    // resolve it right now, before anything gets sent to the customer,
    // and let her write her ACTUAL reply from the real numbers -- same
    // "the prompt is a suggestion, the code is the guarantee" discipline
    // as prices, just applied to time. Whatever text came with the first
    // pass (e.g. "let me check for you") is kept and sent as its own
    // bubble, the follow-up reply arrives right after as a second one,
    // the same natural two-part texting rhythm the ||| splitter already
    // supports. Only resolved once per incoming customer message -- her
    // follow-up reply is explicitly told not to use the tag again, and if
    // it somehow does anyway, that second tag is just stripped as clutter
    // further down rather than looping.
    if (seller.businessType === "bookable") {
      const { cleanText: availStripped, availabilityKey, availabilityDate } = extractAvailabilityTag(rawReply);
      if (availabilityKey && availabilityDate) {
        const offering = seller.catalog.OFFERINGS[availabilityKey];
        const slots = offering ? getAvailableSlots(seller, availabilityKey, availabilityDate) : [];
        // Every branch ends with the same hard instruction: this reply is
        // plain text only, never another [AVAILABILITY: ...] tag. Without
        // this, a confused model (especially in the unrecognized-key case)
        // can try to "check again" by emitting a second tag here -- and
        // since this second pass is never re-run through the extraction
        // step below, that raw tag would otherwise leak straight to the
        // customer as literal visible text instead of being resolved.
        const NO_SECOND_TAG =
          "This reply must be plain text only, meant to be read directly by the customer -- do NOT include an [AVAILABILITY: ...] tag or any other bracketed tag in it, under any circumstance.";
        const slotsNote = !offering
          ? `The [AVAILABILITY] tag referenced a service key ("${availabilityKey}") that isn't in the services list above. Don't try the tag again. Just ask the customer in plain language which service they'd like (naming the real options from the list), so you can look it up correctly once you know. ${NO_SECOND_TAG}`
          : slots.length > 0
            ? `Real availability check for "${offering.name}" on ${availabilityDate}: ${slots.join(", ")}. Whatever you said right before the [AVAILABILITY] tag (e.g. "let me check") has ALREADY been sent to the customer as its own message -- do not repeat that or any similar "checking now" phrase here, go straight into telling them the real times, using ONLY these real times if you mention any specific time. ${NO_SECOND_TAG}`
            : `Real availability check for "${offering.name}" on ${availabilityDate}: nothing is open that day. Whatever you said right before the [AVAILABILITY] tag (e.g. "let me check") has ALREADY been sent to the customer as its own message -- do not repeat that or any similar "checking now" phrase here, tell them plainly that nothing's open that day and offer to check a different day. ${NO_SECOND_TAG}`;
        let followUpReply = await askAI(seller, history, slotsNote);

        // Belt and suspenders: if the model ignored the instruction above
        // and emitted another raw [AVAILABILITY: ...] tag anyway, strip it
        // out here rather than letting it leak to the customer. This is
        // deliberately NOT resolved into a second real check (that could
        // loop) -- it's just cut out as clutter, same as the comment
        // above this block always intended but never actually did.
        const secondPass = extractAvailabilityTag(followUpReply);
        if (secondPass.availabilityKey) {
          console.log(
            `Bookable: follow-up reply for ${seller.sellerId} tried to emit a second [AVAILABILITY] tag (${secondPass.availabilityKey}, ${secondPass.availabilityDate}) -- stripped, not resolved.`
          );
          followUpReply = secondPass.cleanText;
        }

        // Dead-end guard: if the model's ENTIRE follow-up reply was just
        // the stripped tag above (or came back blank for any other
        // reason), followUpReply is now an empty string. Without this,
        // the customer's "checking" message was already sent, but nothing
        // ever follows it -- a silent dead end, worse than the leaked tag
        // this whole block exists to prevent, because it looks like Amara
        // simply stopped responding. Build the real answer directly from
        // the computed data instead of leaving this to the model at all.
        if (!followUpReply.trim()) {
          console.log(
            `Bookable: follow-up reply for ${seller.sellerId} came back empty after cleanup -- using a hard-coded fallback so the customer isn't left hanging.`
          );
          followUpReply = !offering
            ? `Sorry, could you tell me exactly which service you'd like? Just want to make sure I check the right one for you.`
            : slots.length > 0
              ? `For ${offering.name} on ${availabilityDate}, these times are open: ${slots.join(", ")}. Which works for you?`
              : `Nothing's open for ${offering.name} on ${availabilityDate}, sorry! Want me to check a different day?`;
        }

        rawReply = availStripped ? `${availStripped} ||| ${followUpReply}` : followUpReply;
        console.log(`Bookable: resolved [AVAILABILITY: ${availabilityKey}, ${availabilityDate}] -> ${slots.length} real slot(s) for ${seller.sellerId}.`);
      }
    }

    // Pull out the invisible [PHOTO: key] tag, if she included one, and
    // clean it out of the text so the customer never sees the tag itself.
    const { cleanText: photoStripped, photoKey } = extractPhotoTag(rawReply);

    // Pull out the invisible [PAY: key, zone] tag, if she flagged a
    // confirmed order. Also cleaned out before the customer ever sees it.
    const { cleanText: paymentStripped, paymentKey, paymentZone } = extractPaymentTag(photoStripped);

    // Bookable sellers only: pull out the invisible [BOOK: key, date, time]
    // tag, if she flagged a confirmed booking. Also cleaned out before the
    // customer ever sees it.
    const { cleanText: bookingStripped, bookingKey, bookingDate, bookingTime } = extractBookingTag(paymentStripped);

    // Pull out the invisible [ESCALATE: reason] tag, if she flagged that
    // the owner needs to step in. Also cleaned out before the customer
    // ever sees it.
    const { cleanText: taggedClean, escalationReason } = extractEscalationTag(bookingStripped);

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
    await saveConversation(seller.sellerId, from, history);

    // ---------- 4) REPLY on WhatsApp, one bubble at a time ----------
    for (let i = 0; i < bubbles.length; i++) {
      // Re-show the typing bubble before each message after the first,
      // so multi-part replies feel like separate thoughts, not a dump.
      if (i > 0 && messageId) {
        await markReadAndShowTyping(seller, messageId);
      }
      await humanPause(bubbles[i]);
      await sendWhatsApp(seller, from, bubbles[i]);
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
    if (photoKey && seller.catalog.PRODUCT_IMAGES[photoKey]) {
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
        await sendWhatsApp(seller, from, clarifyText);
        let clarifyHistory = await getConversation(seller.sellerId, from);
        clarifyHistory.push({ role: "assistant", content: clarifyText });
        clarifyHistory = clarifyHistory.slice(-10);
        await saveConversation(seller.sellerId, from, clarifyHistory);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const imageResult = await sendWhatsAppImage(seller, from, seller.catalog.PRODUCT_IMAGES[photoKey]);
        if (imageResult.success) {
          console.log(`Amara -> ${from}: [sent photo: ${photoKey}]`);
          await markPhotoSent(seller.sellerId, from, photoKey); // durable, survives everything
          if (imageResult.messageId) {
            // Meta accepting the call isn't proof it actually reached the
            // customer -- see the /webhook "failed" status handling below,
            // which is what catches it if this one silently doesn't land.
            await trackPendingPhotoSend(seller.sellerId, imageResult.messageId, from, photoKey);
          }
        } else {
          // A hard, immediate rejection from the API (bad token, bad
          // format, etc). Don't just log it and leave the customer with
          // an empty promise -- say so, and get the owner involved right
          // away rather than hoping a future AI turn notices and tags it.
          console.error(`Photo send FAILED for ${photoKey}, customer got no image.`);
          await sendWhatsApp(
            seller,
            from,
            "Hmm, that photo isn't sending from my side right now, let me flag this and sort it out."
          );
          await sendOwnerAlert(
            seller,
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
    // computed here from PRODUCT_PRICES + DELIVERY_STATES (or the
    // DELIVERY_DEFAULT_FEE fallback for "outside"), never from anything
    // the AI said in its own reply. Same "code is the real guarantee, the
    // prompt is just a nudge" principle as everywhere else in this file,
    // just applied to the one place a slip actually costs real naira.
    if (paymentKey && paymentZone) {
      const productPrice = seller.catalog.PRODUCT_PRICES[paymentKey];
      const deliveryFee =
        paymentZone in seller.catalog.DELIVERY_STATES
          ? seller.catalog.DELIVERY_STATES[paymentZone]
          : paymentZone === "outside"
            ? seller.catalog.DELIVERY_DEFAULT_FEE
            : undefined;

      if (!PAYSTACK_SECRET_KEY) {
        console.error("Payment tag fired but PAYSTACK_SECRET_KEY isn't set, no link sent.");
      } else if (productPrice === undefined || deliveryFee === undefined || deliveryFee === null) {
        console.error(
          `Payment tag had an unrecognized key/zone (${paymentKey}/${paymentZone}), no link sent.`
        );
      } else {
        const totalNaira = productPrice + deliveryFee;
        // seller1 keeps its exact original reference prefix, so nothing
        // about existing order-reference formatting shifts for the live
        // shop; any other seller gets its own short, still-recognizable
        // prefix instead.
        const refPrefix = seller.sellerId === SELLER1_ID ? "KP" : seller.sellerId.slice(0, 8).toUpperCase();
        const reference = `${refPrefix}-${from}-${Date.now()}`;
        // WhatsApp customers rarely have an email on hand mid-chat, and
        // Paystack requires one to initialize a transaction. A stable
        // placeholder per phone number is the standard workaround; it
        // never has to be real for the payment itself to work. seller1
        // keeps its original literal domain unchanged.
        const placeholderEmail =
          seller.sellerId === SELLER1_ID
            ? `${from}@customer.kpcollections.ng`
            : `${from}@customer.${seller.sellerId}.staflyai.ng`;

        const transaction = await initializePaystackTransaction(
          placeholderEmail,
          totalNaira * 100,
          reference,
          { phone: from, productKey: paymentKey, zone: paymentZone }
        );

        if (transaction?.authorization_url) {
          await createPendingOrder(reference, {
            phone: from,
            sellerId: seller.sellerId,
            productKey: paymentKey,
            zone: paymentZone,
            totalNaira,
            status: "pending",
          });

          const linkMessage =
            `Total: N${totalNaira.toLocaleString()} (N${productPrice.toLocaleString()} item + N${deliveryFee.toLocaleString()} delivery)\n` +
            `Pay here to lock in your order: ${transaction.authorization_url}`;

          await new Promise((resolve) => setTimeout(resolve, 900));
          await sendWhatsApp(seller, from, linkMessage);
          console.log(`Amara -> ${from}: [sent payment link] ${reference}`);

          let paymentHistory = await getConversation(seller.sellerId, from);
          paymentHistory.push({ role: "assistant", content: linkMessage });
          paymentHistory = paymentHistory.slice(-10);
          await saveConversation(seller.sellerId, from, paymentHistory);
        } else {
          console.error(`Paystack link generation FAILED for ${from}, order ${reference}.`);
        }
      }
    }

    // Bookable sellers only: if she flagged a confirmed booking, this is
    // the hard backstop for time, mirroring the payment backstop above --
    // the booking is only ever actually written after one final real
    // check right here, never trusted from her own words a message
    // earlier claiming a slot was free.
    if (bookingKey && bookingDate && bookingTime) {
      const offering = seller.catalog.OFFERINGS[bookingKey];
      if (!offering) {
        console.error(`Booking tag had an unrecognized service key (${bookingKey}), no booking created.`);
      } else {
        const refPrefix = seller.sellerId === SELLER1_ID ? "KP" : seller.sellerId.slice(0, 8).toUpperCase();
        const reference = `${refPrefix}-BOOK-${from}-${Date.now()}`;
        const result = await createBookingIfAvailable(seller, bookingKey, bookingDate, bookingTime, from, reference);

        if (result.ok) {
          const confirmMessage =
            `Booked: ${offering.name} on ${bookingDate} at ${bookingTime}. ` +
            `N${offering.price.toLocaleString()}, payable at the time of your session. Reference: ${reference}`;

          await new Promise((resolve) => setTimeout(resolve, 900));
          await sendWhatsApp(seller, from, confirmMessage);
          console.log(`Amara -> ${from}: [booking confirmed] ${reference}`);

          let bookingHistory = await getConversation(seller.sellerId, from);
          bookingHistory.push({ role: "assistant", content: confirmMessage });
          bookingHistory = bookingHistory.slice(-10);
          await saveConversation(seller.sellerId, from, bookingHistory);
        } else {
          // The slot got taken (by someone else, or the AI misremembered
          // what was actually offered) between Amara offering it and the
          // customer confirming. Tell her so for real and let HER
          // apologize and offer fresh times in her own voice, rather than
          // the system staying silent while her own text already implied
          // it was locked in. Deliberately told not to use any tags in
          // this one reply -- it's a narrow, single-purpose follow-up, not
          // a full new turn, so re-running the entire tag pipeline on it
          // would be more machinery than the situation needs.
          const freshSlots = getAvailableSlots(seller, bookingKey, bookingDate);
          const failNote =
            `That exact time (${bookingTime} on ${bookingDate} for "${offering.name}") just got taken ` +
            `by someone else a moment ago. Apologize briefly and ${
              freshSlots.length > 0
                ? `offer these other real times still open that day: ${freshSlots.join(", ")}`
                : "let them know that day is now full, offer to check a different day"
            }. Do not use any tags in this reply, just the plain customer-facing message.`;
          const apologyReply = await askAI(seller, history, failNote);
          const apologyClean = stripBannedEmojis(stripSelfCorrection(apologyReply.trim()));

          await new Promise((resolve) => setTimeout(resolve, 900));
          await sendWhatsApp(seller, from, apologyClean);
          console.log(`Amara -> ${from}: [booking conflict, sent apology] ${bookingKey}/${bookingDate}/${bookingTime}`);

          let apologyHistory = await getConversation(seller.sellerId, from);
          apologyHistory.push({ role: "assistant", content: apologyClean });
          apologyHistory = apologyHistory.slice(-10);
          await saveConversation(seller.sellerId, from, apologyHistory);
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
      await sendOwnerAlert(seller, from, escalationReason, combinedText);
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
        seller,
        from,
        "Sorry, small network wahala my side. Still here, please try that again."
      );
    } catch (fallbackErr) {
      console.error("Fallback reply also failed:", fallbackErr);
    }
  }
}

// ---------- The AI call ----------
async function askAI(seller, history, dynamicReminder = "") {
  try {
    // Safety cap: never let this hang forever if Anthropic's API is slow
    // or unreachable. 20 seconds is generous but bounded.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    // Facts that must never be forgotten (like which photos already went
    // out) get appended fresh to the system prompt on every single call,
    // rather than relying on them surviving inside the rolling chat
    // history, which can get pushed out during a long or busy conversation.
    const shopProfile = buildShopProfile(seller);
    const systemPrompt = dynamicReminder ? `${shopProfile}\n\n${dynamicReminder}` : shopProfile;

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
async function markReadAndShowTyping(seller, messageId) {
  if (!seller.phoneNumberId || !seller.whatsappToken) return; // not connected yet, nothing to do
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${seller.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seller.whatsappToken}`,
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
async function markReadOnly(seller, messageId) {
  if (!seller.phoneNumberId || !seller.whatsappToken) return; // not connected yet, nothing to do
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${seller.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seller.whatsappToken}`,
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

// ---------- Bookable sellers only: pull the invisible [AVAILABILITY: key, date] tag ----------
function extractAvailabilityTag(text) {
  const match = text.match(/\[AVAILABILITY:\s*(\w+)\s*,\s*(\d{4}-\d{2}-\d{2})\]/i);
  if (!match) return { cleanText: text.trim(), availabilityKey: null, availabilityDate: null };

  const availabilityKey = match[1].toLowerCase();
  const availabilityDate = match[2];
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, availabilityKey, availabilityDate };
}

// ---------- Bookable sellers only: pull the invisible [BOOK: key, date, time] tag ----------
function extractBookingTag(text) {
  const match = text.match(/\[BOOK:\s*(\w+)\s*,\s*(\d{4}-\d{2}-\d{2})\s*,\s*([01]\d|2[0-3]):([0-5]\d)\]/i);
  if (!match) return { cleanText: text.trim(), bookingKey: null, bookingDate: null, bookingTime: null };

  const bookingKey = match[1].toLowerCase();
  const bookingDate = match[2];
  const bookingTime = `${match[3]}:${match[4]}`;
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, bookingKey, bookingDate, bookingTime };
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
async function sendWhatsAppImage(seller, to, imageUrl) {
  if (!seller.phoneNumberId || !seller.whatsappToken) {
    console.error(`sendWhatsAppImage: seller ${seller.sellerId} has no WhatsApp number connected yet.`);
    return { success: false, messageId: null };
  }
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${seller.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seller.whatsappToken}`,
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
async function sendWhatsApp(seller, to, text) {
  if (!seller.phoneNumberId || !seller.whatsappToken) {
    console.error(`sendWhatsApp: seller ${seller.sellerId} has no WhatsApp number connected yet, message not sent.`);
    return false;
  }
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${seller.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seller.whatsappToken}`,
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

async function sendWhatsAppTemplate(seller, to, templateName, languageCode, parameters) {
  if (!seller.phoneNumberId || !seller.whatsappToken) {
    console.error(`sendWhatsAppTemplate: seller ${seller.sellerId} has no WhatsApp number connected yet.`);
    return false;
  }
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${seller.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seller.whatsappToken}`,
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
async function buildOwnerBusinessSummary(sellerId) {
  const customers = await listAllCustomers(sellerId);
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

async function answerOwnerQuestion(seller, ownerText, businessSummary) {
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
    const reply = await askAI(seller, [{ role: "user", content: instruction }]);
    const { cleanText: step1 } = extractPhotoTag(reply);
    const { cleanText: step2 } = extractEscalationTag(step1);
    const finalText = stripBannedEmojis(stripSelfCorrection(step2)).trim();
    return finalText || fallback;
  } catch (err) {
    console.error("answerOwnerQuestion failed:", err.message);
    return fallback;
  }
}


async function generateResumeFollowUp(seller, reason, ownerMessage) {
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
    const reply = await askAI(seller, [{ role: "user", content: instruction }]);
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

async function handleOwnerCommand(seller, text) {
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
        awaitingPauseConfirmation = !!(await redisCommand(["GET", nsKey(seller.sellerId, "awaiting_pause_confirmation")]));
      } catch (err) {
        console.error("Could not check awaiting_pause_confirmation flag:", err.message);
      }
      if (awaitingPauseConfirmation) {
        command = { action: "pause", target: "last" };
        try {
          await redisCommand(["DEL", nsKey(seller.sellerId, "awaiting_pause_confirmation")]);
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
    const businessSummary = await buildOwnerBusinessSummary(seller.sellerId);
    const answer = await answerOwnerQuestion(seller, text, businessSummary);
    await sendWhatsApp(seller, seller.ownerPhoneNumber, answer);
    return;
  }

  let target = command.target;
  if (target === "last") {
    target = await getLastEscalatedCustomer(seller.sellerId);
    if (!target) {
      await sendWhatsApp(
        seller,
        seller.ownerPhoneNumber,
        `No recent customer to ${command.action}. Try "${command.action} <their number>" instead.`
      );
      return;
    }
  }

  if (command.action === "pause") {
    await pauseCustomer(seller.sellerId, target);
    await sendWhatsApp(
      seller,
      seller.ownerPhoneNumber,
      `Got it, I'll step back for ${target}. Text "resume ${target}" (or just tell me naturally) when you're done, or I'll pick back up automatically in 6 hours.`
    );
  } else {
    await resumeCustomer(seller.sellerId, target);
    await sendWhatsApp(seller, seller.ownerPhoneNumber, `Back on it for ${target}.`);

    // Proactively let the customer know, rather than leaving them to
    // wonder, or risking Amara improvising a stale "still waiting" reply
    // if they happen to message again before anyone's told her otherwise.
    // What she actually says reflects what they needed, not a generic line.
    const customerRecord = await getCustomer(seller.sellerId, target);
    const followUp = await generateResumeFollowUp(seller, customerRecord?.last_escalation_reason, text);
    const notified = await sendWhatsApp(seller, target, followUp);
    if (notified) {
      let customerHistory = await getConversation(seller.sellerId, target);
      customerHistory.push({ role: "assistant", content: followUp });
      customerHistory = customerHistory.slice(-10);
      await saveConversation(seller.sellerId, target, customerHistory);
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


async function sendOwnerAlert(seller, customerNumber, reason, lastCustomerMessage) {
  if (!seller.ownerPhoneNumber) {
    console.error(
      `ESCALATION happened for seller ${seller.sellerId} but no owner phone number is set, no alert sent. Reason:`,
      reason
    );
    return;
  }

  // Remember who this was about, so "pause last" / "resume last" work
  // without the owner needing to type or copy a phone number under pressure.
  await setLastEscalatedCustomer(seller.sellerId, customerNumber);

  // Template parameters can't contain newlines, keep them single-line.
  const cleanReason = reason.replace(/\s+/g, " ").trim();
  const cleanLastMessage = lastCustomerMessage.replace(/\s+/g, " ").trim();

  // Keep this on the customer's own record too, so it's visible at a
  // glance in the customer list, not just buried in a WhatsApp alert.
  await upsertCustomer(seller.sellerId, customerNumber, {
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
    await redisCommand(["SET", nsKey(seller.sellerId, "awaiting_pause_confirmation"), "1", "EX", "600"]); // 10 min window
  } catch (err) {
    console.error("Could not set awaiting_pause_confirmation flag:", err.message);
  }

  const freeFormSucceeded = await sendWhatsApp(seller, seller.ownerPhoneNumber, alertText);
  if (freeFormSucceeded) return;

  console.log("Free-form owner alert failed, falling back to template message.");
  const templateSucceeded = await sendWhatsAppTemplate(
    seller,
    seller.ownerPhoneNumber,
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
// ---------- Shared visual identity (brand mark + color tokens) ----------
// Every HTML page below grew its own inline colors as it was built, so the
// product read as five slightly different pages instead of one thing. These
// two shared pieces fix that everywhere at once: BRAND_TOKENS_CSS is a set
// of CSS custom properties every page's <style> block starts with, and
// brandMark() is the one small logo lockup every header uses instead of
// plain "Stafly.AI" text. --navy stays the structural color (headers, body
// text, secondary buttons, the AI's own chat bubbles) so it keeps meaning
// "Stafly.AI itself"; --accent is the single color introduced for primary,
// clickable actions (buttons, active tabs, links, chart bars) so those
// stand out from the chrome around them instead of everything being the
// same dark navy.
// One shared web font (Sora) loaded via Google Fonts on every page, so the
// whole product reads consistently instead of falling back to whatever
// system font each visitor's device happens to have. Sora was picked over
// Bricolage Grotesque for this app specifically because this is a
// dense, data-heavy UI (tables, small badges, forms) where Sora's plainer,
// more geometric letterforms stay easy to read at small sizes; Bricolage's
// more distinctive/quirky character is better suited to a future marketing
// landing page's big headlines than to a live dashboard.
const GOOGLE_FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const BRAND_TOKENS_CSS = `
  :root {
    --font-sans: 'Sora', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --navy: #1e293b;
    --accent: #4f46e5;
    --accent-dark: #4338ca;
    --accent-light: #eef2ff;
    --bg: #f8fafc;
    --border: #e2e8f0;
    --border-light: #f1f5f9;
    --muted: #64748b;
    --text: #1e293b;
    --danger: #dc2626;
    --danger-bg: #fef2f2;
    --success: #15803d;
    --success-bg: #dcfce7;
    --warning: #b45309;
    --warning-bg: #fef3c7;
  }
`;

function brandMark({ dark = false, size = "normal" } = {}) {
  const textColor = dark ? "#fff" : "var(--navy)";
  const fontSize = size === "small" ? "13px" : "16px";
  return (
    `<span style="display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:${fontSize};color:${textColor};">` +
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:var(--accent);color:#fff;font-size:13px;flex-shrink:0;">S</span>` +
    `Stafly<span style="color:${dark ? "#a5b4fc" : "var(--accent)"};">.AI</span>` +
    `</span>`
  );
}

// ---------- SELLER SIGNUP / LOGIN PAGES ----------
function authPageHtml({ title, heading, formHtml, error }) {
  return `
    <html>
    <head>
      <title>${title} — Stafly.AI</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${GOOGLE_FONT_LINK}
      <style>
        ${BRAND_TOKENS_CSS}
        body { font-family: var(--font-sans); margin:0; background:var(--bg); color:var(--text); display:flex; align-items:center; justify-content:center; min-height:100vh; }
        .auth-card { background:white; padding:32px; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.08); width:100%; max-width:360px; }
        .auth-card .brand-row { margin-bottom:20px; }
        .auth-card h1 { font-size:18px; margin:0 0 4px; }
        .auth-card label { font-size:12px; color:var(--muted); display:block; margin:14px 0 4px; }
        .auth-card input { width:100%; padding:9px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:14px; box-sizing:border-box; }
        .auth-card input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-light); }
        .auth-card button { width:100%; margin-top:20px; padding:10px; background:var(--accent); color:white; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
        .auth-card button:hover { background:var(--accent-dark); }
        .auth-error { background:var(--danger-bg); color:var(--danger); padding:8px 10px; border-radius:6px; font-size:13px; margin-top:14px; }
        .auth-footer { text-align:center; font-size:13px; color:var(--muted); margin-top:16px; }
        .auth-footer a { color:var(--accent); font-weight:600; text-decoration:none; }
        .business-type-choice { display:flex; flex-direction:column; gap:8px; }
        .business-type-option { display:flex; align-items:center; gap:8px; font-size:13px; color:#1e293b; font-weight:400; margin:0; padding:9px 10px; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer; }
        .business-type-option input { width:auto; }
      </style>
    </head>
    <body>
      <div class="auth-card">
        <div class="brand-row">${brandMark()}</div>
        <h1>${escapeHtmlServer(heading)}</h1>
        <form method="POST">
          ${formHtml}
          <button type="submit">${escapeHtmlServer(title)}</button>
        </form>
        ${error ? `<div class="auth-error">${escapeHtmlServer(error)}</div>` : ""}
        ${
          title === "Sign up"
            ? '<div class="auth-footer">Already have an account? <a href="/login">Log in</a></div>'
            : '<div class="auth-footer">New seller? <a href="/signup">Create an account</a></div>'
        }
      </div>
    </body>
    </html>
  `;
}

// The business-type choice on signup, shared between the GET form and the
// POST failure re-render so a validation error doesn't lose the seller's
// pick. Kept selected="" via a plain string match against whatever was
// last submitted (empty string on first load defaults to "goods").
function businessTypeFieldHtml(selected) {
  const goodsChecked = selected !== "bookable" ? "checked" : "";
  const bookableChecked = selected === "bookable" ? "checked" : "";
  return `
        <label>What are you selling?</label>
        <div class="business-type-choice">
          <label class="business-type-option">
            <input type="radio" name="businessType" value="goods" ${goodsChecked}>
            Physical products (with delivery)
          </label>
          <label class="business-type-option">
            <input type="radio" name="businessType" value="bookable" ${bookableChecked}>
            Bookable services (appointments, consultations)
          </label>
        </div>
  `;
}

app.get("/signup", (req, res) => {
  res.send(
    authPageHtml({
      title: "Sign up",
      heading: "Create your seller account",
      formHtml: `
        <label>Business name</label>
        <input name="businessName" required maxlength="120">
        <label>Email</label>
        <input type="email" name="email" required maxlength="200">
        <label>Password</label>
        <input type="password" name="password" required minlength="8" maxlength="200">
        ${businessTypeFieldHtml("")}
      `,
    })
  );
});

app.post("/signup", async (req, res) => {
  const businessName = (req.body?.businessName || "").trim();
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  const businessType = req.body?.businessType === "bookable" ? "bookable" : "goods";

  const fail = (msg) =>
    res.status(400).send(
      authPageHtml({
        title: "Sign up",
        heading: "Create your seller account",
        error: msg,
        formHtml: `
          <label>Business name</label>
          <input name="businessName" required maxlength="120" value="${escapeHtmlServer(businessName)}">
          <label>Email</label>
          <input type="email" name="email" required maxlength="200" value="${escapeHtmlServer(email)}">
          <label>Password</label>
          <input type="password" name="password" required minlength="8" maxlength="200">
          ${businessTypeFieldHtml(businessType)}
        `,
      })
    );

  if (!businessName) return fail("Business name is required.");
  if (!email || !email.includes("@")) return fail("Please enter a valid email.");
  if (!password || password.length < 8) return fail("Password must be at least 8 characters.");

  try {
    const existing = await getSellerByEmail(email);
    if (existing) return fail("An account with that email already exists — try logging in instead.");

    const passwordHash = await bcrypt.hash(password, 10);
    const sellerId = await createSeller({ businessName, email, passwordHash, businessType });

    res.cookie("session", signSession(sellerId), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect("/seller/dashboard");
  } catch (err) {
    console.error("signup failed:", err.message);
    fail("Something went wrong, please try again.");
  }
});

app.get("/login", (req, res) => {
  res.send(
    authPageHtml({
      title: "Log in",
      heading: "Log in to Stafly.AI",
      formHtml: `
        <label>Email</label>
        <input type="email" name="email" required maxlength="200">
        <label>Password</label>
        <input type="password" name="password" required maxlength="200">
      `,
    })
  );
});

app.post("/login", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";

  const fail = (msg) =>
    res.status(401).send(
      authPageHtml({
        title: "Log in",
        heading: "Log in to Stafly.AI",
        error: msg,
        formHtml: `
          <label>Email</label>
          <input type="email" name="email" required maxlength="200" value="${escapeHtmlServer(email)}">
          <label>Password</label>
          <input type="password" name="password" required maxlength="200">
        `,
      })
    );

  try {
    const seller = await getSellerByEmail(email);
    // Same generic message either way — don't reveal whether the email
    // exists at all, standard practice for a real login page.
    if (!seller) return fail("Incorrect email or password.");
    const matches = await bcrypt.compare(password, seller.passwordHash || "");
    if (!matches) return fail("Incorrect email or password.");

    res.cookie("session", signSession(seller.sellerId), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect("/seller/dashboard");
  } catch (err) {
    console.error("login failed:", err.message);
    fail("Something went wrong, please try again.");
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("session");
  res.redirect("/login");
});

app.get("/seller/dashboard", requireSellerAuth, (req, res) => {
  const seller = req.seller;
  const statusLine =
    seller.status === "active"
      ? "Your WhatsApp number is connected and Amara is live."
      : "WhatsApp connection: pending — this part isn't self-serve yet, we'll reach out personally to get your number connected.";
  const dashboardLink =
    seller.status === "active"
      ? '<div style="margin-top:18px;"><a class="btn-primary-link" href="/dashboard">Open your live conversation dashboard →</a></div>'
      : "";
  res.send(`
    <html>
    <head>
      <title>Seller dashboard — Stafly.AI</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${GOOGLE_FONT_LINK}
      <style>
        ${BRAND_TOKENS_CSS}
        body { font-family: var(--font-sans); margin:0; background:var(--bg); color:var(--text); }
        header { background:var(--navy); color:white; padding:16px 24px; display:flex; align-items:center; justify-content:space-between; }
        header form { margin:0; }
        header button { background:transparent; border:1px solid rgba(255,255,255,0.3); color:white; padding:6px 12px; border-radius:6px; font-size:12px; cursor:pointer; }
        .wrap { max-width:640px; margin:32px auto; padding:0 24px; }
        .card { background:white; border-radius:8px; padding:24px; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
        .card h2 { font-size:16px; margin:0 0 6px; }
        .status { font-size:14px; color:#475569; margin-top:8px; padding:12px; background:var(--bg); border-radius:6px; border:1px solid var(--border); }
        .btn-primary-link { display:inline-block; padding:9px 16px; background:var(--accent); color:white !important; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; }
        .btn-primary-link:hover { background:var(--accent-dark); }
      </style>
    </head>
    <body>
      <header>
        ${brandMark({ dark: true })}
        <form method="POST" action="/logout"><button type="submit">Log out</button></form>
      </header>
      <div class="wrap">
        <div class="card">
          <h2>Welcome, ${escapeHtmlServer(seller.businessName)}</h2>
          <div>${escapeHtmlServer(seller.email)}</div>
          <div class="status">${escapeHtmlServer(statusLine)}</div>
          ${dashboardLink}
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get("/customers", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL, or log in as a seller.");
  }

  const customers = await listAllCustomers(seller.sellerId);
  // Most recently contacted first, so the busiest/newest conversations are on top.
  customers.sort((a, b) => new Date(b.last_contact || 0) - new Date(a.last_contact || 0));

  const rows = customers
    .map((c) => {
      const pausedBadge =
        c.paused === "yes"
          ? '<span class="badge paused">Paused</span>'
          : '<span class="badge active">Active</span>';
      const paidBadge = c.last_payment_at
        ? `<span class="badge paid">N${Number(c.last_payment_amount || 0).toLocaleString()}</span>`
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

  const dashboardHref =
    "/dashboard" +
    (req.query.key
      ? "?key=" + encodeURIComponent(req.query.key) + (req.query.sellerId ? "&sellerId=" + encodeURIComponent(req.query.sellerId) : "")
      : "");

  res.send(`
    <html>
    <head>
      <title>Stafly.AI - Customers</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${GOOGLE_FONT_LINK}
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; }
        body { font-family: var(--font-sans); margin: 0; background: var(--bg); color: var(--text); }
        header { background: var(--navy); color: white; padding: 16px 24px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
        header .sub { font-size: 12px; color: rgba(255,255,255,0.7); margin-top:2px; }
        header a { display:inline-block; padding:7px 14px; background: var(--accent); color: white; border-radius:6px; font-size:12px; font-weight:600; text-decoration:none; }
        header a:hover { background: var(--accent-dark); }
        .wrap { max-width: 1080px; margin: 28px auto; padding: 0 24px; }
        .table-card { background: white; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); overflow: hidden; }
        table { border-collapse: collapse; width: 100%; }
        th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border-light); font-size: 13px; }
        th { background: var(--bg); color: var(--muted); font-weight: 600; font-size: 12px; }
        tr:hover td { background: var(--bg); }
        .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; white-space:nowrap; font-weight:600; }
        .badge.paused { background: var(--warning-bg); color: var(--warning); }
        .badge.active { background: var(--success-bg); color: var(--success); }
        .badge.paid { background: var(--success-bg); color: var(--success); }
        .empty-note { padding: 32px; text-align: center; color: #94a3b8; font-size: 13px; }
      </style>
    </head>
    <body>
      <header>
        <div>
          ${brandMark({ dark: true })}
          <div class="sub">${customers.length} customer${customers.length === 1 ? "" : "s"}${seller.businessName ? " &middot; " + escapeHtmlServer(seller.businessName) : ""}</div>
        </div>
        <a href="${dashboardHref}">Open live dashboard →</a>
      </header>
      <div class="wrap">
        <div class="table-card">
          <table>
            <tr>
              <th>Phone</th><th>Status</th><th>First contact</th><th>Last contact</th>
              <th>Messages</th><th>Last escalation</th><th>Escalated at</th>
              <th>Last payment</th><th>Paid at</th>
            </tr>
            ${rows}
          </table>
          ${customers.length === 0 ? '<div class="empty-note">No customers yet.</div>' : ""}
        </div>
      </div>
    </body>
    </html>
  `);
});

// ---------- ADMIN PANEL (one place to reach every seller) ----------
// Before this, acting as a seller other than seller1 meant hand-typing a
// sellerId into a URL, or constructing a raw curl call to connect a
// WhatsApp number -- workable for testing, not something to actually run
// a growing platform on. This page is the fix: every seller in one list,
// a click to open their live dashboard (no sellerId to type or remember),
// and a small form instead of a raw API call to connect their number.
// Gated by the same master ADMIN_KEY as everything else admin-only.
function adminPanelHtml(key, sellers) {
  const rows = sellers
    .map((s) => {
      // Every field on `s` came straight out of Redis via HGETALL, which
      // means it's a raw string (or undefined), never an actual boolean --
      // "0" included. `s.suspended ? ...` was therefore ALWAYS true once a
      // seller had ever been suspended even once, since a non-empty string
      // like "0" is truthy in JS: after resuming, the badge kept showing
      // "Suspended" and this button kept reading "Resume" and calling
      // toggleSuspend(id, false) on every click, no-op-ing forever because
      // it thought the seller was still suspended. Comparing against the
      // literal string "1" (matching how /api/admin/suspend-seller writes
      // it) is what actually reads the real state.
      const isSuspended = s.suspended === "1";
      const statusBadge =
        s.status === "active"
          ? '<span class="badge active">Active</span>'
          : '<span class="badge pending">Pending</span>';
      const suspendedBadge = isSuspended ? ' <span class="badge suspended">Suspended</span>' : "";
      const dashboardHref =
        `/dashboard?key=${encodeURIComponent(key)}` +
        (s.sellerId === SELLER1_ID ? "" : `&sellerId=${encodeURIComponent(s.sellerId)}`);
      const isSeller1 = s.sellerId === SELLER1_ID;
      // sellerId is always a controlled hex string (see makeSellerId), safe
      // to drop straight into an onclick(...) call like the existing
      // Connect WhatsApp button already does. businessName is NOT controlled
      // -- it's whatever the seller typed at signup, so it can contain
      // spaces, quotes, anything. It must never be interpolated directly
      // into an inline onclick="..." attribute (an earlier version of this
      // did exactly that via JSON.stringify(), and a name like "ALIKA
      // FOUNDATION" -- or any name that isn't a single bare word -- broke
      // the attribute's quoting and corrupted the rest of the page's HTML,
      // which is why every button on the page, not just Delete, silently
      // stopped responding). It goes through a proper HTML-escaped
      // data-attribute instead, read back via .dataset in the script below,
      // so there's no string-into-HTML interpolation left to break.
      const holdDeleteButtons = isSeller1
        ? ""
        : `<button class="btn secondary" onclick="toggleSuspend('${s.sellerId}', ${isSuspended ? "false" : "true"})">${isSuspended ? "Resume" : "Suspend"}</button>
          <button class="btn danger delete-seller-btn" data-seller-id="${escapeHtmlServer(s.sellerId)}" data-business-name="${escapeHtmlServer(s.businessName || "this seller")}">Delete</button>`;
      return `<tr>
        <td>${escapeHtmlServer(s.businessName || "")}${isSeller1 ? ' <span class="you-badge">your shop</span>' : ""}</td>
        <td>${escapeHtmlServer(s.email || "")}</td>
        <td>${statusBadge}${suspendedBadge}</td>
        <td>
          <a class="btn" href="${dashboardHref}">Open dashboard</a>
          <button class="btn secondary" onclick="toggleConnect('${s.sellerId}')">Connect WhatsApp</button>
          ${holdDeleteButtons}
          <div class="connect-form" id="connect-${s.sellerId}">
            <label>Phone number ID</label>
            <input id="pni-${s.sellerId}" value="${escapeHtmlServer(s.phoneNumberId || "")}" placeholder="from Meta's WhatsApp Manager">
            <label>WhatsApp access token</label>
            <input id="tok-${s.sellerId}" placeholder="permanent access token">
            <label>Owner's phone number (for escalation alerts)</label>
            <input id="own-${s.sellerId}" value="${escapeHtmlServer(s.ownerPhoneNumber || "")}" placeholder="234...">
            <button class="btn" style="margin-top:8px;" onclick="connectSeller('${s.sellerId}')">Save connection</button>
            <div class="connect-msg" id="msg-${s.sellerId}"></div>
          </div>
          <div class="connect-msg" id="action-msg-${s.sellerId}"></div>
        </td>
      </tr>`;
    })
    .join("");

  return `
    <html>
    <head>
      <title>Admin — Stafly.AI</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${GOOGLE_FONT_LINK}
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; }
        body { font-family: var(--font-sans); margin:0; background:var(--bg); color:var(--text); }
        header { background:var(--navy); color:white; padding:16px 24px; }
        header .sub { font-size:12px; color:rgba(255,255,255,0.65); margin-top:2px; }
        .wrap { max-width:960px; margin:32px auto; padding:0 24px; }
        table { width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
        th, td { text-align:left; padding:12px 14px; border-bottom:1px solid var(--border-light); font-size:13px; vertical-align:top; }
        th { background:var(--bg); color:var(--muted); font-weight:600; font-size:12px; }
        .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; white-space:nowrap; }
        .badge.active { background:var(--success-bg); color:var(--success); }
        .badge.pending { background:var(--warning-bg); color:var(--warning); }
        .badge.suspended { background:var(--danger-bg, #fee2e2); color:var(--danger, #dc2626); margin-left:4px; }
        .you-badge { font-size:11px; color:var(--muted); }
        a.btn, button.btn { display:inline-block; background:var(--accent); color:white; border:none; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; text-decoration:none; margin:2px 6px 2px 0; }
        a.btn:hover, button.btn:hover { background:var(--accent-dark); }
        button.btn.secondary { background:transparent; color:var(--navy); border:1px solid #cbd5e1; }
        button.btn.secondary:hover { background:var(--bg); }
        button.btn.danger { background:transparent; color:var(--danger, #dc2626); border:1px solid var(--danger, #dc2626); }
        button.btn.danger:hover { background:var(--danger-bg, #fee2e2); }
        .connect-form { display:none; margin-top:10px; padding:12px; background:var(--bg); border-radius:6px; border:1px solid var(--border); max-width:340px; }
        .connect-form.open { display:block; }
        .connect-form label { font-size:11px; color:var(--muted); display:block; margin:8px 0 3px; }
        .connect-form input { width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; }
        .connect-msg { font-size:12px; margin-top:6px; min-height:14px; }
        .connect-msg.error { color:var(--danger); }
        .connect-msg.ok { color:var(--success); }
        .empty-note { padding:24px; text-align:center; color:#94a3b8; font-size:13px; }
      </style>
    </head>
    <body>
      <header>
        ${brandMark({ dark: true })}
        <div class="sub">Admin &middot; all sellers</div>
      </header>
      <div class="wrap">
        <table>
          <thead><tr><th>Business</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${sellers.length === 0 ? '<div class="empty-note">No sellers yet.</div>' : ""}
      </div>
      <script>
        function toggleConnect(id) {
          document.getElementById("connect-" + id).classList.toggle("open");
        }
        async function connectSeller(id) {
          const phoneNumberId = document.getElementById("pni-" + id).value.trim();
          const whatsappToken = document.getElementById("tok-" + id).value.trim();
          const ownerPhoneNumber = document.getElementById("own-" + id).value.trim();
          const msg = document.getElementById("msg-" + id);
          msg.textContent = "";
          msg.className = "connect-msg";
          try {
            const res = await fetch("/api/admin/connect-seller-whatsapp?key=${encodeURIComponent(key)}", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sellerId: id, phoneNumberId, whatsappToken, ownerPhoneNumber }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Failed to connect.";
              msg.className = "connect-msg error";
              return;
            }
            msg.textContent = "Connected! Reloading...";
            msg.className = "connect-msg ok";
            setTimeout(function () { location.reload(); }, 800);
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "connect-msg error";
          }
        }
        async function toggleSuspend(id, suspend) {
          const msg = document.getElementById("action-msg-" + id);
          msg.textContent = "";
          msg.className = "connect-msg";
          try {
            const res = await fetch("/api/admin/suspend-seller?key=${encodeURIComponent(key)}", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sellerId: id, suspended: suspend }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Failed to update.";
              msg.className = "connect-msg error";
              return;
            }
            msg.textContent = suspend ? "Suspended. Reloading..." : "Resumed. Reloading...";
            msg.className = "connect-msg ok";
            setTimeout(function () { location.reload(); }, 600);
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "connect-msg error";
          }
        }
        async function deleteSeller(id, businessName) {
          if (!confirm("Permanently delete \\"" + businessName + "\\"? This removes their account and every conversation, customer, and booking/catalog record. This can't be undone.")) {
            return;
          }
          const msg = document.getElementById("action-msg-" + id);
          msg.textContent = "Deleting...";
          msg.className = "connect-msg";
          try {
            const res = await fetch("/api/admin/delete-seller?key=${encodeURIComponent(key)}", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sellerId: id }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Failed to delete.";
              msg.className = "connect-msg error";
              return;
            }
            msg.textContent = "Deleted. Reloading...";
            msg.className = "connect-msg ok";
            setTimeout(function () { location.reload(); }, 600);
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "connect-msg error";
          }
        }
        // Wired up via addEventListener + data-* attributes rather than an
        // inline onclick="deleteSeller('id', '<business name>')" -- a
        // business name is arbitrary seller-typed text (spaces, quotes,
        // anything), and splicing it straight into an HTML attribute is
        // exactly the kind of thing that silently breaks the page. Reading
        // it back through .dataset lets the browser handle the escaping.
        document.querySelectorAll(".delete-seller-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            deleteSeller(btn.dataset.sellerId, btn.dataset.businessName);
          });
        });
      </script>
    </body>
    </html>
  `;
}

app.get("/admin", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL.");
  }
  try {
    const ids = (await redisCommand(["SMEMBERS", "all_sellers"])) || [];
    const sellers = (await Promise.all(ids.map((id) => getSellerById(id)))).filter(Boolean);
    // seller1 (your own shop) always first, then everyone else newest first.
    sellers.sort((a, b) => {
      if (a.sellerId === SELLER1_ID) return -1;
      if (b.sellerId === SELLER1_ID) return 1;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    res.send(adminPanelHtml(req.query.key, sellers));
  } catch (err) {
    console.error("admin panel failed:", err.message);
    res.status(500).send("Failed to load admin panel.");
  }
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

function dashboardHtml(key, sellerId, businessName, businessType) {
  const isBookable = businessType === "bookable";
  // The admin key (and, when viewing a seller other than seller1, that
  // seller's id) gets embedded into the page's own JS so its fetch calls
  // can authenticate, same trust boundary as the ?key= on the page itself
  // — anyone who could load this page already has the key.
  return `
    <html>
    <head>
      <title>Stafly.AI — Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${GOOGLE_FONT_LINK}
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; }
        body { font-family: var(--font-sans); margin: 0; background: var(--bg); color: var(--text); }
        header { background: var(--navy); color: white; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
        header h1 { font-size: 15px; margin: 0; font-weight: 400; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        header h1 .sep { opacity: 0.85; }
        header a { color: #c7d2fe; font-size: 12px; }
        nav.tabs { display: flex; gap: 4px; }
        nav.tabs button { background: transparent; border: 1px solid rgba(255,255,255,0.25); color: #cbd5e1; padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; }
        nav.tabs button.active-tab { background: var(--accent-light); color: var(--accent-dark); border-color: var(--accent-light); font-weight: 600; }
        .stats { display: flex; gap: 12px; flex-wrap: wrap; }
        .stat { background: rgba(255,255,255,0.08); padding: 6px 12px; border-radius: 6px; font-size: 13px; white-space: nowrap; }
        .stat b { font-size: 15px; }
        .layout { display: flex; height: calc(100vh - 64px); }
        .list-pane { width: 320px; border-right: 1px solid #e2e8f0; background: white; flex-shrink: 0; display: flex; flex-direction: column; }
        .search-box { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
        .search-box input { width: 100%; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .list { flex: 1; overflow-y: auto; }
        .list-item { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
        .list-item:hover { background: #f8fafc; }
        .list-item.active-row { background: var(--accent-light); }
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
        .catalog-view { padding: 24px; max-width: 800px; margin: 0 auto; overflow-y: auto; height: calc(100vh - 64px); }
        .catalog-card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .catalog-card h2 { font-size: 15px; margin: 0 0 14px; }
        table.catalog-table { width: 100%; border-collapse: collapse; }
        table.catalog-table th, table.catalog-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f1f5f9; font-size: 13px; vertical-align: middle; }
        table.catalog-table th { color: #64748b; font-weight: 600; font-size: 12px; }
        table.catalog-table img { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; background: #f1f5f9; }
        .catalog-form { display: grid; grid-template-columns: 1fr 1fr 1.4fr auto; gap: 8px; align-items: end; margin-top: 4px; }
        .catalog-form label { font-size: 11px; color: #64748b; display: block; margin-bottom: 3px; }
        .catalog-form input { width: 100%; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .catalog-form textarea { width: 100%; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; }
        .catalog-btn { background: var(--accent); color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .catalog-btn:hover { background: var(--accent-dark); }
        .catalog-btn.danger { background: transparent; color: var(--danger); font-weight: 500; padding: 4px 8px; }
        .catalog-btn.small { padding: 6px 10px; font-size: 12px; }
        .catalog-msg { font-size: 12px; margin-top: 8px; min-height: 16px; }
        .catalog-msg.error { color: #dc2626; }
        .catalog-msg.ok { color: #15803d; }
        .fees-row { display: flex; gap: 16px; align-items: end; }
        .fees-row div { width: 160px; }
        .msg-compose { display: flex; gap: 8px; padding: 12px 24px; border-top: 1px solid #e2e8f0; background: white; }
        .msg-compose input { flex: 1; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .notes-box { padding: 12px 24px; border-top: 1px solid #e2e8f0; background: #fdfdfd; }
        .notes-box label { font-size: 11px; color: #64748b; display: block; margin-bottom: 4px; }
        .notes-box textarea { width: 100%; min-height: 46px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; }
        .trend-chart { display: flex; align-items: flex-end; gap: 6px; height: 140px; padding-top: 16px; }
        .trend-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 4px; }
        .trend-bar { width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
        .trend-label { font-size: 10px; color: #94a3b8; }
        .trend-value { font-size: 10px; color: #64748b; white-space: nowrap; }
        .conversion-stat { font-size: 32px; font-weight: 700; color: var(--navy); }
        .conversion-sub { font-size: 13px; color: #64748b; margin-top: 4px; }
      </style>
    </head>
    <body>
      <header>
        <h1>${brandMark({ dark: true, size: "small" })}<span class="sep">— Live Dashboard${businessName ? " &middot; " + businessName : ""}</span> <a href="/customers?key=${key}${sellerId ? "&sellerId=" + encodeURIComponent(sellerId) : ""}">plain table view</a>${key ? ` &nbsp; <a href="/admin?key=${key}">all sellers →</a>` : ""}</h1>
        <nav class="tabs">
          <button id="tabConversations" class="active-tab" onclick="switchTab('conversations')">Conversations</button>
          ${
            isBookable
              ? `<button id="tabServices" onclick="switchTab('services')">Services</button>
          <button id="tabBookings" onclick="switchTab('bookings')">Bookings</button>`
              : `<button id="tabCatalog" onclick="switchTab('catalog')">Catalog</button>`
          }
          <button id="tabAnalytics" onclick="switchTab('analytics')">Analytics</button>
        </nav>
        <div class="stats" id="stats"></div>
      </header>
      <div class="layout" id="conversationsView">
        <div class="list-pane">
          <div class="search-box"><input id="searchBox" placeholder="Search by phone or escalation reason..." oninput="applyFilter()"></div>
          <div class="list" id="list"><div class="empty">Loading…</div></div>
        </div>
        <div class="main" id="main"><div class="empty">Select a conversation on the left</div></div>
      </div>
      <div class="catalog-view" id="catalogView" style="display:none;">
        <div class="catalog-card">
          <h2>Products</h2>
          <table class="catalog-table" id="catalogTable">
            <thead><tr><th></th><th>Name</th><th>Key</th><th>Price</th><th></th></tr></thead>
            <tbody id="catalogTableBody"></tbody>
          </table>
          <div class="catalog-form">
            <div>
              <label>Key (edit uses existing key)</label>
              <input id="pKey" placeholder="e.g. tee">
            </div>
            <div>
              <label>Name</label>
              <input id="pName" placeholder="e.g. Plain white tee">
            </div>
            <div>
              <label>Price (N)</label>
              <input id="pPrice" type="number" min="1" placeholder="7500">
            </div>
            <button class="catalog-btn" onclick="saveProduct()">Save product</button>
          </div>
          <div class="catalog-form" style="grid-template-columns: 1fr; margin-top:10px;">
            <div>
              <label>Description (materials, sizes, colors — anything Amara should know to answer questions accurately)</label>
              <textarea id="pDescription" rows="2" placeholder="e.g. 100% cotton, true to size, available in S–XL, machine washable"></textarea>
            </div>
          </div>
          <div class="catalog-form" style="grid-template-columns: 1fr 1fr; margin-top:10px;">
            <div>
              <label>Upload a photo (max 1.5MB)</label>
              <input id="pPhotoFile" type="file" accept="image/*">
            </div>
            <div>
              <label>...or paste a photo URL instead</label>
              <input id="pImageUrl" placeholder="https://...">
            </div>
          </div>
          <div class="catalog-msg" id="catalogMsg"></div>
        </div>
        <div class="catalog-card">
          <h2>Delivery fees</h2>
          <div style="font-size:12px;color:#64748b;margin-bottom:12px;">
            Add the Nigerian states you actually deliver to, each with its own fee. Customers
            outside those states can still be covered by a fallback fee below, or left
            unavailable if you're not ready to ship there yet.
          </div>
          <table class="catalog-table" style="margin-bottom:14px;">
            <thead><tr><th>State</th><th>Fee (N)</th><th></th></tr></thead>
            <tbody id="deliveryStatesTableBody"></tbody>
          </table>
          <div class="fees-row">
            <div>
              <label>Add a state</label>
              <select id="stateSelect"></select>
            </div>
            <div>
              <label>Fee (N)</label>
              <input id="stateFee" type="number" min="0" placeholder="2000">
            </div>
            <button class="catalog-btn" onclick="addDeliveryState()">Add state</button>
          </div>
          <div class="catalog-msg" id="stateMsg"></div>
          <div class="fees-row" style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:14px;">
            <div>
              <label>Fallback fee for any other state (N)</label>
              <input id="feeDefault" type="number" min="0" placeholder="Leave blank = don't deliver there yet">
            </div>
            <button class="catalog-btn" onclick="saveDeliveryDefaultFee()">Save fallback fee</button>
          </div>
          <div class="catalog-msg" id="feesMsg"></div>
        </div>
        <div class="catalog-card">
          <h2>Bank transfer details</h2>
          <div style="font-size:12px;color:#64748b;margin-bottom:10px;">Offered to a customer only if they specifically ask to pay by bank transfer instead of the payment link.</div>
          <div class="fees-row">
            <div>
              <label>Bank name</label>
              <input id="bankName" placeholder="e.g. GTBank">
            </div>
            <div>
              <label>Account number</label>
              <input id="bankAccountNumber" placeholder="0123456789">
            </div>
            <div>
              <label>Account name</label>
              <input id="bankAccountName" placeholder="e.g. KP Collections">
            </div>
            <button class="catalog-btn" onclick="saveBankDetails()">Save</button>
          </div>
          <div class="catalog-msg" id="bankMsg"></div>

          <div id="bank2Toggle" style="margin-top:14px;">
            <button class="catalog-btn small" style="background:transparent;color:#4f46e5;padding:4px 0;" onclick="showBank2Form()">+ Add a second account</button>
          </div>
          <div id="bank2Form" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9;">
            <div style="font-size:12px;color:#64748b;margin-bottom:10px;">A second option, in case a customer's bank can't send to the first account. Amara only mentions this one if asked for an alternative.</div>
            <div class="fees-row">
              <div>
                <label>Bank name</label>
                <input id="bank2Name" placeholder="e.g. Kuda">
              </div>
              <div>
                <label>Account number</label>
                <input id="bank2AccountNumber" placeholder="0123456789">
              </div>
              <div>
                <label>Account name</label>
                <input id="bank2AccountName" placeholder="e.g. KP Collections">
              </div>
              <button class="catalog-btn" onclick="saveBankDetails2()">Save</button>
            </div>
            <button class="catalog-btn small" style="background:transparent;color:#dc2626;padding:4px 0;margin-top:6px;" onclick="removeBankDetails2()">Remove second account</button>
            <div class="catalog-msg" id="bank2Msg"></div>
          </div>
        </div>
      </div>
      <div class="catalog-view" id="servicesView" style="display:none;">
        <div class="catalog-card">
          <h2>Services</h2>
          <table class="catalog-table" id="offeringsTable">
            <thead><tr><th>Name</th><th>Key</th><th>Price</th><th>Duration</th><th></th></tr></thead>
            <tbody id="offeringsTableBody"></tbody>
          </table>
          <div class="catalog-form">
            <div>
              <label>Key</label>
              <input id="oKey" placeholder="e.g. strategycall">
            </div>
            <div>
              <label>Name</label>
              <input id="oName" placeholder="e.g. Strategy Call (30 min)">
            </div>
            <div>
              <label>Price (N)</label>
              <input id="oPrice" type="number" min="1" placeholder="15000">
            </div>
            <button class="catalog-btn" onclick="saveOffering()">Save service</button>
          </div>
          <div class="catalog-form" style="grid-template-columns: 1fr 1fr; margin-top:10px;">
            <div>
              <label>Duration (minutes)</label>
              <input id="oDuration" type="number" min="1" max="480" placeholder="30">
            </div>
            <div>
              <label>Description (what's included, anything Amara should know)</label>
              <input id="oDescription" placeholder="e.g. A focused 30-minute strategy session">
            </div>
          </div>
          <div class="catalog-msg" id="offeringsMsg"></div>
        </div>
        <div class="catalog-card">
          <h2>Weekly availability</h2>
          <div style="font-size:12px;color:#64748b;margin-bottom:12px;">
            Set the days and hours you're generally open. This stays live with no daily
            upkeep -- add a blocked date below only when something specific comes up.
          </div>
          <table class="catalog-table" style="margin-bottom:14px;">
            <thead><tr><th>Day</th><th>Hours</th><th></th></tr></thead>
            <tbody id="availabilityTableBody"></tbody>
          </table>
          <div class="fees-row">
            <div>
              <label>Day</label>
              <select id="windowDay">
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
              </select>
            </div>
            <div>
              <label>Start time</label>
              <input id="windowStart" type="time" value="09:00">
            </div>
            <div>
              <label>End time</label>
              <input id="windowEnd" type="time" value="17:00">
            </div>
            <button class="catalog-btn" onclick="addAvailabilityWindow()">Add window</button>
          </div>
          <div class="catalog-msg" id="availabilityMsg"></div>
          <div style="margin-top:16px;border-top:1px solid #e2e8f0;padding-top:14px;">
            <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Block a specific date (holiday, personal day) without touching the weekly schedule.</div>
            <table class="catalog-table" style="margin-bottom:14px;">
              <thead><tr><th>Blocked date</th><th></th></tr></thead>
              <tbody id="blockedDatesTableBody"></tbody>
            </table>
            <div class="fees-row">
              <div>
                <label>Date to block</label>
                <input id="blockDate" type="date">
              </div>
              <button class="catalog-btn" onclick="addBlockedDate()">Block date</button>
            </div>
            <div class="catalog-msg" id="blockedDatesMsg"></div>
          </div>
        </div>
      </div>
      <div class="catalog-view" id="bookingsView" style="display:none;">
        <div class="catalog-card">
          <h2>Upcoming bookings</h2>
          <table class="catalog-table" id="bookingsTable">
            <thead><tr><th>Date</th><th>Time</th><th>Service</th><th>Customer</th><th>Reference</th><th></th></tr></thead>
            <tbody id="bookingsTableBody"></tbody>
          </table>
        </div>
      </div>
      <div class="catalog-view" id="analyticsView" style="display:none;">
        <div class="catalog-card">
          <h2>Revenue — last 14 days</h2>
          <div class="trend-chart" id="trendChart"></div>
        </div>
        <div class="catalog-card">
          <h2>Best sellers</h2>
          <table class="catalog-table">
            <thead><tr><th>Product</th><th>Units sold</th><th>Revenue</th></tr></thead>
            <tbody id="bestSellersBody"></tbody>
          </table>
        </div>
        <div class="catalog-card">
          <h2>Chat &rarr; order conversion</h2>
          <div class="conversion-stat" id="conversionStat">&mdash;</div>
          <div class="conversion-sub" id="conversionSub"></div>
        </div>
      </div>
      <script>
        const KEY = ${JSON.stringify(key)};
        const SELLER_ID = ${JSON.stringify(sellerId || "")};
        // Every fetch call below authenticates with this same query string
        // -- the admin key, plus which seller to act as when it's not the
        // default (seller1). Built once here so every call site stays in
        // sync automatically.
        const ADMIN_QS = "key=" + encodeURIComponent(KEY) + (SELLER_ID ? "&sellerId=" + encodeURIComponent(SELLER_ID) : "");
        let selectedPhone = null;
        let customersCache = [];
        // Tracks which phone's full thread panel (header/compose/notes) is
        // currently built in the DOM, so the 5s background poll only ever
        // touches the message bubbles + takeover button on repeat loads of
        // the SAME conversation, and never rebuilds (and so never wipes)
        // whatever the owner is mid-typing into the compose or notes box.
        let renderedThreadPhone = null;

        function escapeHtml(str) {
          return String(str || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
        }

        async function loadDashboard() {
          try {
            const res = await fetch("/api/dashboard-data?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            customersCache = data.customers;
            renderStats(data.stats);
            renderList(getFilteredCustomers());
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

        function getFilteredCustomers() {
          const q = (document.getElementById("searchBox").value || "").trim().toLowerCase();
          if (!q) return customersCache;
          return customersCache.filter((c) =>
            (c.phone || "").toLowerCase().indexOf(q) !== -1 ||
            (c.last_escalation_reason || "").toLowerCase().indexOf(q) !== -1
          );
        }

        function applyFilter() {
          renderList(getFilteredCustomers());
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
          if (isClick) renderList(getFilteredCustomers()); // re-highlight the selected row immediately
          try {
            const res = await fetch("/api/conversation?phone=" + encodeURIComponent(phone) + "&" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            // Only rebuild the whole panel (header/compose/notes) when this
            // is a real switch to a conversation — an explicit click, or the
            // first load of it. A background poll on the SAME conversation
            // just refreshes the messages + button, so it never wipes text
            // the owner is actively typing into the compose or notes box.
            if (isClick || phone !== renderedThreadPhone) {
              renderThread(phone, data.history, data.customer);
              renderedThreadPhone = phone;
            } else {
              updateThreadMessages(data.history, data.customer);
            }
          } catch (err) {
            console.error("conversation load failed", err);
          }
        }

        function updateThreadMessages(history, customer) {
          const threadEl = document.getElementById("thread");
          if (!threadEl) return; // panel isn't built yet, nothing to update
          const nearBottom = threadEl.scrollTop + threadEl.clientHeight >= threadEl.scrollHeight - 20;
          threadEl.innerHTML = (history && history.length > 0)
            ? history.map((m) => '<div class="bubble ' + (m.role === "user" ? "user" : "assistant") + '">' + escapeHtml(m.content) + '</div>').join("")
            : '<div class="empty">No messages yet.</div>';
          if (nearBottom) threadEl.scrollTop = threadEl.scrollHeight;

          // Keep the Take over / Hand back button in sync too (e.g. if the
          // owner paused/resumed from elsewhere), without touching the
          // compose or notes box at all.
          const isPaused = customer && customer.paused === "yes";
          const btn = document.querySelector(".takeover-btn");
          if (btn) {
            btn.className = "takeover-btn " + (isPaused ? "hand" : "take");
            btn.textContent = isPaused ? "Hand back to Amara" : "Take over";
            btn.onclick = function () { toggleTakeover(selectedPhone, isPaused); };
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
            '<div class="thread" id="thread"></div>' +
            '<div class="msg-compose">' +
              '<input id="composeInput" placeholder="Type a message to send directly to this customer..." onkeydown="if(event.key===\\'Enter\\') sendManualMessage(\\'' + phone + '\\')">' +
              '<button class="catalog-btn small" onclick="sendManualMessage(\\'' + phone + '\\')">Send</button>' +
            '</div>' +
            '<div class="notes-box">' +
              '<label>Notes (only visible to you, never sent to the customer or Amara)</label>' +
              '<textarea id="notesInput">' + escapeHtml((customer && customer.note) || "") + '</textarea><br>' +
              '<button class="catalog-btn small" onclick="saveNote(\\'' + phone + '\\')" style="margin-top:6px;">Save note</button> ' +
              '<span class="catalog-msg" id="noteMsg"></span>' +
            '</div>';
          const threadEl = document.getElementById("thread");
          threadEl.innerHTML = (history && history.length > 0)
            ? history.map((m) => '<div class="bubble ' + (m.role === "user" ? "user" : "assistant") + '">' + escapeHtml(m.content) + '</div>').join("")
            : '<div class="empty">No messages yet.</div>';
          threadEl.scrollTop = threadEl.scrollHeight;
        }

        async function sendManualMessage(phone) {
          const input = document.getElementById("composeInput");
          const text = input.value.trim();
          if (!text) return;
          input.disabled = true;
          try {
            const res = await fetch("/api/send-message?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phone: phone, message: text }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              alert(data.error || "Could not send message.");
              input.disabled = false;
              return;
            }
            input.value = "";
            input.disabled = false;
            loadDashboard();
            loadConversation(phone, false);
          } catch (err) {
            alert("Network error, please try again.");
            input.disabled = false;
          }
        }

        async function saveNote(phone) {
          const note = document.getElementById("notesInput").value;
          const msg = document.getElementById("noteMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          try {
            const res = await fetch("/api/note?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phone: phone, note: note }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save note.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = "Saved.";
            msg.className = "catalog-msg ok";
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function toggleTakeover(phone, isPaused) {
          const endpoint = isPaused ? "/api/handback" : "/api/takeover";
          try {
            await fetch(endpoint + "?" + ADMIN_QS, {
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

        function switchTab(tab) {
          // Not every element below exists on every seller's dashboard --
          // a goods seller never gets tabServices/tabBookings, a bookable
          // seller never gets tabCatalog. Guarded with optional chaining
          // so this one function works for either businessType without
          // needing its own fork.
          const views = { conversations: "conversationsView", catalog: "catalogView", services: "servicesView", bookings: "bookingsView", analytics: "analyticsView" };
          for (const t in views) {
            const el = document.getElementById(views[t]);
            if (el) el.style.display = t === tab ? (t === "conversations" ? "flex" : "block") : "none";
          }
          const tabs = { conversations: "tabConversations", catalog: "tabCatalog", services: "tabServices", bookings: "tabBookings", analytics: "tabAnalytics" };
          for (const t in tabs) {
            const el = document.getElementById(tabs[t]);
            if (el) el.className = t === tab ? "active-tab" : "";
          }
          if (tab === "catalog") loadCatalog();
          if (tab === "services" || tab === "bookings") loadBookable();
          if (tab === "analytics") loadAnalytics();
        }

        async function loadAnalytics() {
          try {
            const res = await fetch("/api/analytics?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            renderAnalytics(data);
          } catch (err) {
            console.error("analytics load failed", err);
          }
        }

        function renderAnalytics(data) {
          const maxRevenue = Math.max(1, ...data.trend.map((d) => d.revenue));
          const chart = document.getElementById("trendChart");
          chart.innerHTML = data.trend.map((d) => {
            const heightPct = Math.max(Math.round((d.revenue / maxRevenue) * 100), d.revenue > 0 ? 4 : 1);
            const dayLabel = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2);
            const valueLabel = d.revenue > 0 ? (d.revenue >= 1000 ? "N" + Math.round(d.revenue / 1000) + "k" : "N" + d.revenue) : "";
            const tooltip = d.date + ": N" + d.revenue.toLocaleString() + " (" + d.orders + " order" + (d.orders === 1 ? "" : "s") + ")";
            return '<div class="trend-bar-wrap" title="' + escapeHtml(tooltip) + '">' +
              '<div class="trend-value">' + valueLabel + '</div>' +
              '<div class="trend-bar" style="height:' + heightPct + '%;"></div>' +
              '<div class="trend-label">' + dayLabel + '</div>' +
            '</div>';
          }).join("");

          const body = document.getElementById("bestSellersBody");
          body.innerHTML = data.bestSellers.length > 0
            ? data.bestSellers.map((p) =>
                '<tr><td>' + escapeHtml(p.name) + '</td><td>' + p.sold + '</td><td>N' + p.revenue.toLocaleString() + '</td></tr>'
              ).join("")
            : '<tr><td colspan="3" style="color:#94a3b8;">No sales yet.</td></tr>';

          document.getElementById("conversionStat").textContent = data.conversion.conversionPct + "%";
          document.getElementById("conversionSub").textContent =
            data.conversion.paidCustomers + " of " + data.conversion.totalCustomers + " conversation" +
            (data.conversion.totalCustomers === 1 ? "" : "s") + " turned into a paid order";
        }

        async function loadCatalog() {
          try {
            const res = await fetch("/api/catalog?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            window.nigeriaStates = data.nigeriaStates || [];
            populateStateSelect();
            renderCatalog(data.products, data.deliveryStates, data.deliveryDefaultFee, data.bankDetails, data.bankDetails2);
          } catch (err) {
            console.error("catalog load failed", err);
          }
        }

        function populateStateSelect() {
          const select = document.getElementById("stateSelect");
          if (!select || select.options.length > 0) return;
          select.innerHTML = (window.nigeriaStates || [])
            .map((s) => '<option value="' + escapeHtml(s.slug) + '">' + escapeHtml(s.name) + '</option>')
            .join("");
        }

        function renderCatalog(products, deliveryStates, deliveryDefaultFee, bankDetails, bankDetails2) {
          const body = document.getElementById("catalogTableBody");
          const keys = Object.keys(products);
          body.innerHTML = keys.length > 0
            ? keys.map((k) => {
                const p = products[k];
                const descLine = p.description
                  ? '<div style="font-size:11px;color:#94a3b8;margin-top:2px;max-width:280px;">' + escapeHtml(p.description) + '</div>'
                  : "";
                return '<tr>' +
                  '<td><img src="' + escapeHtml(p.imageUrl) + '" alt=""></td>' +
                  '<td>' + escapeHtml(p.name) + descLine + '</td>' +
                  '<td><code>' + escapeHtml(k) + '</code></td>' +
                  '<td>N' + Number(p.price).toLocaleString() + '</td>' +
                  '<td>' +
                    '<button class="catalog-btn small" onclick="editProduct(\\'' + k + '\\')">Edit</button> ' +
                    '<button class="catalog-btn danger" onclick="deleteProduct(\\'' + k + '\\')">Remove</button>' +
                  '</td>' +
                '</tr>';
              }).join("")
            : '<tr><td colspan="5" style="color:#94a3b8;">No products yet.</td></tr>';
          window.catalogCache = products;
          window.deliveryStatesCache = deliveryStates || {};

          renderDeliveryStates(window.deliveryStatesCache);
          document.getElementById("feeDefault").value =
            deliveryDefaultFee === null || deliveryDefaultFee === undefined ? "" : deliveryDefaultFee;

          if (bankDetails) {
            document.getElementById("bankName").value = bankDetails.bankName || "";
            document.getElementById("bankAccountNumber").value = bankDetails.accountNumber || "";
            document.getElementById("bankAccountName").value = bankDetails.accountName || "";
          }

          if (bankDetails2 && bankDetails2.bankName) {
            document.getElementById("bank2Name").value = bankDetails2.bankName || "";
            document.getElementById("bank2AccountNumber").value = bankDetails2.accountNumber || "";
            document.getElementById("bank2AccountName").value = bankDetails2.accountName || "";
            document.getElementById("bank2Toggle").style.display = "none";
            document.getElementById("bank2Form").style.display = "block";
          } else {
            document.getElementById("bank2Name").value = "";
            document.getElementById("bank2AccountNumber").value = "";
            document.getElementById("bank2AccountName").value = "";
            document.getElementById("bank2Toggle").style.display = "block";
            document.getElementById("bank2Form").style.display = "none";
          }
        }

        function showBank2Form() {
          document.getElementById("bank2Toggle").style.display = "none";
          document.getElementById("bank2Form").style.display = "block";
        }

        async function saveBankDetails2() {
          const msg = document.getElementById("bank2Msg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const body = {
            bankName: document.getElementById("bank2Name").value,
            accountNumber: document.getElementById("bank2AccountNumber").value,
            accountName: document.getElementById("bank2AccountName").value,
          };
          try {
            const res = await fetch("/api/catalog/bank-details-2?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save the second account.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function removeBankDetails2() {
          if (!confirm("Remove the second bank account? Amara will only offer the first one going forward.")) return;
          const msg = document.getElementById("bank2Msg");
          try {
            const res = await fetch("/api/catalog/bank-details-2?" + ADMIN_QS, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not remove the second account.";
              msg.className = "catalog-msg error";
              return;
            }
            document.getElementById("bank2Name").value = "";
            document.getElementById("bank2AccountNumber").value = "";
            document.getElementById("bank2AccountName").value = "";
            document.getElementById("bank2Form").style.display = "none";
            document.getElementById("bank2Toggle").style.display = "block";
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        function editProduct(key) {
          const p = (window.catalogCache || {})[key];
          if (!p) return;
          document.getElementById("pKey").value = key;
          document.getElementById("pName").value = p.name;
          document.getElementById("pPrice").value = p.price;
          document.getElementById("pDescription").value = p.description || "";
          // Only pre-fill the URL box for a real pasted link, never for our
          // own placeholder or an already-uploaded photo (that one has no
          // URL to show -- the file input can't be pre-filled by the
          // browser anyway, so leaving both blank just means "keep the
          // current photo unless you choose a new one").
          document.getElementById("pImageUrl").value =
            (p.imageUrl && p.imageUrl.indexOf("/images/") === -1 && p.imageUrl.indexOf("/catalog-photo/") === -1) ? p.imageUrl : "";
          document.getElementById("pPhotoFile").value = "";
          document.getElementById("pKey").focus();
        }

        async function saveProduct() {
          const msg = document.getElementById("catalogMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";

          const keyValue = document.getElementById("pKey").value.trim().toLowerCase();
          const photoFile = document.getElementById("pPhotoFile").files[0];
          const imageUrlValue = document.getElementById("pImageUrl").value.trim();
          const existing = (window.catalogCache || {})[keyValue];

          // Safety net: editing an EXISTING product's photo goes live to real
          // customers on WhatsApp the instant you hit Save -- there's no
          // staging environment to catch a wrong file or a leftover key
          // first. A brand new product has no live photo yet, so it needs
          // no extra confirmation; only replacing one that's already live
          // does.
          if (existing && (photoFile || imageUrlValue)) {
            const confirmed = confirm(
              'Replace the LIVE photo for "' + existing.name + '" (N' + Number(existing.price).toLocaleString() + ')? ' +
              "Customers messaging Amara on WhatsApp right now may already be seeing the current photo, and this takes effect immediately."
            );
            if (!confirmed) return;
          }

          // FormData (not JSON) here, since a photo file might be attached
          // -- the browser sets the multipart boundary itself, so no
          // Content-Type header is set manually below.
          const formData = new FormData();
          formData.append("key", document.getElementById("pKey").value);
          formData.append("name", document.getElementById("pName").value);
          formData.append("price", document.getElementById("pPrice").value);
          formData.append("description", document.getElementById("pDescription").value);
          formData.append("imageUrl", document.getElementById("pImageUrl").value);
          if (photoFile) formData.append("photo", photoFile);
          try {
            const res = await fetch("/api/catalog/product?" + ADMIN_QS, {
              method: "POST",
              body: formData,
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save product.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            document.getElementById("pKey").value = "";
            document.getElementById("pName").value = "";
            document.getElementById("pPrice").value = "";
            document.getElementById("pDescription").value = "";
            document.getElementById("pImageUrl").value = "";
            document.getElementById("pPhotoFile").value = "";
            loadCatalog();
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function deleteProduct(key) {
          if (!confirm('Remove "' + key + '" from the catalog? Amara will no longer be able to sell it.')) return;
          try {
            const res = await fetch("/api/catalog/product/" + encodeURIComponent(key) + "?" + ADMIN_QS, {
              method: "DELETE",
            });
            const data = await res.json();
            if (data && data.warning) {
              const msg = document.getElementById("catalogMsg");
              msg.textContent = data.warning;
              msg.className = "catalog-msg error";
            }
            loadCatalog();
          } catch (err) {
            console.error("delete product failed", err);
          }
        }

        function renderDeliveryStates(deliveryStates) {
          const body = document.getElementById("deliveryStatesTableBody");
          const slugs = Object.keys(deliveryStates || {});
          const nameFor = (slug) => {
            const found = (window.nigeriaStates || []).find((s) => s.slug === slug);
            return found ? found.name : slug;
          };
          body.innerHTML = slugs.length > 0
            ? slugs
                .sort((a, b) => nameFor(a).localeCompare(nameFor(b)))
                .map((slug) =>
                  '<tr>' +
                    '<td>' + escapeHtml(nameFor(slug)) + '</td>' +
                    '<td>N' + Number(deliveryStates[slug]).toLocaleString() + '</td>' +
                    '<td><button class="catalog-btn danger" onclick="removeDeliveryState(\\'' + slug + '\\')">Remove</button></td>' +
                  '</tr>'
                ).join("")
            : '<tr><td colspan="3" style="color:#94a3b8;">No states added yet -- Amara won\\'t quote delivery to any state until you add at least one, or set a fallback fee below.</td></tr>';
        }

        async function addDeliveryState() {
          const msg = document.getElementById("stateMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const slug = document.getElementById("stateSelect").value;
          const fee = document.getElementById("stateFee").value;
          if (!slug) {
            msg.textContent = "Pick a state first.";
            msg.className = "catalog-msg error";
            return;
          }
          try {
            const res = await fetch("/api/catalog/delivery-states?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slug, fee }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not add that state.";
              msg.className = "catalog-msg error";
              return;
            }
            document.getElementById("stateFee").value = "";
            msg.textContent = data.warning || "Added.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadCatalog();
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function removeDeliveryState(slug) {
          const name = ((window.nigeriaStates || []).find((s) => s.slug === slug) || {}).name || slug;
          if (!confirm('Stop delivering to ' + name + '? Amara will no longer be able to quote or charge for it, unless a fallback fee covers it.')) return;
          try {
            await fetch("/api/catalog/delivery-states/" + encodeURIComponent(slug) + "?" + ADMIN_QS, {
              method: "DELETE",
            });
            loadCatalog();
          } catch (err) {
            console.error("remove delivery state failed", err);
          }
        }

        async function saveDeliveryDefaultFee() {
          const msg = document.getElementById("feesMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const raw = document.getElementById("feeDefault").value;
          const body = { fee: raw === "" ? null : raw };
          try {
            const res = await fetch("/api/catalog/delivery-default-fee?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save the fallback fee.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function saveBankDetails() {
          const msg = document.getElementById("bankMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const body = {
            bankName: document.getElementById("bankName").value,
            accountNumber: document.getElementById("bankAccountNumber").value,
            accountName: document.getElementById("bankAccountName").value,
          };
          try {
            const res = await fetch("/api/catalog/bank-details?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save bank details.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        // ---------- Bookable sellers: Services + Bookings tabs ----------
        const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

        async function loadBookable() {
          try {
            const res = await fetch("/api/bookable?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            window.offeringsCache = data.offerings || {};
            renderOfferings(data.offerings || {});
            renderAvailability(data.weeklyAvailability || []);
            renderBlockedDates(data.blockedDates || []);
            renderBookings(data.bookings || []);
          } catch (err) {
            console.error("bookable load failed", err);
          }
        }

        function renderOfferings(offerings) {
          const body = document.getElementById("offeringsTableBody");
          const keys = Object.keys(offerings);
          body.innerHTML = keys.length > 0
            ? keys.map((k) => {
                const o = offerings[k];
                return '<tr>' +
                  '<td>' + escapeHtml(o.name) + '</td>' +
                  '<td><code>' + escapeHtml(k) + '</code></td>' +
                  '<td>N' + Number(o.price).toLocaleString() + '</td>' +
                  '<td>' + o.durationMinutes + ' min</td>' +
                  '<td><button class="catalog-btn danger" onclick="removeOffering(\\'' + k + '\\')">Remove</button></td>' +
                '</tr>';
              }).join("")
            : '<tr><td colspan="5" style="color:#94a3b8;">No services yet.</td></tr>';
        }

        async function saveOffering() {
          const msg = document.getElementById("offeringsMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const body = {
            key: document.getElementById("oKey").value,
            name: document.getElementById("oName").value,
            price: document.getElementById("oPrice").value,
            durationMinutes: document.getElementById("oDuration").value,
            description: document.getElementById("oDescription").value,
          };
          try {
            const res = await fetch("/api/bookable/offerings?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not save service.";
              msg.className = "catalog-msg error";
              return;
            }
            document.getElementById("oKey").value = "";
            document.getElementById("oName").value = "";
            document.getElementById("oPrice").value = "";
            document.getElementById("oDuration").value = "";
            document.getElementById("oDescription").value = "";
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadBookable();
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function removeOffering(key) {
          if (!confirm('Remove "' + key + '" from your services? Amara will no longer be able to book it.')) return;
          try {
            await fetch("/api/bookable/offerings/" + encodeURIComponent(key) + "?" + ADMIN_QS, { method: "DELETE" });
            loadBookable();
          } catch (err) {
            console.error("remove offering failed", err);
          }
        }

        function renderAvailability(windows) {
          const body = document.getElementById("availabilityTableBody");
          body.innerHTML = windows.length > 0
            ? windows
                .slice()
                .sort((a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime))
                .map((w) =>
                  '<tr>' +
                    '<td>' + DAY_LABELS[w.day] + '</td>' +
                    '<td>' + w.startTime + '-' + w.endTime + '</td>' +
                    '<td><button class="catalog-btn danger" onclick="removeAvailabilityWindow(\\'' + w.id + '\\')">Remove</button></td>' +
                  '</tr>'
                ).join("")
            : '<tr><td colspan="3" style="color:#94a3b8;">No weekly availability set yet.</td></tr>';
        }

        async function addAvailabilityWindow() {
          const msg = document.getElementById("availabilityMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const body = {
            day: document.getElementById("windowDay").value,
            startTime: document.getElementById("windowStart").value,
            endTime: document.getElementById("windowEnd").value,
          };
          try {
            const res = await fetch("/api/bookable/availability-windows?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not add that window.";
              msg.className = "catalog-msg error";
              return;
            }
            msg.textContent = data.warning || "Added.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadBookable();
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function removeAvailabilityWindow(id) {
          try {
            await fetch("/api/bookable/availability-windows/" + encodeURIComponent(id) + "?" + ADMIN_QS, { method: "DELETE" });
            loadBookable();
          } catch (err) {
            console.error("remove availability window failed", err);
          }
        }

        function renderBlockedDates(dates) {
          const body = document.getElementById("blockedDatesTableBody");
          body.innerHTML = dates.length > 0
            ? dates
                .slice()
                .sort()
                .map((d) =>
                  '<tr><td>' + d + '</td><td><button class="catalog-btn danger" onclick="removeBlockedDate(\\'' + d + '\\')">Unblock</button></td></tr>'
                ).join("")
            : '<tr><td colspan="2" style="color:#94a3b8;">No blocked dates.</td></tr>';
        }

        async function addBlockedDate() {
          const msg = document.getElementById("blockedDatesMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const date = document.getElementById("blockDate").value;
          if (!date) {
            msg.textContent = "Pick a date first.";
            msg.className = "catalog-msg error";
            return;
          }
          try {
            const res = await fetch("/api/bookable/blocked-dates?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ date }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              msg.textContent = data.error || "Could not block that date.";
              msg.className = "catalog-msg error";
              return;
            }
            document.getElementById("blockDate").value = "";
            msg.textContent = data.warning || "Blocked.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadBookable();
          } catch (err) {
            msg.textContent = "Network error, please try again.";
            msg.className = "catalog-msg error";
          }
        }

        async function removeBlockedDate(date) {
          try {
            await fetch("/api/bookable/blocked-dates/" + encodeURIComponent(date) + "?" + ADMIN_QS, { method: "DELETE" });
            loadBookable();
          } catch (err) {
            console.error("remove blocked date failed", err);
          }
        }

        function renderBookings(bookings) {
          const body = document.getElementById("bookingsTableBody");
          const offerings = window.offeringsCache || {};
          body.innerHTML = bookings.length > 0
            ? bookings.map((b) => {
                const offering = offerings[b.offeringKey];
                const serviceName = offering ? offering.name : b.offeringKey;
                return '<tr>' +
                  '<td>' + b.date + '</td>' +
                  '<td>' + b.time + '</td>' +
                  '<td>' + escapeHtml(serviceName) + '</td>' +
                  '<td>' + escapeHtml(b.phone) + '</td>' +
                  '<td><code>' + escapeHtml(b.reference) + '</code></td>' +
                  '<td><button class="catalog-btn danger" onclick="cancelBooking(\\'' + b.id + '\\')">Cancel</button></td>' +
                '</tr>';
              }).join("")
            : '<tr><td colspan="6" style="color:#94a3b8;">No upcoming bookings.</td></tr>';
        }

        async function cancelBooking(id) {
          if (!confirm("Cancel this booking? The slot will open back up for other customers.")) return;
          try {
            await fetch("/api/bookable/bookings/" + encodeURIComponent(id) + "/cancel?" + ADMIN_QS, { method: "POST" });
            loadBookable();
          } catch (err) {
            console.error("cancel booking failed", err);
          }
        }

        loadDashboard();
        setInterval(loadDashboard, 5000); // simple polling stands in for realtime for now
      </script>
    </body>
    </html>
  `;
}

app.get("/dashboard", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL, or log in as a seller.");
  }
  res.send(dashboardHtml(req.query.key || "", req.query.sellerId || "", seller.businessName, seller.businessType));
});

app.get("/api/dashboard-data", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  try {
    const customers = await listAllCustomers(seller.sellerId);
    customers.sort((a, b) => new Date(b.last_contact || 0) - new Date(a.last_contact || 0));
    const stats = await getDashboardStats(customers);
    res.json({ stats, customers });
  } catch (err) {
    console.error("api/dashboard-data failed:", err.message);
    res.status(500).json({ error: "failed to load dashboard data" });
  }
});

app.get("/api/conversation", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    const history = await getConversation(seller.sellerId, phone);
    const customer = await getCustomer(seller.sellerId, phone);
    res.json({ history, customer });
  } catch (err) {
    console.error("api/conversation failed:", err.message);
    res.status(500).json({ error: "failed to load conversation" });
  }
});

app.post("/api/takeover", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.body?.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    // Same pauseCustomer() the owner already triggers via "pause last" on
    // WhatsApp — the dashboard button is just a second door into the
    // identical, already-tested mechanism, not a separate code path.
    await pauseCustomer(seller.sellerId, phone);
    console.log(`Dashboard takeover: owner took over ${phone} from the web dashboard.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/takeover failed:", err.message);
    res.status(500).json({ error: "failed to take over" });
  }
});

app.post("/api/handback", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.body?.phone;
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    await resumeCustomer(seller.sellerId, phone);

    // Same proactive, context-aware notification the customer already
    // gets when the owner resumes via WhatsApp text — the dashboard is
    // just a different door into the same handback, so the customer
    // experience should be identical either way, not a lesser version.
    const customerRecord = await getCustomer(seller.sellerId, phone);
    const followUp = await generateResumeFollowUp(
      seller,
      customerRecord?.last_escalation_reason,
      "Handled directly, resumed from the owner dashboard."
    );
    const notified = await sendWhatsApp(seller, phone, followUp);
    if (notified) {
      let history = await getConversation(seller.sellerId, phone);
      history.push({ role: "assistant", content: followUp });
      history = history.slice(-10);
      await saveConversation(seller.sellerId, phone, history);
    }
    console.log(`Dashboard handback: owner resumed ${phone} from the web dashboard.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/handback failed:", err.message);
    res.status(500).json({ error: "failed to hand back" });
  }
});

app.get("/api/analytics", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  try {
    const customers = await listAllCustomers(seller.sellerId);
    const summary = await getAnalyticsSummary(seller.sellerId, customers, seller.catalog);
    res.json(summary);
  } catch (err) {
    console.error("api/analytics failed:", err.message);
    res.status(500).json({ error: "failed to load analytics" });
  }
});

app.post("/api/send-message", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.body?.phone;
  const text = (req.body?.message || "").trim();
  if (!phone || !text) return res.status(400).json({ error: "missing phone or message" });
  try {
    // Sending a message directly from the dashboard means the owner is now
    // personally in this thread — auto-pause so Amara doesn't also reply
    // on top of the owner, same protection as clicking "Take over".
    await pauseCustomer(seller.sellerId, phone);
    const sent = await sendWhatsApp(seller, phone, text);
    if (!sent) return res.status(502).json({ error: "WhatsApp rejected the message, please try again" });
    let history = await getConversation(seller.sellerId, phone);
    history.push({ role: "assistant", content: text });
    history = history.slice(-10);
    await saveConversation(seller.sellerId, phone, history);
    console.log(`Dashboard manual message: owner messaged ${phone} directly from the dashboard.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/send-message failed:", err.message);
    res.status(500).json({ error: "failed to send message" });
  }
});

app.post("/api/note", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.body?.phone;
  const note = req.body?.note ?? "";
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    // Owner-only scratch space per customer — stored on the same customer
    // hash as everything else, never read by Amara's prompt or shown to
    // the customer, purely a memory aid for the owner.
    await upsertCustomer(seller.sellerId, phone, { note: String(note).slice(0, 2000) });
    res.json({ ok: true });
  } catch (err) {
    console.error("api/note failed:", err.message);
    res.status(500).json({ error: "failed to save note" });
  }
});

// ---------- CATALOG MANAGEMENT (Stage 4 dashboard, Catalog tab) ----------
// Add, edit and remove products, and change delivery fees, straight from
// the dashboard instead of needing a code change and a redeploy every
// time. Every edit here updates the SAME in-memory PRODUCT_PRICES /
// PRODUCT_NAMES / PRODUCT_IMAGES / DELIVERY_STATES objects that Amara's
// prompt, the payment hard-backstop, and the photo-sending code all
// already read from, so a saved change takes effect on the very next
// customer message, no restart needed, and is also persisted to Redis so
// it survives one.

app.get("/api/catalog", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const products = {};
  for (const key of Object.keys(seller.catalog.PRODUCT_PRICES)) {
    products[key] = {
      name: seller.catalog.PRODUCT_NAMES[key],
      price: seller.catalog.PRODUCT_PRICES[key],
      imageUrl: seller.catalog.PRODUCT_IMAGES[key],
      description: seller.catalog.PRODUCT_DESCRIPTIONS[key] || "",
    };
  }
  res.json({
    products,
    deliveryStates: seller.catalog.DELIVERY_STATES,
    deliveryDefaultFee: seller.catalog.DELIVERY_DEFAULT_FEE,
    nigeriaStates: NIGERIA_STATES,
    bankDetails: seller.catalog.BANK_DETAILS,
    bankDetails2: seller.catalog.BANK_DETAILS_2 && seller.catalog.BANK_DETAILS_2.bankName ? seller.catalog.BANK_DETAILS_2 : null,
  });
});

app.post("/api/catalog/bank-details", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const bankName = String(req.body?.bankName || "").trim();
  const accountNumber = String(req.body?.accountNumber || "").trim();
  const accountName = String(req.body?.accountName || "").trim();

  if (!bankName || !accountNumber || !accountName) {
    return res.status(400).json({ error: "Bank name, account number, and account name are all required." });
  }
  if (!/^\d{6,20}$/.test(accountNumber)) {
    return res.status(400).json({ error: "Account number should be digits only (6-20 of them)." });
  }

  // Same pattern as products/delivery fees: update the live value Amara's
  // prompt reads from first (so it's correct on the very next reply
  // regardless of what happens next), then persist to Redis.
  seller.catalog.BANK_DETAILS.bankName = bankName;
  seller.catalog.BANK_DETAILS.accountNumber = accountNumber;
  seller.catalog.BANK_DETAILS.accountName = accountName;
  console.log(`Catalog: bank details updated from the dashboard (${bankName}, ${accountName}) for ${seller.sellerId}.`);

  try {
    await saveBankDetailsToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/bank-details: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again.",
    });
  }
});

// ---------- Second bank account (optional) ----------
// Same shape and validation as the primary account above, just stored and
// offered as an alternative -- e.g. a different bank, in case a customer's
// bank can't send to the first one. Amara only ever mentions this one if
// it's actually been added (see buildShopProfile).
app.post("/api/catalog/bank-details-2", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const bankName = String(req.body?.bankName || "").trim();
  const accountNumber = String(req.body?.accountNumber || "").trim();
  const accountName = String(req.body?.accountName || "").trim();

  if (!bankName || !accountNumber || !accountName) {
    return res.status(400).json({ error: "Bank name, account number, and account name are all required." });
  }
  if (!/^\d{6,20}$/.test(accountNumber)) {
    return res.status(400).json({ error: "Account number should be digits only (6-20 of them)." });
  }

  seller.catalog.BANK_DETAILS_2.bankName = bankName;
  seller.catalog.BANK_DETAILS_2.accountNumber = accountNumber;
  seller.catalog.BANK_DETAILS_2.accountName = accountName;
  console.log(`Catalog: second bank account added/updated from the dashboard (${bankName}, ${accountName}) for ${seller.sellerId}.`);

  try {
    await saveBankDetails2ToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/bank-details-2: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again.",
    });
  }
});

app.delete("/api/catalog/bank-details-2", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  seller.catalog.BANK_DETAILS_2.bankName = "";
  seller.catalog.BANK_DETAILS_2.accountNumber = "";
  seller.catalog.BANK_DETAILS_2.accountName = "";
  console.log(`Catalog: second bank account removed from the dashboard for ${seller.sellerId}.`);
  try {
    await redisCommand(["DEL", nsKey(seller.sellerId, "shop:bank_details_2")]);
  } catch (err) {
    console.error("api/catalog/bank-details-2 delete: cleanup failed (non-fatal):", err.message);
  }
  res.json({ ok: true });
});

app.post("/api/catalog/product", (req, res, next) => {
  // multer's own errors (file too big, etc.) need to be turned into the
  // same JSON error shape the dashboard's fetch() already expects --
  // otherwise a rejected upload would hand it an HTML error page instead
  // and the "Could not save product" message would never show up.
  upload.single("photo")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Photo is too large (max 1.5MB) -- please use a smaller image."
          : "Could not process the uploaded photo.";
      return res.status(400).json({ error: message });
    }
    next();
  });
}, async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const { key, name, price, imageUrl, description } = req.body || {};

  // Same "code is the guarantee" rule as everywhere else money-adjacent
  // in this file: validate for real here, don't just trust whatever the
  // dashboard's own JS happened to send.
  const cleanKey = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanName = String(name || "").trim();
  const cleanPrice = Number(price);
  const cleanImageUrl = imageUrl ? String(imageUrl).trim() : "";
  const cleanDescription = String(description || "").trim().slice(0, 600);

  if (!cleanKey) {
    return res.status(400).json({ error: "Product key is required (letters, numbers, - and _ only)." });
  }
  if (!cleanName) {
    return res.status(400).json({ error: "Product name is required." });
  }
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) {
    return res.status(400).json({ error: "Price must be a positive number." });
  }
  if (cleanImageUrl && !/^https?:\/\//i.test(cleanImageUrl)) {
    return res.status(400).json({ error: "Image URL must start with http:// or https://" });
  }

  // Whether this key already existed BEFORE we touch anything below --
  // decides what happens to the photo when neither a new file nor a new
  // URL was submitted (see below).
  const isNewProduct = !(cleanKey in seller.catalog.PRODUCT_PRICES);

  // Update the live catalog first -- this alone is what Amara and the
  // payment backstop actually read from, so the change is already in
  // effect for the very next customer message regardless of what happens
  // next. Persisting to Redis is what makes it survive a restart; if that
  // one part fails (a transient Upstash hiccup), say so honestly rather
  // than silently, but don't report the whole save as failed when the
  // live behavior change already succeeded.
  seller.catalog.PRODUCT_NAMES[cleanKey] = cleanName;
  seller.catalog.PRODUCT_PRICES[cleanKey] = cleanPrice;
  seller.catalog.PRODUCT_DESCRIPTIONS[cleanKey] = cleanDescription;

  if (req.file) {
    // A real photo was uploaded: store it in Redis (base64) next to the
    // rest of this seller's catalog, cache it in memory for fast serving,
    // and point PRODUCT_IMAGES at our own /catalog-photo URL for it.
    const mime = req.file.mimetype;
    const base64 = req.file.buffer.toString("base64");
    sellerPhotoCache[`${seller.sellerId}:${cleanKey}`] = { mime, buffer: req.file.buffer };
    seller.catalog.PRODUCT_IMAGES[cleanKey] = `${BASE_URL}/catalog-photo/${seller.sellerId}/${cleanKey}`;
    try {
      await redisCommand(["SET", nsKey(seller.sellerId, `catalog:photo:${cleanKey}`), JSON.stringify({ mime, data: base64 })]);
    } catch (err) {
      console.error("catalog photo upload: failed to persist to Redis:", err.message);
      // The photo still works right now from the in-memory cache above;
      // it just won't survive a restart until saved again successfully.
    }
  } else if (cleanImageUrl) {
    seller.catalog.PRODUCT_IMAGES[cleanKey] = cleanImageUrl;
  } else if (isNewProduct) {
    seller.catalog.PRODUCT_IMAGES[cleanKey] = `${BASE_URL}/images/${cleanKey}.png`;
  }
  // else: editing an existing product with no new photo and no new URL --
  // leave its existing PRODUCT_IMAGES entry exactly as it is.

  console.log(`Catalog: product "${cleanKey}" saved (${cleanName}, N${cleanPrice}) from the dashboard for ${seller.sellerId}.`);

  try {
    await saveCatalogToRedis(seller.sellerId);
    res.json({ ok: true, key: cleanKey });
  } catch (err) {
    console.error("api/catalog/product: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      key: cleanKey,
      warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again.",
    });
  }
});

app.delete("/api/catalog/product/:key", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const key = req.params.key;
  if (!seller.catalog.PRODUCT_PRICES[key]) {
    return res.status(404).json({ error: "no such product" });
  }
  delete seller.catalog.PRODUCT_PRICES[key];
  delete seller.catalog.PRODUCT_NAMES[key];
  delete seller.catalog.PRODUCT_IMAGES[key];
  delete seller.catalog.PRODUCT_DESCRIPTIONS[key];
  delete sellerPhotoCache[`${seller.sellerId}:${key}`];
  redisCommand(["DEL", nsKey(seller.sellerId, `catalog:photo:${key}`)]).catch((err) =>
    console.error("catalog photo delete: cleanup failed (non-fatal):", err.message)
  );
  console.log(`Catalog: product "${key}" removed from the dashboard for ${seller.sellerId}.`);

  try {
    await saveCatalogToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/product delete: live removal succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Removed and live now, but couldn't persist to storage -- it may come back if the server restarts before you try again.",
    });
  }
});

// Nigeria-wide delivery: a seller adds one state at a time (with its own
// fee), removes one, or sets/clears the optional fallback fee for every
// other state. Same live-update-then-persist-to-Redis pattern, and the
// same money-matters validation discipline, as every other catalog route.

app.post("/api/catalog/delivery-states", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const fee = Number(req.body?.fee);
  if (!VALID_STATE_SLUGS.has(slug)) {
    return res.status(400).json({ error: "That's not a recognized Nigerian state." });
  }
  if (!Number.isFinite(fee) || fee < 0) {
    return res.status(400).json({ error: "Delivery fee must be a number, 0 or higher." });
  }
  seller.catalog.DELIVERY_STATES[slug] = fee;
  console.log(`Catalog: delivery fee for ${slug} set to ${fee} from the dashboard for ${seller.sellerId}.`);

  try {
    await saveDeliveryFeesToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/delivery-states: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again.",
    });
  }
});

app.delete("/api/catalog/delivery-states/:slug", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const slug = String(req.params.slug || "").trim().toLowerCase();
  delete seller.catalog.DELIVERY_STATES[slug];
  console.log(`Catalog: delivery to ${slug} removed from the dashboard for ${seller.sellerId}.`);

  try {
    await saveDeliveryFeesToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/delivery-states delete: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Removed and live now, but couldn't persist to storage -- it may come back if the server restarts before you try again.",
    });
  }
});

app.post("/api/catalog/delivery-default-fee", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const raw = req.body?.fee;
  if (raw === null || raw === undefined || raw === "") {
    seller.catalog.DELIVERY_DEFAULT_FEE = null;
  } else {
    const fee = Number(raw);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ error: "Fallback fee must be a number, 0 or higher (or left blank)." });
    }
    seller.catalog.DELIVERY_DEFAULT_FEE = fee;
  }
  console.log(`Catalog: fallback delivery fee set to ${seller.catalog.DELIVERY_DEFAULT_FEE} from the dashboard for ${seller.sellerId}.`);

  try {
    await saveDeliveryFeesToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/catalog/delivery-default-fee: live update succeeded but Redis persistence failed:", err.message);
    res.json({
      ok: true,
      warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again.",
    });
  }
});

// ---------- BOOKABLE SELLERS: DASHBOARD API ----------
// Mirrors the goods-seller catalog API one section up: same live-update-
// then-persist-to-Redis pattern, same "validate for real here, never
// trust the dashboard's own JS" discipline. Works for any seller
// (businessType isn't checked here), since these routes are meaningless
// clutter for a goods seller but harmless -- nothing calls them unless
// the dashboard's bookable-specific tabs are actually shown, which is
// gated on businessType elsewhere.

app.get("/api/bookable", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const upcomingBookings = seller.catalog.BOOKINGS.filter((b) => b.status !== "cancelled" && b.date >= todayStr)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json({
    offerings: seller.catalog.OFFERINGS,
    weeklyAvailability: seller.catalog.WEEKLY_AVAILABILITY,
    blockedDates: seller.catalog.BLOCKED_DATES,
    bookings: upcomingBookings,
  });
});

app.post("/api/bookable/offerings", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const { key, name, price, durationMinutes, description } = req.body || {};

  const cleanKey = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanName = String(name || "").trim();
  const cleanPrice = Number(price);
  const cleanDuration = Number(durationMinutes);
  const cleanDescription = String(description || "").trim().slice(0, 600);

  if (!cleanKey) {
    return res.status(400).json({ error: "Offering key is required (letters, numbers, - and _ only)." });
  }
  if (!cleanName) {
    return res.status(400).json({ error: "Offering name is required." });
  }
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) {
    return res.status(400).json({ error: "Price must be a positive number." });
  }
  if (!Number.isFinite(cleanDuration) || cleanDuration <= 0 || cleanDuration > 480) {
    return res.status(400).json({ error: "Duration must be a positive number of minutes (up to 480)." });
  }

  seller.catalog.OFFERINGS[cleanKey] = { name: cleanName, price: cleanPrice, durationMinutes: cleanDuration, description: cleanDescription };
  console.log(`Bookable: offering "${cleanKey}" saved from the dashboard for ${seller.sellerId}.`);

  try {
    await saveOfferingsToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/offerings: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again." });
  }
});

app.delete("/api/bookable/offerings/:key", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const key = String(req.params.key || "");
  delete seller.catalog.OFFERINGS[key];
  console.log(`Bookable: offering "${key}" removed from the dashboard for ${seller.sellerId}.`);

  try {
    await saveOfferingsToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/offerings delete: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Removed and live now, but couldn't persist to storage -- it may come back if the server restarts before you try again." });
  }
});

app.post("/api/bookable/availability-windows", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const day = Number(req.body?.day);
  const startTime = String(req.body?.startTime || "");
  const endTime = String(req.body?.endTime || "");
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return res.status(400).json({ error: "Pick a valid day of the week." });
  }
  if (!timeRe.test(startTime) || !timeRe.test(endTime)) {
    return res.status(400).json({ error: "Start and end time must be in HH:MM form." });
  }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ error: "Start time must be before end time." });
  }

  seller.catalog.WEEKLY_AVAILABILITY.push({ id: crypto.randomBytes(6).toString("hex"), day, startTime, endTime });
  console.log(`Bookable: availability window added (day ${day}, ${startTime}-${endTime}) from the dashboard for ${seller.sellerId}.`);

  try {
    await saveWeeklyAvailabilityToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/availability-windows: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again." });
  }
});

app.delete("/api/bookable/availability-windows/:id", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const id = String(req.params.id || "");
  seller.catalog.WEEKLY_AVAILABILITY = seller.catalog.WEEKLY_AVAILABILITY.filter((w) => w.id !== id);
  console.log(`Bookable: availability window ${id} removed from the dashboard for ${seller.sellerId}.`);

  try {
    await saveWeeklyAvailabilityToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/availability-windows delete: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Removed and live now, but couldn't persist to storage -- it may come back if the server restarts before you try again." });
  }
});

app.post("/api/bookable/blocked-dates", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const date = String(req.body?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Date must be in YYYY-MM-DD form." });
  }
  if (!seller.catalog.BLOCKED_DATES.includes(date)) seller.catalog.BLOCKED_DATES.push(date);
  console.log(`Bookable: blocked date ${date} added from the dashboard for ${seller.sellerId}.`);

  try {
    await saveBlockedDatesToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/blocked-dates: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Saved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try saving again." });
  }
});

app.delete("/api/bookable/blocked-dates/:date", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const date = String(req.params.date || "");
  seller.catalog.BLOCKED_DATES = seller.catalog.BLOCKED_DATES.filter((d) => d !== date);
  console.log(`Bookable: blocked date ${date} removed from the dashboard for ${seller.sellerId}.`);

  try {
    await saveBlockedDatesToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/blocked-dates delete: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Removed and live now, but couldn't persist to storage -- it may come back if the server restarts before you try again." });
  }
});

// Bare inspection endpoint for the availability engine -- no AI involved,
// just exercises getAvailableSlots directly. Useful on its own for
// verifying the engine is correct before it's ever wired into a real
// WhatsApp conversation, and also usable by the dashboard later if a
// seller ever wants to preview their own availability.
app.get("/api/bookable/availability", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const offeringKey = String(req.query.offeringKey || "");
  const date = String(req.query.date || "");
  if (!offeringKey || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "offeringKey and date (YYYY-MM-DD) are required." });
  }
  const slots = getAvailableSlots(seller, offeringKey, date);
  res.json({ offeringKey, date, slots });
});

app.post("/api/bookable/bookings/:id/cancel", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const id = String(req.params.id || "");
  const booking = seller.catalog.BOOKINGS.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  booking.status = "cancelled";
  console.log(`Bookable: booking ${id} cancelled from the dashboard for ${seller.sellerId}.`);

  try {
    await saveBookingsToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/bookings cancel: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Cancelled and live now, but couldn't persist to storage -- it may revert if the server restarts before you try again." });
  }
});

// ---------- MANUAL SELLER WHATSAPP CONNECT (stopgap until Embedded Signup / Phase B) ----------
// Embedded Signup (Phase B) isn't built yet, so until then this is how a
// seller's WhatsApp number actually gets connected: the platform owner
// looks up the seller's phone_number_id + permanent access token in Meta's
// WhatsApp Manager (the same place seller1's own PHONE_NUMBER_ID /
// WHATSAPP_TOKEN env vars came from) and enters them here by hand. Gated
// by the same master ADMIN_KEY as the rest of the owner-only dashboard,
// not a seller's own session -- a seller cannot connect their own number
// through this route, only the platform owner can, on their behalf, for
// now. Note this is a separate step from Meta itself: the seller's WABA
// still has to be subscribed to this app to actually receive webhook
// events (same one-time step /subscribe above does for the original WABA).
app.post("/api/admin/connect-seller-whatsapp", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const sellerId = String(req.body?.sellerId || "").trim();
  const phoneNumberId = String(req.body?.phoneNumberId || "").trim();
  const whatsappToken = String(req.body?.whatsappToken || "").trim();
  const ownerPhoneNumber = String(req.body?.ownerPhoneNumber || "").trim();

  if (!sellerId) return res.status(400).json({ error: "sellerId is required." });
  if (!phoneNumberId) return res.status(400).json({ error: "phoneNumberId is required." });
  if (!whatsappToken) return res.status(400).json({ error: "whatsappToken is required." });

  const seller = await getSellerById(sellerId);
  if (!seller) return res.status(404).json({ error: "No seller with that sellerId." });

  const existingOwner = phoneNumberIdToSellerId[phoneNumberId];
  if (existingOwner && existingOwner !== sellerId) {
    return res.status(409).json({ error: `That phone_number_id is already connected to a different seller (${existingOwner}).` });
  }

  try {
    await redisCommand([
      "HSET", `seller:${sellerId}`,
      "phoneNumberId", phoneNumberId,
      "whatsappToken", whatsappToken,
      "ownerPhoneNumber", ownerPhoneNumber,
      "status", "active",
    ]);
    registerSellerPhoneNumberId(sellerId, phoneNumberId);
    invalidateSellerContextCache(sellerId);
    console.log(`Seller ${sellerId} manually connected to WhatsApp number ${phoneNumberId} by admin.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("connect-seller-whatsapp failed:", err.message);
    res.status(500).json({ error: "Failed to save. Please try again." });
  }
});

// A tiny read-only companion so the admin doesn't need direct Redis access
// just to see which sellers exist and their sellerId (needed to call the
// connect route above).
app.get("/api/admin/sellers", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  try {
    const ids = (await redisCommand(["SMEMBERS", "all_sellers"])) || [];
    const sellers = await Promise.all(ids.map((id) => getSellerById(id)));
    res.json({
      sellers: sellers.filter(Boolean).map((s) => ({
        sellerId: s.sellerId,
        businessName: s.businessName,
        email: s.email,
        status: s.status,
        suspended: s.suspended === "1",
        phoneNumberId: s.phoneNumberId || null,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error("api/admin/sellers failed:", err.message);
    res.status(500).json({ error: "failed to list sellers" });
  }
});

// A soft, reversible hold: flips a seller's `suspended` flag without
// touching anything else about them. While suspended, the webhook (see the
// check right after resolving `seller` in the /webhook handler) drops every
// incoming message for that seller's number without replying -- Amara goes
// silent for their customers, but every catalog/offering/booking/customer
// record stays exactly as it was, so un-suspending picks back up instantly.
// Meant for "pause this test/live seller for a bit" -- for actually removing
// a seller and its data, see /api/admin/delete-seller below.
app.post("/api/admin/suspend-seller", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const sellerId = String(req.body?.sellerId || "").trim();
  const suspended = !!req.body?.suspended;
  if (!sellerId) return res.status(400).json({ error: "sellerId is required." });
  if (sellerId === SELLER1_ID) {
    return res.status(400).json({ error: "seller1 (your own shop) can't be suspended from here." });
  }
  const seller = await getSellerById(sellerId);
  if (!seller) return res.status(404).json({ error: "No seller with that sellerId." });

  try {
    await redisCommand(["HSET", `seller:${sellerId}`, "suspended", suspended ? "1" : "0"]);
    invalidateSellerContextCache(sellerId);
    console.log(`Seller ${sellerId} (${seller.businessName}) ${suspended ? "suspended" : "resumed"} by admin.`);
    res.json({ ok: true, suspended });
  } catch (err) {
    console.error("suspend-seller failed:", err.message);
    res.status(500).json({ error: "Failed to save. Please try again." });
  }
});

// Permanent, irreversible removal of a seller and every piece of data that
// belongs only to them: their seller record, every namespaced Redis key
// (catalog/offerings/availability/bookings/conversations/customers/photos
// sent/analytics -- anything ever written under the `s:<sellerId>:` prefix
// nsKey() gives non-seller1 sellers), and the email index that would
// otherwise block re-signing-up with the same address. seller1 (the real
// KP Collections shop) can never be deleted through this route -- there's
// no path in this codebase that even computes an `s:<sellerId>:` prefix for
// it, since nsKey() special-cases seller1 to the original unprefixed keys,
// so this guard is what keeps a fat-fingered sellerId from ever reaching
// that code.
app.post("/api/admin/delete-seller", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const sellerId = String(req.body?.sellerId || "").trim();
  if (!sellerId) return res.status(400).json({ error: "sellerId is required." });
  if (sellerId === SELLER1_ID) {
    return res.status(400).json({ error: "seller1 (your own shop) can't be deleted." });
  }
  const seller = await getSellerById(sellerId);
  if (!seller) return res.status(404).json({ error: "No seller with that sellerId." });

  try {
    // Scan out and delete every key namespaced to this seller, in batches --
    // could be dozens of keys (catalog, offerings, availability, blocked
    // dates, bookings, every customer's conversation history and profile,
    // photo-sent tracking, analytics), so SCAN+DEL rather than assuming a
    // fixed list.
    const prefix = `s:${sellerId}:`;
    let cursor = "0";
    let deletedKeys = 0;
    do {
      const result = await redisCommand(["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "200"]);
      cursor = result?.[0] || "0";
      const keys = result?.[1] || [];
      if (keys.length > 0) {
        await redisCommand(["DEL", ...keys]);
        deletedKeys += keys.length;
      }
    } while (cursor !== "0");

    await redisCommand(["DEL", `seller:${sellerId}`]);
    await redisCommand(["SREM", "all_sellers", sellerId]);
    if (seller.email) await redisCommand(["DEL", `seller_by_email:${seller.email.toLowerCase()}`]);

    // Clean up every in-memory trace too, so nothing about this seller can
    // linger in this running process until a restart.
    delete sellerCatalogs[sellerId];
    invalidateSellerContextCache(sellerId);
    if (seller.phoneNumberId) delete phoneNumberIdToSellerId[seller.phoneNumberId];

    console.log(`Seller ${sellerId} (${seller.businessName}) permanently deleted by admin -- ${deletedKeys} namespaced keys removed.`);
    res.json({ ok: true, deletedKeys });
  } catch (err) {
    console.error("delete-seller failed:", err.message);
    res.status(500).json({ error: "Failed to delete. Please try again." });
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

    // Paystack's webhook hands back only a bare reference string, with no
    // way on its own to know which seller this was for -- that's why
    // sellerId got stored INSIDE the order record when it was created
    // (see processBufferedTurn). Falls back to seller1 for any order that
    // was already in flight at the moment this multi-tenant rewrite
    // deployed, so a payment mid-flight during the deploy still resolves
    // to the one shop that was live before today.
    const seller = await getSellerContext(order.sellerId || SELLER1_ID);
    if (!seller) {
      console.error(`Paystack webhook: order ${reference} references unknown seller "${order.sellerId}", cannot confirm.`);
      return;
    }

    await recordOrderAnalytics(seller.sellerId, order);

    const productName = seller.catalog.PRODUCT_NAMES[order.productKey] || order.productKey;

    // Deterministic confirmation text, NOT AI-generated: this is a real
    // money confirmation reaching a real customer, not a place to risk
    // any AI phrasing drift or hallucinated detail.
    const confirmationText =
      `Payment received! ✅ Your ${productName} (N${order.totalNaira.toLocaleString()}) is confirmed, ` +
      `we'll get it sorted for delivery. Thank you!`;
    await sendWhatsApp(seller, order.phone, confirmationText);

    let history = await getConversation(seller.sellerId, order.phone);
    history.push({ role: "assistant", content: confirmationText });
    history = history.slice(-10);
    await saveConversation(seller.sellerId, order.phone, history);

    await upsertCustomer(seller.sellerId, order.phone, {
      last_payment_reference: reference,
      last_payment_amount: order.totalNaira,
      last_payment_at: new Date().toISOString(),
    });

    if (seller.ownerPhoneNumber) {
      const ownerNote =
        `💰 Payment received\n\n` +
        `Customer: ${order.phone}\n` +
        `Item: ${productName}\n` +
        `Amount: N${order.totalNaira.toLocaleString()}\n` +
        `Ref: ${reference}`;
      const notified = await sendWhatsApp(seller, seller.ownerPhoneNumber, ownerNote);
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
  res.send("Stafly.AI engine is running ✓");
});

const PORT = process.env.PORT || 3000;
// Before accepting any traffic: bootstrap seller1's own seller record,
// warm the phone_number_id -> sellerId routing index for every seller who
// already has a connected number, and load seller1's real catalog from
// Redis (or persist the demo one as the starting point, if this is the
// very first run ever) -- so the first webhook or dashboard request never
// sees stale hardcoded data instead of an owner's actual saved edits, and
// never gets misrouted while something lazy-loads.
(async () => {
  await ensureSeller1();
  await warmPhoneNumberIdIndex();
  await loadCatalogFromRedis(SELLER1_ID);
})().finally(() => {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
});
