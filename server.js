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
const path = require("path");
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

// Chart.js served from our own dependency rather than a public CDN --
// no external network call for sellers loading the dashboard (and no
// risk of a corporate firewall or ad-blocker silently killing the
// analytics chart the way a third-party CDN could).
app.get("/vendor/chart.js", (req, res) => {
  // chart.js's own package.json "exports" map blocks require.resolve()
  // on a dist subpath, so we build the path by hand instead of asking
  // Node's module resolver for it.
  res.sendFile(path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.js"));
});

// Same two fonts as the public marketing site (see stafly-website's
// layout.tsx for the full reasoning), self-hosted here too rather than
// pulled from Google Fonts -- one less external dependency, and it
// means the seller-facing product and the marketing site are now
// genuinely one visual family instead of two products that happen to
// share a name. @fontsource's own CSS files use relative `./files/...`
// URLs, so serving each package's directory statically at a matching
// path is all that's needed -- the browser resolves the font files
// itself, no path-rewriting required.
app.use("/vendor/fonts/inter", express.static(path.join(__dirname, "node_modules", "@fontsource", "inter")));
app.use("/vendor/fonts/plus-jakarta-sans", express.static(path.join(__dirname, "node_modules", "@fontsource-variable", "plus-jakarta-sans")));
app.use("/vendor/fonts/geist", express.static(path.join(__dirname, "node_modules", "@fontsource-variable", "geist")));
app.use("/vendor/fonts/geist-mono", express.static(path.join(__dirname, "node_modules", "@fontsource-variable", "geist-mono")));

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
      // Seller-defined grouping, e.g. "Tees" or "Hoodies" -- free text they
      // create themselves, no fixed taxonomy. A product without one simply
      // has no category.
      PRODUCT_CATEGORIES: {},
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
    // Shop identity shown on the Home tab. Optional and seller-written --
    // absent means absent, never a generated stand-in. The *Version fields
    // are upload timestamps, used both as "is there a picture" and as the
    // cache-buster on its URL.
    tagline: record?.tagline || "",
    about: record?.about || "",
    location: record?.location || "",
    avatarVersion: record?.avatarVersion || "",
    coverVersion: record?.coverVersion || "",
    setupDismissed: record?.setupDismissed === "1",
    createdAt: record?.createdAt || "",
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

// ---------- BRAND PHOTOS (profile picture + cover) ----------
// Same storage shape as the catalog photos above: base64 in Redis, cached
// in memory, served from our own URL. Kept in its own key namespace
// (brand:photo:avatar / brand:photo:cover) rather than reusing the catalog
// one, so a product can never collide with the shop's own picture.
//
// A cover is wider and gets a slightly larger ceiling than a product shot;
// both are still small enough that Redis stays a reasonable place for them.
const BRAND_PHOTO_LIMITS = { avatar: 1.5 * 1024 * 1024, cover: 2.5 * 1024 * 1024 };
const uploadBrand = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRAND_PHOTO_LIMITS.cover },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
const brandPhotoCache = {};

app.get("/brand-photo/:sellerId/:kind", async (req, res) => {
  const { sellerId } = req.params;
  const kind = req.params.kind === "cover" ? "cover" : "avatar";
  const cacheKey = `${sellerId}:${kind}`;
  let entry = brandPhotoCache[cacheKey];
  if (!entry) {
    try {
      const raw = await redisCommand(["GET", nsKey(sellerId, `brand:photo:${kind}`)]);
      if (!raw) return res.status(404).send("Not found");
      const parsed = JSON.parse(raw);
      entry = { mime: parsed.mime, buffer: Buffer.from(parsed.data, "base64") };
      brandPhotoCache[cacheKey] = entry;
    } catch (err) {
      console.error("brand-photo fetch failed:", err.message);
      return res.status(500).send("Failed to load photo");
    }
  }
  res.set("Content-Type", entry.mime || "image/jpeg");
  // Short cache: unlike a product photo (whose URL changes with its key),
  // this URL is stable, so a long cache would show the old picture for a
  // day after the seller changed it. The version query the dashboard adds
  // is what actually busts it; this is just a floor.
  res.set("Cache-Control", "public, max-age=60");
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
      for (const key of Object.keys(catalog.PRODUCT_CATEGORIES || {})) delete catalog.PRODUCT_CATEGORIES[key];
      for (const [key, p] of Object.entries(products)) {
        catalog.PRODUCT_PRICES[key] = p.price;
        catalog.PRODUCT_NAMES[key] = p.name;
        catalog.PRODUCT_IMAGES[key] = p.imageUrl || `${BASE_URL}/images/${key}.png`;
        catalog.PRODUCT_DESCRIPTIONS[key] = p.description || "";
        if (!catalog.PRODUCT_CATEGORIES) catalog.PRODUCT_CATEGORIES = {};
        catalog.PRODUCT_CATEGORIES[key] = p.category || "";
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
      category: (catalog.PRODUCT_CATEGORIES && catalog.PRODUCT_CATEGORIES[key]) || undefined,
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
      // The seller's own category is part of the product line, so Amara can
      // answer "what hoodies do you have?" from real grouping rather than
      // guessing from names. It's only ever as good as what they typed --
      // a product with no category simply doesn't carry one.
      const category = catalog.PRODUCT_CATEGORIES && catalog.PRODUCT_CATEGORIES[key];
      const line = `${i + 1}. ${catalog.PRODUCT_NAMES[key]} — N${catalog.PRODUCT_PRICES[key].toLocaleString()} (key: ${key}${category ? `, category: ${category}` : ""})`;
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

  const DELIVERY_MODE_LABELS = {
    online: "Online only (video/call, no physical location)",
    in_person: "In-person only, no online option",
    either: "Either -- online or in-person, customer's choice",
  };
  const offeringLines = Object.keys(catalog.OFFERINGS)
    .map((key, i) => {
      const o = catalog.OFFERINGS[key];
      let line = `${i + 1}. ${o.name} — N${o.price.toLocaleString()}, ${o.durationMinutes} minutes (key: ${key})`;
      // Real, seller-set field -- not a guess, not something to infer from
      // the service name. Whether it's online, in-person, or either is one
      // of the most common questions a customer asks before booking, so
      // this is answered directly from here, never escalated to the owner
      // unless it's genuinely blank below.
      line += `\n   Delivery: ${DELIVERY_MODE_LABELS[o.deliveryMode] || "Not set yet -- if asked, use [ESCALATE] to check with the owner rather than guessing"}`;
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

IS IT ONLINE OR IN-PERSON:
- Each service above has its own "Delivery" line, set by the business
  owner -- that is the real, current answer, never a guess based on the
  service's name or what seems likely. Answer directly and confidently
  from it whenever a customer asks.
- Only escalate an online-vs-in-person question when that service's
  Delivery line actually says "Not set yet" -- if it already says Online
  only, In-person only, or Either, just answer, don't escalate.

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
    // Piggyback the last message's role onto the customer hash -- a cheap,
    // real signal the dashboard can read straight off the customer record
    // it already fetches every poll, without ever pulling full conversation
    // history just to answer "did the owner already reply to this?"
    // ...and a short preview of that message, so the dashboard's conversation
    // list can show what was actually said instead of a row of metadata. Same
    // reasoning as last_message_role: one field on a hash the dashboard
    // already reads every poll, never a full history fetch per row.
    const last = history[history.length - 1];
    if (last?.role) {
      const preview = String(last.content || "").replace(/\s+/g, " ").trim().slice(0, 140);
      await redisCommand([
        "HSET", nsKey(sellerId, `customer:${from}`),
        "last_message_role", last.role,
        "last_message_preview", preview,
      ]);
    }
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

// ---------- Tracking a still-open escalation the owner hasn't answered yet ----------
// So a free-text reply from the owner ("It's online, but he can come in
// person if he wants") can be recognized as actually ANSWERING this
// specific open customer question, and relayed to them for real -- instead
// of just being treated as a generic question TO Amara herself, which is
// what let the customer's actual question go unanswered before (Amara told
// the owner "I'll let him know" and then never did, because nothing in
// code actually sent anything to the customer). One at a time per seller,
// same scope as last_escalated_customer above -- this whole
// pause/resume/answer system already assumes one thing being actively
// handled at a time, not several concurrent threads tracked independently.
async function setPendingEscalationAnswer(sellerId, phone, reason) {
  try {
    await redisCommand([
      "SET",
      nsKey(sellerId, "pending_escalation_answer"),
      JSON.stringify({ phone, reason }),
      "EX",
      "1800", // 30 minutes -- enough time for the owner to actually think it through
    ]);
  } catch (err) {
    console.error("setPendingEscalationAnswer failed:", err.message);
  }
}

async function getPendingEscalationAnswer(sellerId) {
  try {
    const raw = await redisCommand(["GET", nsKey(sellerId, "pending_escalation_answer")]);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("getPendingEscalationAnswer failed:", err.message);
    return null;
  }
}

async function clearPendingEscalationAnswer(sellerId) {
  try {
    await redisCommand(["DEL", nsKey(sellerId, "pending_escalation_answer")]);
  } catch (err) {
    console.error("clearPendingEscalationAnswer failed:", err.message);
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
    const records = (await Promise.all(phones.map((phone) => getCustomer(sellerId, phone)))).filter(Boolean);
    await reconcileExpiredPauses(sellerId, records);
    return records;
  } catch (err) {
    console.error("listAllCustomers failed:", err.message);
    return [];
  }
}

// A pause lives in two places: the `paused:<phone>` key, which expires on
// its own after 6 hours, and a `paused` field on the customer record, which
// is what the dashboard reads. Nothing used to clear that field when the key
// expired, so a forgotten pause kept showing as "You" in the dashboard long
// after Amara had actually gone back to replying -- the seller would think a
// customer was waiting on them personally while Amara was already answering.
// Checking the real key is the source of truth; the record is corrected in
// place so it stays fixed rather than being patched on every read.
async function reconcileExpiredPauses(sellerId, records) {
  const claimedPaused = records.filter((c) => c.paused === "yes");
  if (claimedPaused.length === 0) return;
  await Promise.all(
    claimedPaused.map(async (c) => {
      try {
        const stillPaused = await redisCommand(["GET", nsKey(sellerId, `paused:${c.phone}`)]);
        if (stillPaused) return;
        c.paused = "no";
        await upsertCustomer(sellerId, c.phone, { paused: "no" });
      } catch (err) {
        // Leave the record as-is on a Redis hiccup: showing a stale pause is
        // less harmful than wrongly telling the seller Amara has it covered.
        console.error(`reconcileExpiredPauses failed for ${c.phone}:`, err.message);
      }
    })
  );
}

// Called on every incoming customer message: keeps first/last contact
// time and message count up to date without needing any separate step.
async function recordCustomerContact(sellerId, phone, waName) {
  const existing = await getCustomer(sellerId, phone);
  const now = new Date().toISOString();
  const fields = {
    phone,
    first_contact: existing?.first_contact || now,
    last_contact: now,
    message_count: existing?.message_count ? Number(existing.message_count) + 1 : 1,
  };
  // Their WhatsApp profile name, refreshed on every message so a rename on
  // their side follows through. Only written when Meta actually sent one --
  // never blanked out by a payload that happens to omit it.
  if (waName) fields.wa_name = waName;
  await upsertCustomer(sellerId, phone, fields);
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

// Partial update of a seller's own record. Only ever writes the fields
// handed to it, so one caller changing a tagline can't blank a password
// hash or a connection token it never looked at.
async function updateSellerRecord(sellerId, fields) {
  const flat = [];
  for (const [key, value] of Object.entries(fields)) flat.push(key, String(value));
  if (flat.length === 0) return;
  await redisCommand(["HSET", `seller:${sellerId}`, ...flat]);
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

// ---------- Deduplicating incoming webhook messages ----------
// WhatsApp's Cloud API is documented "at least once" delivery: Meta can and
// does redeliver the exact same message (same id) more than once, and this
// server had nothing guarding against handling it twice. That's exactly
// what produced two full, independent replies to one customer message a
// minute or so apart -- not a code bug in how a single turn is composed,
// but a missing safeguard against the same turn running more than once.
// SET ... NX claims the id atomically: only the delivery that gets "OK"
// back is the real, first one; anything that gets null back for the same
// id is a redelivery of a message already answered, and gets dropped.
async function claimIncomingMessageId(sellerId, messageId) {
  try {
    const result = await redisCommand([
      "SET",
      nsKey(sellerId, `seen_msg:${messageId}`),
      "1",
      "NX",
      "EX",
      "86400",
    ]);
    return result !== "OK"; // true = someone already claimed this id = duplicate
  } catch (err) {
    console.error(`claimIncomingMessageId failed for ${messageId}:`, err.message);
    // Fail open: a rare double-reply from a Redis hiccup is far better than
    // silently dropping a real customer message because Redis blipped.
    return false;
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

async function getAnalyticsSummary(sellerId, customers, catalog, windowDays) {
  // The window is the seller's choice (7 / 14 / 30). Always generates the
  // full range and lets a missing key read as 0, rather than needing a
  // separate index of "which days have data" — one GET per day per metric,
  // cheap at this scale.
  const span = [7, 14, 30].includes(Number(windowDays)) ? Number(windowDays) : 14;
  const days = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  // The window immediately before this one, so every headline number can be
  // stated against a real comparison instead of standing alone. Nothing is
  // projected: if the previous window has no data, the comparison says so.
  const prevDays = [];
  for (let i = span * 2 - 1; i >= span; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    prevDays.push(d.toISOString().slice(0, 10));
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

  // Previous window, totals only -- it is a comparison, not a second chart.
  let prevRevenue = 0, prevOrders = 0, prevHasData = false;
  try {
    const raws = await Promise.all(prevDays.map((d) => Promise.all([
      redisCommand(["GET", nsKey(sellerId, `analytics:day:${d}:revenue`)]),
      redisCommand(["GET", nsKey(sellerId, `analytics:day:${d}:orders`)]),
    ])));
    for (const [r, o] of raws) {
      if (r !== null && r !== undefined) prevHasData = true;
      if (o !== null && o !== undefined) prevHasData = true;
      prevRevenue += Number(r) || 0;
      prevOrders += Number(o) || 0;
    }
  } catch (err) {
    console.error("getAnalyticsSummary: previous-window lookup failed:", err.message);
  }

  // Which days of the week actually bring in orders, summed across the
  // window. Counted from the same daily totals the chart draws.
  const weekdayOrders = [0, 0, 0, 0, 0, 0, 0];
  const weekdayRevenue = [0, 0, 0, 0, 0, 0, 0];
  for (const t of trend) {
    const dow = new Date(t.date + "T00:00:00").getDay();
    if (Number.isInteger(dow)) {
      weekdayOrders[dow] += t.orders;
      weekdayRevenue[dow] += t.revenue;
    }
  }

  // New versus returning, over the same window: a customer whose very first
  // message landed inside it is new; one who first wrote earlier but has
  // been back since is returning. Both come from stored contact dates.
  const windowStart = days[0];
  let newCustomers = 0, returningCustomers = 0;
  for (const c of customers) {
    const first = (c.first_contact || "").slice(0, 10);
    const last = (c.last_contact || "").slice(0, 10);
    if (!first) continue;
    if (first >= windowStart) newCustomers += 1;
    else if (last >= windowStart) returningCustomers += 1;
  }

  // How much of the work Amara is carrying unaided right now.
  const handledByOwner = customers.filter((c) => c.paused === "yes").length;

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
    span,
    trend,
    bestSellers,
    previous: { revenue: prevRevenue, orders: prevOrders, hasData: prevHasData },
    weekday: { orders: weekdayOrders, revenue: weekdayRevenue },
    customers: { new: newCustomers, returning: returningCustomers, handledByOwner, total: customers.length },
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

    // Claim this message id before doing anything else with it. If Meta
    // redelivered a message we already handled, this returns true and we
    // stop here -- see claimIncomingMessageId above for why this exists.
    const isDuplicateDelivery = await claimIncomingMessageId(seller.sellerId, message.id);
    if (isDuplicateDelivery) {
      console.log(`Webhook: duplicate delivery of message ${message.id} for ${seller.sellerId}, already handled -- ignoring.`);
      return;
    }

    const from = message.from;             // sender's number
    const text = message.text.body;        // what they said
    // Meta puts the sender's WhatsApp profile name in every webhook payload
    // and we had never read it -- which is why the whole dashboard showed a
    // wall of raw phone numbers. This is the name THEY set on their own
    // WhatsApp account; it can change, and it is not verified, so it's shown
    // as a label beside the number, never as a substitute for identifying
    // who actually paid.
    const waName = String(value?.contacts?.[0]?.profile?.name || "").trim().slice(0, 80);

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
    await recordCustomerContact(seller.sellerId, from, waName);

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
    history.push({ role: "user", content: text, at: Date.now() });

    await markReadAndShowTyping(seller, messageId);
    const holdingNote = "Just a moment, the owner's handling this personally right now.";
    await humanPause(holdingNote);
    await sendWhatsApp(seller, from, holdingNote);
    await markNotifiedPaused(seller.sellerId, from);
    history.push({ role: "assistant", content: holdingNote, at: Date.now() });
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
    history.push({ role: "user", content: combinedText, at: Date.now() });
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
      history.push({ role: "assistant", content: holdingNote || "[paused: owner is handling this personally]", at: Date.now() });
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
    // Amara can greet the customer by the name they set on WhatsApp. Framed
    // as "may be a nickname" on purpose -- it's unverified and self-chosen,
    // so she must never treat it as the name on a payment or an order.
    const nameNote = waName
      ? `The customer's WhatsApp profile name is "${waName}". You may greet them by their first name if it reads naturally, but it is self-chosen and unverified -- never use it to confirm an identity, a payment or an order.`
      : "";
    const reminder = [photoReminder, nameNote].filter(Boolean).join("\n\n");
    let rawReply = await askAI(seller, history, reminder);

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
    history.push({ role: "assistant", content: memoryBody, at: Date.now() });
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
        clarifyHistory.push({ role: "assistant", content: clarifyText, at: Date.now() });
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
          paymentHistory.push({ role: "assistant", content: linkMessage, at: Date.now() });
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
          bookingHistory.push({ role: "assistant", content: confirmMessage, at: Date.now() });
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
          apologyHistory.push({ role: "assistant", content: apologyClean, at: Date.now() });
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
      const actuallyAlerted = await sendOwnerAlert(seller, from, escalationReason, combinedText);
      // sendOwnerAlert can silently no-op (recent-alert cooldown, no owner
      // number set) -- only claim the owner was alerted when it really
      // sent something, so this log can be trusted for what actually
      // happened rather than just that this code path ran.
      console.log(actuallyAlerted ? `Owner alerted: ${escalationReason}` : `Owner alert NOT sent (see suppression reason above): ${escalationReason}`);
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
        // Strip down to exactly what Anthropic's API accepts per message --
        // just role/content. The stored history now also carries a real
        // "at" timestamp (added so the dashboard can show genuine message
        // times), and sending that extra field straight through as part of
        // "messages" would be handing the API a shape it never asked for.
        messages: history.map((m) => ({ role: m.role, content: m.content })),
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
  const match = text.match(/\[PHOTO:\s*([\w-]+)\]/i);
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
  const match = text.match(/\[PAY:\s*([\w-]+)\s*,\s*([\w-]+)\]/i);
  if (!match) return { cleanText: text.trim(), paymentKey: null, paymentZone: null };

  const paymentKey = match[1].toLowerCase();
  const paymentZone = match[2].toLowerCase();
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, paymentKey, paymentZone };
}

// ---------- Bookable sellers only: pull the invisible [AVAILABILITY: key, date] tag ----------
function extractAvailabilityTag(text) {
  const match = text.match(/\[AVAILABILITY:\s*([\w-]+)\s*,\s*(\d{4}-\d{2}-\d{2})\]/i);
  if (!match) return { cleanText: text.trim(), availabilityKey: null, availabilityDate: null };

  const availabilityKey = match[1].toLowerCase();
  const availabilityDate = match[2];
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, availabilityKey, availabilityDate };
}

// ---------- Bookable sellers only: pull the invisible [BOOK: key, date, time] tag ----------
function extractBookingTag(text) {
  const match = text.match(/\[BOOK:\s*([\w-]+)\s*,\s*(\d{4}-\d{2}-\d{2})\s*,\s*([01]\d|2[0-3]):([0-5]\d)\]/i);
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


async function interpretOwnerIntent(text, pendingEscalationReason) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // When there's a specific open customer question Amara is waiting on,
    // give the classifier that context and add a third option: the owner
    // might just be directly answering it, rather than asking to pause or
    // resume anything. Without ANSWER as an option, a real answer like
    // "It's online, but he can come see me in person if he wants" had
    // nowhere sensible to land -- it isn't pause or resume, so it fell all
    // the way through to a generic "answer the owner's own question" reply,
    // which is how Amara ended up telling the owner "I'll let him know"
    // and then never actually contacting the customer at all.
    const system = pendingEscalationReason
      ? `The owner of a small business just texted their AI sales ` +
        `assistant. Amara recently asked this owner for help with a ` +
        `specific open customer question: "${pendingEscalationReason}". ` +
        `Decide what they want:\n` +
        `PAUSE - they want the AI to stop replying to that customer so ` +
        `they can handle it themselves (e.g. "I'll take this one", ` +
        `"let me handle it", "I got this", "pause, I'll deal with it")\n` +
        `RESUME - they want the AI to start replying to that customer ` +
        `again (e.g. "ok you can continue", "I'm done", "go ahead and ` +
        `take back over")\n` +
        `ANSWER - they are directly answering or resolving that specific ` +
        `open question, giving real information or an instruction meant ` +
        `to be passed on to the customer (e.g. explaining a detail, ` +
        `giving a price, saying yes or no to a request)\n` +
        `NONE - none of the above, or something unrelated, like asking ` +
        `Amara a different question about the business itself\n\n` +
        `Reply with ONLY one word: PAUSE, RESUME, ANSWER, or NONE.`
      : `The owner of a small business just texted their AI sales ` +
        `assistant. Decide what they want:\n` +
        `PAUSE - they want the AI to stop replying to a customer so ` +
        `they can handle it themselves (e.g. "I'll take this one", ` +
        `"let me handle it", "I got this", "pause, I'll deal with it")\n` +
        `RESUME - they want the AI to start replying to that customer ` +
        `again (e.g. "ok you can continue", "I'm done", "go ahead and ` +
        `take back over")\n` +
        `NONE - neither, or genuinely unclear\n\n` +
        `Reply with ONLY one word: PAUSE, RESUME, or NONE.`;

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
        system,
        messages: [{ role: "user", content: text }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    const reply = data?.content?.[0]?.text?.trim().toUpperCase();
    if (reply === "PAUSE" || reply === "RESUME") return reply;
    if (reply === "ANSWER" && pendingEscalationReason) return reply;
    return "NONE";
  } catch (err) {
    console.error("interpretOwnerIntent failed:", err.message);
    return "NONE"; // fail safe: don't guess on a broken call, fall through to help text
  }
}

async function relayOwnerAnswerToCustomer(seller, pending, ownerText) {
  const { phone, reason } = pending;
  let customerMessage = null;
  try {
    const instruction =
      `[Internal note, not a real customer message: the owner just ` +
      `answered this customer's open question ("${reason}") directly to ` +
      `you, so you can pass it on. The owner's exact words: "${ownerText}".\n\n` +
      `Write a short, warm, natural WhatsApp message to the customer that ` +
      `actually answers their question, using ONLY the real information ` +
      `the owner just gave you -- don't invent or add any detail they ` +
      `didn't say. Don't use a [PHOTO], [ESCALATE], [BOOK], [PAY], or ` +
      `[AVAILABILITY] tag here. Output ONLY the final message itself, ` +
      `nothing else, no drafts, no narrating your own corrections, just ` +
      `the finished text ready to send.]`;
    const reply = await askAI(seller, [{ role: "user", content: instruction }]);
    const { cleanText: step1 } = extractPhotoTag(reply);
    const { cleanText: step2 } = extractEscalationTag(step1);
    const finalText = stripBannedEmojis(stripSelfCorrection(step2)).trim();
    if (finalText) customerMessage = finalText;
  } catch (err) {
    console.error("relayOwnerAnswerToCustomer failed to compose message:", err.message);
  }
  // Hard fallback so a broken AI call still gets the owner's real words to
  // the customer, rather than silently dropping the answer entirely.
  if (!customerMessage) customerMessage = ownerText;

  const delivered = await sendWhatsApp(seller, phone, customerMessage);
  if (delivered) {
    let history = await getConversation(seller.sellerId, phone);
    history.push({ role: "assistant", content: customerMessage, at: Date.now() });
    history = history.slice(-10);
    await saveConversation(seller.sellerId, phone, history);
    console.log(`Amara -> ${phone}: [relayed owner's answer] ${customerMessage}`);
    await sendWhatsApp(seller, seller.ownerPhoneNumber, `Told ${phone}: "${customerMessage}"`);
  } else {
    // Most likely cause: more than 24 hours since this customer last
    // messaged, so a free-form message isn't allowed. Tell the owner
    // plainly rather than letting them believe it went through, which is
    // exactly the false confidence this whole fix exists to remove.
    console.error(`Could not relay owner's answer to ${phone} (likely outside the 24h messaging window).`);
    await sendWhatsApp(
      seller,
      seller.ownerPhoneNumber,
      `Got your answer, but couldn't actually reach ${phone} right now (probably outside WhatsApp's 24-hour reply window) -- they'll need to message in again first.`
    );
  }

  // This question is resolved either way now -- clear the pending-answer
  // state AND the short-affirmative pause trap together, so a later,
  // unrelated "thanks" or "alright" from the owner isn't misread as "yes,
  // pause this customer" just because it happens to land inside that old
  // 10-minute window.
  await clearPendingEscalationAnswer(seller.sellerId);
  try {
    await redisCommand(["DEL", nsKey(seller.sellerId, "awaiting_pause_confirmation")]);
  } catch (err) {
    console.error("Could not clear awaiting_pause_confirmation after relay:", err.message);
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

  // If Amara is still waiting on an answer to a specific open customer
  // question, fetch it once here -- used both to let the classifier below
  // recognize a direct answer to it, and, if that's what this is, to know
  // who to relay it to.
  const pendingEscalation = await getPendingEscalationAnswer(seller.sellerId);

  if (!command) {
    // No exact match. Ask the AI whether this was natural-language
    // pause/resume phrasing -- or, if there's a question Amara is still
    // waiting on, whether this IS the owner's answer to it -- before
    // giving up and showing the help menu.
    const intent = await interpretOwnerIntent(text, pendingEscalation?.reason);
    if (intent === "PAUSE") command = { action: "pause", target: "last" };
    else if (intent === "RESUME") command = { action: "resume", target: "last" };
    else if (intent === "ANSWER" && pendingEscalation) {
      await relayOwnerAnswerToCustomer(seller, pendingEscalation, text);
      return;
    }
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

  // Either way, the owner just made an explicit choice about this
  // customer, so any question Amara was still holding open for a possible
  // ANSWER is moot now -- clear it so it can't get relayed stale later, or
  // confuse a later unrelated message.
  await clearPendingEscalationAnswer(seller.sellerId);

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
      customerHistory.push({ role: "assistant", content: followUp, at: Date.now() });
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


// Returns true if an alert was actually sent (or attempted via the template
// fallback), false if it was suppressed (cooldown, no owner number) or both
// send attempts failed -- callers use this instead of assuming a call to
// this function always means the owner was actually notified.
async function sendOwnerAlert(seller, customerNumber, reason, lastCustomerMessage) {
  if (!seller.ownerPhoneNumber) {
    console.error(
      `ESCALATION happened for seller ${seller.sellerId} but no owner phone number is set, no alert sent. Reason:`,
      reason
    );
    return false;
  }

  // If we already alerted about this exact customer within the last few
  // minutes, don't buzz the owner again for what's very likely still the
  // same unresolved thread. Without this, the customer's very next message
  // (even a bare "Ok" while they wait) can make Amara re-emit the same
  // [ESCALATE] tag, since the underlying question still isn't answered --
  // which is how two near-identical "Amara needs you" alerts land a
  // minute apart for one open question, not two separate issues.
  const cooldownKey = nsKey(seller.sellerId, `recent_escalation_alert:${customerNumber}`);
  let alreadyAlertedRecently = false;
  try {
    alreadyAlertedRecently = !!(await redisCommand(["GET", cooldownKey]));
  } catch (err) {
    console.error("Could not check recent_escalation_alert cooldown:", err.message);
  }
  if (alreadyAlertedRecently) {
    console.log(
      `Escalation SUPPRESSED (already alerted about ${customerNumber} within the last few minutes): ${reason}`
    );
    return false;
  }
  try {
    await redisCommand(["SET", cooldownKey, "1", "EX", "180"]); // 3 minute cooldown
  } catch (err) {
    console.error("Could not set recent_escalation_alert cooldown:", err.message);
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

  // Also remember this as a still-open question the owner might directly
  // ANSWER (rather than pause/resume) -- see setPendingEscalationAnswer
  // above for why this exists.
  await setPendingEscalationAnswer(seller.sellerId, customerNumber, cleanReason);

  const freeFormSucceeded = await sendWhatsApp(seller, seller.ownerPhoneNumber, alertText);
  if (freeFormSucceeded) return true;

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
  return templateSucceeded;
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
// Geist and Geist Mono, self-hosted. See the /vendor/fonts/* static routes
// reasonable pick when this was the only surface that existed, but once
// the marketing site landed on Inter (body/UI) + Plus Jakarta Sans
// (headlines and the logo) for exactly this kind of product, running a
// third, different font here just made the dashboard read as a separate
// product again. Self-hosted (see the /vendor/fonts/* static routes
// above) rather than pulled from Google Fonts, same reasoning as
// bundling Chart.js locally: no dependency on fonts.googleapis.com being
// reachable, which this sandbox's own network policy already proved can
// silently fail.
const BRAND_FONT_LINKS = `<link rel="preload" as="font" type="font/woff2" href="/vendor/fonts/geist/files/geist-latin-wght-normal.woff2" crossorigin><link rel="stylesheet" href="/vendor/fonts/geist/index.css"><link rel="stylesheet" href="/vendor/fonts/geist-mono/index.css">`;

const BRAND_TOKENS_CSS = `
  :root {
    /* Geist, one variable family across the whole product. Inter is the
       default face of every AI dashboard on the internet, which is exactly
       why it stopped reading as a choice -- and pairing it with Plus Jakarta
       meant two faces doing one job. Geist is drawn for product interfaces:
       its figures and small UI text hold up at 10-12px, where this dashboard
       lives, and it carries real character at 30px+ where a headline needs
       it. Weight and tracking do the hierarchy, not a second family.
       Geist Mono is reserved for identifiers -- order and booking
       references -- where fixed-width, unambiguous characters are the point. */
    --font-sans: 'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-heading: 'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-mono: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
    /* --navy is a structural dark surface (the sidebar, page headers), NOT a
       text colour -- it deliberately stays dark in both themes. Text uses
       --text so it can flip. */
    --navy: #1e293b;
    --accent: #4f46e5;
    --accent-dark: #4338ca;
    --accent-light: #eef2ff;
    --accent-soft: #e0e7ff;
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-2: #f8fafc;
    --surface-3: #eef1f6;
    --chat-bg: #f1f4f9;
    --border: #e2e8f0;
    --border-light: #f1f5f9;
    --border-strong: #cbd5e1;
    --muted: #64748b;
    --muted-2: #94a3b8;
    --text: #1e293b;
    --danger: #dc2626;
    --danger-bg: #fef2f2;
    --success: #15803d;
    --success-bg: #dcfce7;
    --warning: #b45309;
    --warning-bg: #fef3c7;
    --ok-bg: #f0fdf4;
    --ok-fg: #15803d;
    --ok-border: #bbf7d0;
    --warn-bg: #fffbeb;
    --warn-fg: #b45309;
    --warn-border: #fde68a;
    --dang-bg: #fef2f2;
    --dang-fg: #b91c1c;
    --dang-border: #fecaca;
    --info-bg: #eff6ff;
    --info-fg: #1d4ed8;
    --info-border: #bfdbfe;
    --star: #d97706;
    --shadow-sm: 0 1px 2px rgba(15,23,42,0.07);
    --shadow-md: 0 1px 3px rgba(15,23,42,0.12);
    --shadow-lg: 0 8px 24px rgba(15,23,42,0.14);
    /* Tinted glow under accent-coloured controls. Set from the chosen
       accent at runtime (see applyAccent) so a teal button never keeps
       an indigo halo. */
    --accent-shadow: rgba(79,70,229,0.30);
    --accent-shadow-strong: rgba(79,70,229,0.45);
    --chat-doodle: %23b9c6dc;
  }
  /* Dark theme. Applied by setting data-theme="dark" on <html>; every colour
     below is a token override, so no component needs a dark-specific rule. */
  [data-theme="dark"] {
    --navy: #0b0f17;
    --accent: #6366f1;
    --accent-dark: #4f46e5;
    --accent-light: #1e2440;
    --accent-soft: #2a3157;
    --bg: #0d1117;
    --surface: #161b26;
    --surface-2: #1c2331;
    --surface-3: #232b3a;
    --chat-bg: #0f141d;
    --border: #2a3242;
    --border-light: #222937;
    --border-strong: #3a4457;
    --muted: #94a3b8;
    --muted-2: #6b7a90;
    --text: #e6ecf7;
    --danger: #f87171;
    --danger-bg: #2a1315;
    --success: #4ade80;
    --success-bg: #10241a;
    --warning: #fbbf24;
    --warning-bg: #2a1f0d;
    --ok-bg: #10241a;
    --ok-fg: #4ade80;
    --ok-border: #1e4433;
    --warn-bg: #2a1f0d;
    --warn-fg: #fbbf24;
    --warn-border: #4a3413;
    --dang-bg: #2a1315;
    --dang-fg: #f87171;
    --dang-border: #4d1f22;
    --info-bg: #111e33;
    --info-fg: #60a5fa;
    --info-border: #1e3a5f;
    --star: #fbbf24;
    /* Dark elevation comes mostly from the surface being lighter than the
       ground; heavy black shadows just muddy the edges, so these are softer
       than their light-theme counterparts and paired with a hairline. */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.28);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.34);
    --shadow-lg: 0 12px 30px rgba(0,0,0,0.42);
    --accent-shadow: rgba(99,102,241,0.22);
    --accent-shadow-strong: rgba(99,102,241,0.34);
    --chat-doodle: %232b3446;
  }
`;

function brandMark({ dark = false, size = "normal" } = {}) {
  const textColor = dark ? "#fff" : "var(--navy)";
  const fontSize = size === "small" ? "13px" : "16px";
  return (
    `<span style="display:inline-flex;align-items:center;gap:8px;font-family:var(--font-heading);font-weight:700;font-size:${fontSize};color:${textColor};">` +
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:var(--accent);color:#fff;font-size:13px;flex-shrink:0;">S</span>` +
    `Stafly<span style="color:${dark ? "#a5b4fc" : "var(--accent)"};">.AI</span>` +
    `</span>`
  );
}

// ---------- SELLER SIGNUP / LOGIN PAGES ----------
function authPageHtml({ title, heading, sub, formHtml, error }) {
  const isSignup = title === "Sign up";
  // The scene is a depiction of what the product actually does -- a real
  // Amara exchange -- not stock art and not invented social proof. It is the
  // same scene the marketing site's hero uses, so the two surfaces read as
  // one product rather than two different companies.
  const scene =
    '<div class="scene-thread" style="--d:.10s">' +
      '<div class="st-head">' +
        '<span class="st-dot"></span>' +
        '<span class="st-name">Ada Nwosu</span>' +
        '<span class="st-live">Amara is replying</span>' +
      '</div>' +
      '<div class="st-body">' +
        '<div class="st-row in"><div class="st-bub">Do you still have the blue Ankara gown in size 14?</div></div>' +
        '<div class="st-row out"><div class="st-bub">Yes, size 14 is in stock at N18,500. Want a photo?</div></div>' +
        '<div class="st-row in"><div class="st-bub">Yes please</div></div>' +
        '<div class="st-row out"><div class="st-bub">Sent. Delivery to Lekki is N2,000, so N20,500 altogether.</div></div>' +
        '<div class="st-row typing"><div class="st-bub st-typing"><i></i><i></i><i></i></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="scene-chip chip-pay" style="--d:.30s">' +
      '<span class="chip-mark">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
      '</span>' +
      '<span class="chip-text"><b>Payment confirmed</b><small>Order closed without you</small></span>' +
    '</div>' +
    '<div class="scene-chip chip-clock" style="--d:.44s">' +
      '<span class="chip-mark alt">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>' +
      '</span>' +
      '<span class="chip-text"><b>2:14 AM</b><small>Still answering</small></span>' +
    '</div>';

  return `
    <!doctype html>
    <html lang="en">
    <head>
      <title>${title} — Stafly.AI</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <meta name="theme-color" content="#0b1020">
      ${BRAND_FONT_LINKS}
      <script>
        // Applied before any paint so a dark-mode seller never gets a white flash.
        (function () {
          try {
            var saved = localStorage.getItem("stafly-theme");
            var dark = saved ? saved === "dark"
              : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
            if (dark) document.documentElement.setAttribute("data-theme", "dark");
          } catch (e) {}
        })();
      </script>
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: var(--font-sans); color: var(--text); background: var(--bg);
          min-height: 100dvh; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
        }

        /* ---- preloader ------------------------------------------------
           Capped hard at 1.1s and dismissed on load, whichever comes first,
           so it can never become the thing standing between a seller and
           their dashboard. */
        .pre { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 22px;
          background: radial-gradient(120% 90% at 50% 40%, #1a2140 0%, #0b1020 62%);
          transition: opacity .5s ease, visibility .5s ease; }
        .pre.done { opacity: 0; visibility: hidden; }
        .pre-mark { width: 52px; height: 52px; border-radius: 15px; display: flex; align-items: center;
          justify-content: center; background: linear-gradient(140deg, var(--accent), var(--accent-dark));
          color: #fff; font-family: var(--font-heading); font-weight: 700; font-size: 24px;
          box-shadow: 0 14px 40px rgba(79,70,229,.42); animation: preMark .9s cubic-bezier(.22,1,.36,1) both; }
        .pre-bar { width: 116px; height: 2px; border-radius: 2px; background: rgba(255,255,255,.14); overflow: hidden; }
        .pre-bar i { display: block; height: 100%; width: 40%; border-radius: 2px;
          background: linear-gradient(90deg, transparent, #fff, transparent); animation: preSweep 1.05s ease-in-out infinite; }
        @keyframes preMark { from { opacity: 0; transform: scale(.82) translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes preSweep { from { transform: translateX(-120%); } to { transform: translateX(320%); } }

        /* ---- shell ----------------------------------------------------
           Full bleed on purpose: an auth screen has one job and no reading
           column to protect, so the width goes to the thing worth looking at. */
        .shell { display: grid; grid-template-columns: 1.06fr .94fr; min-height: 100dvh; }

        /* ---- stage (left) --------------------------------------------- */
        .stage { position: relative; overflow: hidden; display: flex; flex-direction: column;
          padding: 40px 46px 44px; color: #fff;
          background: linear-gradient(163deg, #080b22 0%, #1b1856 38%, #3a2694 70%, #6b2ea8 100%); }
        /* Three light sources rather than a tinted overlay -- a flat wash over
           a flat gradient was the reason the first pass read as a dark block
           instead of a lit surface. No blur filter: it was averaging the
           three into one muddy colour. */
        .stage-glow { position: absolute; inset: 0; pointer-events: none; will-change: transform;
          background:
            radial-gradient(58% 50% at 16% 12%, rgba(129,140,248,.62), transparent 72%),
            radial-gradient(64% 56% at 88% 84%, rgba(232,74,232,.44), transparent 74%),
            radial-gradient(48% 40% at 74% 6%, rgba(56,205,248,.30), transparent 70%),
            radial-gradient(46% 52% at 2% 76%, rgba(99,102,241,.40), transparent 72%);
          animation: drift 26s ease-in-out infinite alternate; }
        /* Grain, so the panel has a material rather than a colour. */
        .stage-grain { position: absolute; inset: 0; pointer-events: none; opacity: .13;
          mix-blend-mode: soft-light;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E"); }
        @keyframes drift {
          from { transform: translate3d(-2%, -1.5%, 0) scale(1.04); }
          to   { transform: translate3d(2.5%, 2%, 0) scale(1.14); }
        }
        /* A woven texture rather than a flat fill, so the panel reads as a
           surface with light on it instead of a pasted-on gradient. */
        .stage-weave { position: absolute; inset: 0; pointer-events: none; opacity: .5;
          background-image:
            linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
          background-size: 46px 46px;
          -webkit-mask-image: radial-gradient(90% 80% at 50% 45%, #000 20%, transparent 78%);
          mask-image: radial-gradient(90% 80% at 50% 45%, #000 20%, transparent 78%); }
        .stage-top, .stage-scene, .stage-foot { position: relative; z-index: 1; }

        .stage-scene { flex: 1; display: flex; align-items: center; justify-content: center;
          position: relative; padding: 30px 12px; min-height: 0; }

        .scene-thread { width: min(400px, 100%); border-radius: 22px; padding: 6px 6px 10px;
          background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.26);
          box-shadow: 0 34px 80px rgba(4,6,24,.55), inset 0 1px 0 rgba(255,255,255,.34);
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
          animation: dealIn .8s cubic-bezier(.22,1,.36,1) var(--d, 0s) both, bobA 9s ease-in-out 1.2s infinite; }
        .st-head { display: flex; align-items: center; gap: 9px; padding: 11px 14px 12px; }
        .st-dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; flex-shrink: 0;
          box-shadow: 0 0 0 3px rgba(52,211,153,.22); }
        .st-name { font-weight: 600; font-size: 13.5px; letter-spacing: -.01em; }
        .st-live { margin-left: auto; font-size: 11px; font-weight: 500; color: rgba(255,255,255,.62); }
        .st-body { background: rgba(6,9,26,.30); border-radius: 16px; padding: 13px 13px 14px;
          display: flex; flex-direction: column; gap: 7px; }
        .st-row { display: flex; }
        .st-row.out, .st-row.typing { justify-content: flex-end; }
        .st-bub { max-width: 82%; padding: 8px 12px 9px; font-size: 12.8px; line-height: 1.45;
          border-radius: 13px; }
        .st-row.in .st-bub { background: rgba(255,255,255,.94); color: #131a2e; border-bottom-left-radius: 5px; }
        .st-row.out .st-bub, .st-row.typing .st-bub {
          background: linear-gradient(135deg, #6366f1, #4338ca); color: #fff; border-bottom-right-radius: 5px;
          box-shadow: 0 6px 18px rgba(67,56,202,.42); }
        .st-typing { display: flex; align-items: center; gap: 4px; padding: 11px 14px; }
        .st-typing i { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,.9);
          animation: blip 1.25s ease-in-out infinite; }
        .st-typing i:nth-child(2) { animation-delay: .16s; }
        .st-typing i:nth-child(3) { animation-delay: .32s; }
        @keyframes blip { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

        .scene-chip { position: absolute; display: flex; align-items: center; gap: 10px;
          padding: 10px 15px 10px 11px; border-radius: 14px;
          background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.30);
          box-shadow: 0 18px 44px rgba(4,6,24,.45), inset 0 1px 0 rgba(255,255,255,.34);
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); white-space: nowrap;
          animation: dealIn .8s cubic-bezier(.22,1,.36,1) var(--d, 0s) both, bobB 7.5s ease-in-out 1.4s infinite; }
        .chip-pay { left: 4px; bottom: 13%; }
        .chip-clock { right: 6px; top: 10%; animation-name: dealIn, bobA; }
        .chip-mark { width: 28px; height: 28px; border-radius: 9px; display: flex; align-items: center;
          justify-content: center; flex-shrink: 0; background: rgba(52,211,153,.20); color: #6ee7b7; }
        .chip-mark.alt { background: rgba(147,197,253,.18); color: #93c5fd; }
        .chip-mark svg { width: 15px; height: 15px; }
        .chip-text { display: flex; flex-direction: column; line-height: 1.25; }
        .chip-text b { font-size: 12.5px; font-weight: 600; letter-spacing: -.01em; }
        .chip-text small { font-size: 10.5px; color: rgba(255,255,255,.60); margin-top: 2px; }

        @keyframes dealIn { from { opacity: 0; transform: translateY(20px) scale(.965); } to { opacity: 1; transform: none; } }
        @keyframes bobA { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
        @keyframes bobB { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(7px); } }

        .stage-foot { max-width: 440px; padding-top: 8px; }
        .stage-foot h2 { font-family: var(--font-heading); font-size: clamp(22px, 1.95vw, 29px);
          font-weight: 650; letter-spacing: -.035em; line-height: 1.22; margin: 0 0 14px;
          text-wrap: balance; animation: riseIn .75s cubic-bezier(.22,1,.36,1) .50s both; }
        .stage-lines { position: relative; height: 24px; animation: riseIn .75s cubic-bezier(.22,1,.36,1) .58s both; }
        .stage-line { position: absolute; inset: 0; display: flex; align-items: center; gap: 10px;
          font-size: 13.5px; color: rgba(255,255,255,.78); opacity: 0;
          transition: opacity .55s ease, transform .55s cubic-bezier(.22,1,.36,1); transform: translateY(6px); }
        .stage-line.on { opacity: 1; transform: none; }
        .stage-line::before { content: ""; width: 6px; height: 6px; border-radius: 50%;
          background: #c7d2fe; flex-shrink: 0; box-shadow: 0 0 0 3px rgba(199,210,254,.18); }
        .stage-top { animation: riseIn .7s cubic-bezier(.22,1,.36,1) .06s both; }
        @keyframes riseIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

        /* ---- form panel (right) --------------------------------------- */
        .panel { position: relative; display: grid; grid-template-rows: 1fr auto;
          align-items: center; justify-items: center; padding: 40px 32px 0; background: var(--surface); }
        .panel::before { content: ""; position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(48% 38% at 88% 4%, var(--accent-light), transparent 70%),
            radial-gradient(40% 34% at 4% 96%, var(--accent-light), transparent 72%);
          opacity: .55; }
        .panel > * { position: relative; z-index: 1; }
        .panel-foot { padding: 26px 0 22px; font-size: 11.5px; color: var(--muted-2);
          display: flex; align-items: center; gap: 14px; animation: riseIn .7s cubic-bezier(.22,1,.36,1) .46s both; }
        .panel-foot span { opacity: .62; }
        .card { width: 100%; max-width: 408px; }
        .card > * { animation: riseIn .68s cubic-bezier(.22,1,.36,1) var(--d, 0s) both; }
        .card-brand { display: none; margin-bottom: 26px; --d: .04s; }
        .card h1 { font-family: var(--font-heading); font-size: 28px; font-weight: 700;
          letter-spacing: -.035em; line-height: 1.2; margin: 0; color: var(--text); --d: .10s; }
        .card-sub { font-size: 14px; color: var(--muted); margin: 9px 0 0; line-height: 1.55; --d: .16s; }

        .google-btn { display: flex; align-items: center; justify-content: center; gap: 10px;
          width: 100%; padding: 12px; margin-top: 26px; border-radius: 11px; --d: .22s;
          background: var(--surface); color: var(--text); border: 1px solid var(--border-strong, var(--border));
          font-size: 14px; font-weight: 550; font-family: inherit; cursor: pointer; text-decoration: none;
          transition: background .18s, border-color .18s, transform .16s cubic-bezier(.22,1,.36,1), box-shadow .18s; }
        .google-btn:hover { background: var(--surface-2); transform: translateY(-1px); box-shadow: var(--shadow-md); }
        .google-btn:active { transform: translateY(0) scale(.99); }
        .google-btn svg { width: 17px; height: 17px; flex-shrink: 0; }

        .auth-or { display: flex; align-items: center; gap: 13px; margin: 22px 0 4px; --d: .26s;
          color: var(--muted-2); font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }
        .auth-or::before, .auth-or::after { content: ""; flex: 1; height: 1px; background: var(--border); }

        form { --d: .30s; }
        form label { display: block; font-size: 12.5px; font-weight: 550; color: var(--text);
          margin: 18px 0 7px; letter-spacing: -.005em; }
        form input { width: 100%; padding: 12px 13px; font-size: 14.5px; font-family: inherit;
          color: var(--text); background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 11px; transition: border-color .18s, box-shadow .18s, background .18s; }
        form input::placeholder { color: var(--muted-2); }
        form input:hover { border-color: var(--border-strong, var(--muted-2)); }
        form input:focus { outline: none; background: var(--surface);
          border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-light); }

        .business-type-choice { display: grid; gap: 9px; margin-top: 2px; }
        .business-type-option { display: flex; align-items: center; gap: 10px; margin: 0;
          padding: 13px 14px; font-size: 13.5px; font-weight: 500; color: var(--text);
          background: var(--surface-2); border: 1px solid var(--border); border-radius: 11px; cursor: pointer;
          transition: border-color .18s, background .18s, box-shadow .18s; }
        .business-type-option:hover { border-color: var(--muted-2); }
        .business-type-option input { width: auto; margin: 0; accent-color: var(--accent); flex-shrink: 0; }
        .business-type-option:has(input:checked) { border-color: var(--accent);
          background: var(--accent-light); box-shadow: 0 0 0 1px var(--accent) inset; }

        .submit-btn { position: relative; overflow: hidden; width: 100%; margin-top: 26px;
          padding: 13px; border: none; border-radius: 11px; cursor: pointer;
          background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff;
          font-family: inherit; font-size: 14.5px; font-weight: 600; letter-spacing: -.005em;
          box-shadow: 0 6px 18px var(--accent-shadow);
          transition: transform .16s cubic-bezier(.22,1,.36,1), box-shadow .2s; }
        .submit-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 26px var(--accent-shadow-strong); }
        .submit-btn:active { transform: translateY(0) scale(.99); }
        /* A single pass of light across the button on hover -- one gesture,
           not a looping shimmer that would read as a loading state. */
        .submit-btn::after { content: ""; position: absolute; top: 0; bottom: 0; width: 42%;
          left: -50%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.26), transparent);
          transform: skewX(-18deg); transition: left .6s cubic-bezier(.4,0,.2,1); }
        .submit-btn:hover::after { left: 120%; }
        .submit-btn.busy { pointer-events: none; opacity: .82; }
        .submit-btn.busy .btn-label { visibility: hidden; }
        .submit-btn .btn-spin { position: absolute; inset: 0; margin: auto; width: 17px; height: 17px;
          border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
          display: none; animation: spin .7s linear infinite; }
        .submit-btn.busy .btn-spin { display: block; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .auth-error { display: flex; align-items: flex-start; gap: 9px; --d: .08s;
          background: var(--danger-bg); color: var(--danger); padding: 11px 13px;
          border: 1px solid var(--danger); border-radius: 11px; font-size: 13px; line-height: 1.45;
          margin-top: 20px; }
        .auth-error svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 1px; }

        .auth-footer { font-size: 13.5px; color: var(--muted); margin-top: 24px; text-align: center; --d: .36s; }
        .auth-footer a { color: var(--accent); font-weight: 600; text-decoration: none;
          border-bottom: 1px solid transparent; transition: border-color .18s; }
        .auth-footer a:hover { border-bottom-color: var(--accent); }
        .auth-legal { font-size: 11.5px; color: var(--muted-2); margin-top: 26px; text-align: center;
          line-height: 1.6; --d: .40s; }

        :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
        :focus:not(:focus-visible) { outline: none; }

        /* ---- narrow --------------------------------------------------
           Below 980 the stage stops being a column and becomes a short
           banner: the scene needs real width to read, and half a scene is
           worse than none. Below 620 it goes entirely and the brand mark
           moves into the card, so the form gets the whole screen. */
        @media (max-width: 980px) {
          .shell { grid-template-columns: 1fr; }
          .stage { min-height: 210px; padding: 22px 24px 24px; justify-content: space-between; }
          .stage-scene { display: none; }
          .stage-foot h2 { font-size: 21px; }
          .panel { padding: 34px 24px 44px; }
        }
        @media (max-width: 620px) {
          /* The scene needs width to read, so on a phone it goes and the
             brand band carries the identity instead -- 96px of the gradient
             rather than a cropped, unreadable half-scene. */
          /* 220px of gradient was a quarter of a phone screen given to
             decoration. A 112px band is enough to carry the brand. */
          .stage { min-height: 112px; padding: 0 20px; justify-content: center; }
          .stage-foot, .stage-scene { display: none; }
          .panel { align-items: center; padding: 34px 20px 40px; }
          .card h1 { font-size: 25px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .stage-glow, .scene-thread, .scene-chip, .st-typing i, .pre-mark, .pre-bar i { animation: none !important; }
          .scene-thread, .scene-chip { opacity: 1; transform: none; }
          .card > *, .stage-top, .stage-foot h2, .stage-lines { animation: none !important; opacity: 1; transform: none; }
          .submit-btn::after { display: none; }
          .google-btn:hover, .submit-btn:hover { transform: none; }
        }
      </style>
    </head>
    <body>
      <div class="pre" id="pre">
        <div class="pre-mark">S</div>
        <div class="pre-bar"><i></i></div>
      </div>
      <main class="shell">
        <section class="stage">
          <div class="stage-glow"></div>
          <div class="stage-weave"></div>
          <div class="stage-grain"></div>
          <div class="stage-top">${brandMark({ dark: true })}</div>
          <div class="stage-scene">${scene}</div>
          <div class="stage-foot">
            <h2>Your shop keeps selling while you sleep.</h2>
            <div class="stage-lines" id="lines">
              <div class="stage-line on">Answers from your own catalogue, never a guess</div>
              <div class="stage-line">Takes the order and confirms the payment</div>
              <div class="stage-line">Hands the chat to you the moment it matters</div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="card">
            <div class="card-brand">${brandMark()}</div>
            <h1>${escapeHtmlServer(heading)}</h1>
            <p class="card-sub">${escapeHtmlServer(sub || (isSignup ? "Set up your assistant in a couple of minutes. No card needed." : "Welcome back. Pick up where you left off."))}</p>
            ${error ? `<div class="auth-error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M12 7.6v5.2"/><path d="M12 16.3h.01"/></svg><span>${escapeHtmlServer(error)}</span></div>` : ""}
            ${googleAuthEnabled() ? `
              <a class="google-btn" href="/auth/google${isSignup ? "?mode=signup" : ""}">
                <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                Continue with Google
              </a>
              <div class="auth-or">or</div>
            ` : ""}
            <form method="POST" id="authForm">
              ${formHtml}
              <button type="submit" class="submit-btn" id="authSubmit">
                <span class="btn-label">${escapeHtmlServer(isSignup ? "Create account" : "Log in")}</span>
                <span class="btn-spin"></span>
              </button>
            </form>
            ${
              isSignup
                ? '<div class="auth-footer">Already have an account? <a href="/login">Log in</a></div>'
                : '<div class="auth-footer">New seller? <a href="/signup">Create an account</a></div>'
            }
            ${isSignup ? '<div class="auth-legal">By creating an account you agree to our terms and privacy policy.</div>' : ""}
          </div>
          <div class="panel-foot">
            <span>Stafly.AI</span>
            <span>&middot;</span>
            <span>WhatsApp sales, answered for you</span>
          </div>
        </section>
      </main>
      <script>
        (function () {
          var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

          // Preloader: dismissed on load, and unconditionally after 1.1s so a
          // slow font or a blocked request can never leave someone staring at it.
          var pre = document.getElementById("pre");
          var t0 = Date.now();
          function dropPre() {
            if (!pre || pre.classList.contains("done")) return;
            var wait = reduce ? 0 : Math.max(0, 420 - (Date.now() - t0));
            setTimeout(function () { pre.classList.add("done"); }, wait);
          }
          if (document.readyState === "complete") dropPre();
          else window.addEventListener("load", dropPre);
          setTimeout(dropPre, 1100);

          // The three lines are real capabilities, not testimonials.
          var lines = document.getElementById("lines");
          if (lines && !reduce) {
            var items = lines.querySelectorAll(".stage-line");
            var i = 0;
            setInterval(function () {
              items[i].classList.remove("on");
              i = (i + 1) % items.length;
              items[i].classList.add("on");
            }, 3800);
          }

          // A real pending state on submit, so a slow network does not look
          // like a dead button and cannot be double-submitted.
          var form = document.getElementById("authForm");
          var btn = document.getElementById("authSubmit");
          if (form && btn) {
            form.addEventListener("submit", function () {
              if (!form.checkValidity || form.checkValidity()) btn.classList.add("busy");
            });
          }

          var first = document.querySelector("form input");
          if (first && window.innerWidth > 980) setTimeout(function () { first.focus(); }, 700);
        })();
      </script>
    </body>
    </html>
  `;
}

// The login and signup fields, built in one place each. These were four
// near-identical copies across the GET routes and the POST-failure
// re-renders, which is exactly how a placeholder or an autocomplete hint
// ends up on one of them and not the others.
function loginFieldsHtml(email = "") {
  return `
        <label for="liEmail">Email</label>
        <input id="liEmail" type="email" name="email" required maxlength="200" autocomplete="email" placeholder="you@yourshop.com" value="${escapeHtmlServer(email)}">
        <label for="liPass">Password</label>
        <input id="liPass" type="password" name="password" required maxlength="200" autocomplete="current-password" placeholder="Your password">
  `;
}

function signupFieldsHtml({ businessName = "", email = "", businessType = "" } = {}) {
  return `
        <label for="suName">Business name</label>
        <input id="suName" name="businessName" required maxlength="120" autocomplete="organization" placeholder="KP Collections" value="${escapeHtmlServer(businessName)}">
        <label for="suEmail">Email</label>
        <input id="suEmail" type="email" name="email" required maxlength="200" autocomplete="email" placeholder="you@yourshop.com" value="${escapeHtmlServer(email)}">
        <label for="suPass">Password</label>
        <input id="suPass" type="password" name="password" required minlength="8" maxlength="200" autocomplete="new-password" placeholder="At least 8 characters">
        ${businessTypeFieldHtml(businessType)}
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

// ---------- SIGN IN WITH GOOGLE ----------
// Most sellers already have a Gmail address, and asking them to invent and
// remember another password is the kind of friction that loses a signup.
//
// This is off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set, and
// the button is simply not rendered when it is off -- a sign-in button that
// leads to an error page is worse than no button at all.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function googleAuthEnabled() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}
function googleRedirectUri() {
  return `${BASE_URL}/auth/google/callback`;
}

// The state parameter is what stops a third party from feeding us a code of
// their own choosing (a login-CSRF). It's signed with the same secret as the
// session cookie and carries its own five-minute expiry, so nothing has to be
// stored server-side between the two requests.
function signOAuthState(mode) {
  const payload = `${mode}.${Date.now() + 5 * 60 * 1000}.${crypto.randomBytes(8).toString("hex")}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifyOAuthState(state) {
  if (!state) return null;
  const parts = String(state).split(".");
  if (parts.length !== 4) return null;
  const [mode, expires, nonce, sig] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`${mode}.${expires}.${nonce}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expires)) return null;
  return mode;
}

app.get("/auth/google", (req, res) => {
  if (!googleAuthEnabled()) return res.redirect("/login");
  const mode = req.query.mode === "signup" ? "signup" : "login";
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state: signOAuthState(mode),
    // We only ever need the email once, at sign-in, so there is no refresh
    // token to store and nothing to keep in sync afterwards.
    access_type: "online",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!googleAuthEnabled()) return res.redirect("/login");

  const authFail = (message) =>
    res.status(400).send(authPageHtml({
      title: "Log in",
      heading: "Log in to Stafly.AI",
      error: message,
      formHtml: loginFieldsHtml(),
    }));

  const mode = verifyOAuthState(req.query.state);
  if (!mode) return authFail("That sign-in link has expired. Please try again.");
  if (req.query.error || !req.query.code) return authFail("Google sign-in was cancelled.");

  let profile;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }).toString(),
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) {
      console.error("google token exchange failed:", token.error_description || token.error || tokenRes.status);
      return authFail("Could not complete Google sign-in. Please try again.");
    }
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    profile = await infoRes.json();
    if (!infoRes.ok || !profile.email) {
      console.error("google userinfo failed:", infoRes.status);
      return authFail("Could not read your Google account. Please try again.");
    }
  } catch (err) {
    console.error("google oauth failed:", err.message);
    return authFail("Could not reach Google just now. Please try again.");
  }

  // An unverified Google email could belong to someone else, and this is the
  // key an account is found by -- so it is not good enough to sign in with.
  if (profile.email_verified === false) {
    return authFail("That Google account's email isn't verified, so it can't be used to sign in.");
  }

  const email = String(profile.email).trim().toLowerCase();
  try {
    let seller = await getSellerByEmail(email);
    if (!seller) {
      if (mode === "login") {
        return authFail("No Stafly account uses that Google address yet. Create one first.");
      }
      // A Google signup has no password, and must never get a guessable one.
      // A long random value is hashed and stored so the shape of the record
      // stays identical to a password account, while being impossible to
      // sign in with through the password form.
      const placeholder = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
      const sellerId = await createSeller({
        businessName: String(profile.name || email.split("@")[0]).trim().slice(0, 120),
        email,
        passwordHash: placeholder,
        // Google tells us nothing about what the seller sells, so this stays
        // at the default and they can change it in Settings. Guessing here
        // would silently put a hairdresser on the products path.
        businessType: "goods",
      });
      await updateSellerRecord(sellerId, { authProvider: "google" });
      seller = await getSellerById(sellerId);
    }
    res.cookie("session", signSession(seller.sellerId), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    invalidateSellerContextCache(seller.sellerId);
    return res.redirect("/dashboard");
  } catch (err) {
    console.error("google sign-in failed:", err.message);
    return authFail("Something went wrong signing you in. Please try again.");
  }
});

app.get("/signup", (req, res) => {
  res.send(
    authPageHtml({
      title: "Sign up",
      heading: "Create your seller account",
      formHtml: signupFieldsHtml(),
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
        formHtml: signupFieldsHtml({ businessName, email, businessType }),
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
      formHtml: loginFieldsHtml(),
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
        formHtml: loginFieldsHtml(email),
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
      ${BRAND_FONT_LINKS}
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

  const totalCount = customers.length;
  const activeCount = customers.filter((c) => c.paused !== "yes").length;
  const pausedCount = customers.filter((c) => c.paused === "yes").length;
  const paidCount = customers.filter((c) => c.last_payment_at).length;

  const rows = customers
    .map((c) => {
      const pausedBadge =
        c.paused === "yes"
          ? '<span class="badge paused">Paused</span>'
          : '<span class="badge active">Active</span>';
      const paidBadge = c.last_payment_at
        ? `<span class="badge paid">N${Number(c.last_payment_amount || 0).toLocaleString()}</span>`
        : "";
      const statusDotCls = c.paused === "yes" ? "paused" : "active";
      return `<tr>
        <td data-label="Phone" class="cell-primary">
          <div class="phone-cell">
            <span class="row-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span class="status-dot ${statusDotCls}"></span></span>
            <span class="phone-num">${escapeHtmlServer(c.phone || "")}</span>
          </div>
        </td>
        <td data-label="Status">${pausedBadge}</td>
        <td data-label="First contact">${c.first_contact ? new Date(c.first_contact).toLocaleString() : "&mdash;"}</td>
        <td data-label="Last contact">${c.last_contact ? new Date(c.last_contact).toLocaleString() : "&mdash;"}</td>
        <td data-label="Messages">${c.message_count || 0}</td>
        <td data-label="Last escalation">${c.last_escalation_reason ? escapeHtmlServer(c.last_escalation_reason) : "&mdash;"}</td>
        <td data-label="Escalated at">${c.last_escalation_at ? new Date(c.last_escalation_at).toLocaleString() : "&mdash;"}</td>
        <td data-label="Last payment">${paidBadge || "&mdash;"}</td>
        <td data-label="Paid at">${c.last_payment_at ? new Date(c.last_payment_at).toLocaleString() : "&mdash;"}</td>
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
      ${BRAND_FONT_LINKS}
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; }
        body { font-family: var(--font-sans); margin: 0; background: var(--bg); color: var(--text); }
        header { background: var(--navy); color: white; padding: 18px 28px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
        header .sub { font-size: 12px; color: rgba(255,255,255,0.65); margin-top:3px; }
        header a { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: white; border-radius:8px; font-size:12.5px; font-weight:600; text-decoration:none; box-shadow: 0 2px 6px var(--accent-shadow); transition: transform .15s ease, box-shadow .15s ease; }
        header a:hover { transform: translateY(-1px); box-shadow: 0 4px 10px var(--accent-shadow-strong); }
        .wrap { max-width: 1160px; margin: 28px auto 48px; padding: 0 24px; }
        .stats-bar { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
        .stat-tile { flex: 1; min-width: 150px; background: white; border: 1px solid var(--border); border-radius: 14px; padding: 14px 18px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); transition: transform .15s ease, box-shadow .15s ease; }
        .stat-tile:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(15,23,42,0.09); }
        .stat-tile .stat-value { font-family: var(--font-heading); font-size: 22px; font-weight: 700; color: var(--navy); line-height: 1.1; }
        .stat-tile .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
        .table-card { background: white; border-radius: 14px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(15,23,42,0.04); overflow: hidden; }
        .table-scroll { overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; min-width: 920px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border-light); font-size: 13px; white-space: nowrap; }
        th { background: #f8fafc; color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; }
        tbody tr { transition: background .15s; }
        tbody tr:hover { background: #fafafe; }
        tbody tr:last-child td { border-bottom: none; }

  /* Tables become stacked cards below 760px. Each cell keeps its column
     name via data-label, so nothing has to be remembered from a header
     that has scrolled off -- and no horizontal scrolling on a phone. */
  @media (max-width: 760px) {
    table { min-width: 0 !important; width: 100%; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    tbody tr { display: block; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; padding: 10px 12px; background: var(--surface, #fff); }
    tbody tr:hover { background: var(--surface, #fff); }
    tbody td { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 6px 0; border-bottom: 1px solid var(--border-light); white-space: normal; text-align: right; }
    tbody td:last-child { border-bottom: none; }
    tbody td::before { content: attr(data-label); font-size: 11.5px; font-weight: 600; color: var(--muted); text-align: left; flex-shrink: 0; }
    tbody td.cell-primary { display: block; text-align: left; font-size: 15px; font-weight: 600; padding-top: 2px; }
    tbody td.cell-primary::before { display: block; margin-bottom: 4px; }
    tbody td.cell-actions { display: block; text-align: left; }
    tbody td.cell-actions::before { display: block; margin-bottom: 6px; }
    .table-card, .wrap > table { overflow: visible; }
  }

        .phone-cell { display: flex; align-items: center; gap: 10px; }
        .row-avatar { position: relative; width: 30px; height: 30px; border-radius: 50%; background: var(--accent-light); color: var(--accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .row-avatar svg { width: 14px; height: 14px; }
        .row-avatar .status-dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid white; }
        .status-dot.active { background: var(--success); }
        .status-dot.paused { background: var(--warning); }
        .phone-num { font-weight: 600; font-size: 13.5px; }
        .badge { display:inline-block; font-size:11px; padding:2px 9px; border-radius:999px; white-space:nowrap; font-weight:600; }
        .badge.paused { background: var(--warning-bg); color: var(--warning); }
        .badge.active { background: var(--success-bg); color: var(--success); }
        .badge.paid { background: #dbeafe; color: #1d4ed8; }
        .empty-note { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 56px 24px; color: var(--muted); text-align: center; }
        .empty-note .empty-icon { width: 52px; height: 52px; border-radius: 16px; background: var(--accent-light); color: var(--accent); display: flex; align-items: center; justify-content: center; }
        .empty-note .empty-icon svg { width: 24px; height: 24px; }
        .empty-note .empty-title { font-family: var(--font-heading); font-size: 14px; font-weight: 600; color: var(--navy); }
        .empty-note .empty-sub { font-size: 12.5px; max-width: 260px; line-height: 1.5; }
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
        <div class="stats-bar">
          <div class="stat-tile"><div class="stat-value">${totalCount}</div><div class="stat-label">Total customers</div></div>
          <div class="stat-tile"><div class="stat-value">${activeCount}</div><div class="stat-label">Active</div></div>
          <div class="stat-tile"><div class="stat-value">${pausedCount}</div><div class="stat-label">Paused</div></div>
          <div class="stat-tile"><div class="stat-value">${paidCount}</div><div class="stat-label">Have paid</div></div>
        </div>
        <div class="table-card">
          ${
            customers.length === 0
              ? '<div class="empty-note"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div class="empty-title">No customers yet</div><div class="empty-sub">Once someone messages your WhatsApp number, they’ll show up here.</div></div>'
              : `<div class="table-scroll"><table>
            <thead><tr>
              <th>Phone</th><th>Status</th><th>First contact</th><th>Last contact</th>
              <th>Messages</th><th>Last escalation</th><th>Escalated at</th>
              <th>Last payment</th><th>Paid at</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
          }
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
        <td data-label="Business" class="cell-primary">${escapeHtmlServer(s.businessName || "")}${isSeller1 ? ' <span class="you-badge">your shop</span>' : ""}</td>
        <td data-label="Email">${escapeHtmlServer(s.email || "")}</td>
        <td data-label="Status">${statusBadge}${suspendedBadge}</td>
        <td data-label="Actions" class="cell-actions">
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
      ${BRAND_FONT_LINKS}
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
        /* Same stacked-card treatment as /customers, so the seller list is
           usable on a phone instead of clipping its own columns. */
        @media (max-width: 760px) {
          .wrap { margin: 20px auto; padding: 0 14px; }
          table { background: transparent; box-shadow: none; }
          thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
          tbody tr { display: block; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; padding: 10px 12px; background: #fff; }
          tbody td { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 6px 0; border-bottom: 1px solid var(--border-light); text-align: right; }
          tbody td:last-child { border-bottom: none; }
          tbody td::before { content: attr(data-label); font-size: 11.5px; font-weight: 600; color: var(--muted); text-align: left; flex-shrink: 0; }
          tbody td.cell-primary, tbody td.cell-actions { display: block; text-align: left; }
          tbody td.cell-primary { font-size: 15px; font-weight: 600; }
          tbody td.cell-primary::before, tbody td.cell-actions::before { display: block; margin-bottom: 5px; }
          a.btn, button.btn { display: inline-flex; align-items: center; justify-content: center; }
        }
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
        .empty-note { padding:24px; text-align:center; color:var(--muted-2); font-size:13px; }
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

function dashboardHtml(key, sellerId, businessName, businessType, connection) {
  const isBookable = businessType === "bookable";
  // Real connection state off the seller record -- Amara genuinely cannot
  // send or receive until both of these exist, so this is a fact worth
  // showing rather than a reassuring badge.
  const whatsappConnected = !!(connection && connection.phoneNumberId && connection.whatsappToken);
  const ownerAlertNumber = (connection && connection.ownerPhoneNumber) || "";
  // The admin key (and, when viewing a seller other than seller1, that
  // seller's id) gets embedded into the page's own JS so its fetch calls
  // can authenticate, same trust boundary as the ?key= on the page itself
  // — anyone who could load this page already has the key.
  return `
    <html>
    <head>
      <title>Stafly.AI — Dashboard</title>
      <!-- interactive-widget=resizes-content is the part that matters for the
           on-screen keyboard. Without it Android Chrome keeps the layout
           viewport at full height and simply lets the keyboard cover the
           bottom of it, which makes the whole page scrollable: the composer
           could be dragged up and away, and the header scrolled off. With it
           the layout viewport itself shrinks, so the app is laid out inside
           the space that is actually visible. -->
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
      <!-- Installed to a phone's home screen this opens with no browser
           chrome at all, which is the only real "full screen" iOS allows --
           the Fullscreen API below covers Android and desktop. -->
      <link rel="manifest" href="/manifest.webmanifest">
      <link rel="icon" href="/icon.svg" type="image/svg+xml">
      <link rel="apple-touch-icon" href="/icon.svg">
      <meta name="mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
      <meta name="apple-mobile-web-app-title" content="Stafly.AI">
      <meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
      <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
      <script>
        // Runs before any CSS paints, so a dark-mode user never sees a white
        // flash on load. Falls back to the OS setting until they pick one.
        (function () {
          try {
            var saved = localStorage.getItem("stafly-theme");
            var dark = saved ? saved === "dark"
              : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
            if (dark) document.documentElement.setAttribute("data-theme", "dark");
          } catch (e) { /* private mode / storage blocked: stay on light */ }
        })();
      </script>
      ${BRAND_FONT_LINKS}
      <style>
        ${BRAND_TOKENS_CSS}
        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body { font-family: var(--font-sans); margin: 0; background: var(--bg); color: var(--text); }
        /* A real left sidebar now, not just a row of pill buttons in the
           header -- the single biggest thing separating "a page with
           some buttons on it" from "a proper SaaS product," per the
           StackAdmin reference. Structurally: a fixed dark sidebar
           (brand, nav, footer links) beside a flex-1 main column (light
           topbar, stats, then whichever view is active) -- both full
           height, neither one hardcoding the other's size, so nothing
           here is fragile to header height the way the old single-row
           layout was. */
        /* 100dvh, not 100vh: on a phone 100vh is the viewport WITHOUT the
           browser's collapsible URL bar, so a full-height app renders taller
           than the screen and the composer ends up below the fold. dvh
           tracks the real visible height (and shrinks when the keyboard
           opens). 100vh stays first as the fallback for old browsers. */
        .app-shell { display: flex; flex-direction: row; height: 100vh; height: 100dvh; }
        /* Depth from a very slight top-to-bottom lift and a hairline edge --
           an accent glow was tried here and removed: on a rail this narrow it
           reads as a coloured blob rather than lighting. */
        .sidebar { position: relative; width: 232px; flex-shrink: 0; background: linear-gradient(180deg, #202b40 0%, var(--navy) 55%); display: flex; flex-direction: column; height: 100vh; height: 100dvh; border-right: 1px solid rgba(255,255,255,0.07); }
        .sidebar-brand { padding: 20px 20px 16px; }
        .sidebar-section-label { padding: 14px 20px 7px; font-size: 11.5px; font-weight: 600; letter-spacing: 0; color: rgba(255,255,255,0.42); }
        .main-column { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100vh; height: 100dvh; min-height: 0; }
        .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; flex-shrink: 0; }
        .topbar-left { display: flex; align-items: center; gap: 11px; min-width: 0; }
        .topbar h1 { font-family: var(--font-heading); font-size: 17px; margin: 0; font-weight: 700; color: var(--text); letter-spacing: -0.015em; white-space: nowrap; }
        /* The business name was a grey "· Name" tacked onto the title; as its
           own chip it reads as "which shop you're looking at" instead of
           trailing punctuation. */
        .topbar-biz { display: inline-flex; align-items: center; gap: 6px; max-width: 230px; padding: 4px 11px 4px 9px; background: var(--accent-light); color: var(--accent); border: 1px solid var(--accent-soft); border-radius: 999px; font-size: 12px; font-weight: 600; }
        .topbar-biz svg { width: 13px; height: 13px; flex-shrink: 0; }
        .topbar-biz span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .topbar a { color: var(--accent); font-size: 12px; font-weight: 600; }
        .topbar-right { display: flex; align-items: center; gap: 12px; }
        .topbar-date-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--muted); white-space: nowrap; }
        .topbar-date-chip svg { width: 13px; height: 13px; flex-shrink: 0; }
        .theme-toggle { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background .15s, color .15s, border-color .15s, transform .25s ease; }
        .theme-toggle:hover { color: var(--accent); border-color: var(--accent); transform: rotate(18deg); }
        .theme-toggle svg { width: 16px; height: 16px; }
        .theme-toggle .theme-icon-moon { display: none; }
        [data-theme="dark"] .theme-toggle .theme-icon-sun { display: none; }
        [data-theme="dark"] .theme-toggle .theme-icon-moon { display: block; }
        .hamburger-btn { display: none; background: transparent; border: none; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; color: var(--text); flex-shrink: 0; }
        .hamburger-btn svg { width: 20px; height: 20px; }
        .hamburger-btn:hover { background: var(--border-light); }
        .sidebar-backdrop { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 29; }
        .sidebar-backdrop.open { display: block; }
        button.mobile-back-btn.icon-btn { display: none; }
        .topbar-avatar { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 14px; font-weight: 700; flex-shrink: 0; overflow: hidden; box-shadow: 0 0 0 3px var(--accent-light), 0 2px 6px var(--accent-shadow); }
        /* A real profile card at the top of the sidebar -- who's logged
           in and what kind of seller they are, using only real fields
           already passed into dashboardHtml (never fabricated). This is
           the piece that was missing between the bare logo and the nav
           links -- every reference dashboard has an identity anchor
           here, not just a wordmark. */
        /* The seller's own card, raised off the rail rather than sitting flat
           on it, which is what made the top of the sidebar feel empty. */
        .sidebar-profile { display: flex; align-items: center; gap: 10px; margin: 0 12px 6px; padding: 10px 11px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); }
        .sidebar-profile-avatar { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 15px; font-weight: 700; flex-shrink: 0; overflow: hidden; box-shadow: 0 3px 10px var(--accent-shadow); }
        /* Once a shop has a picture it should be the shop everywhere, not just
           on Home. The accent glow is dropped when a real photo is in place --
           a coloured halo behind someone's own photograph looks like a mistake. */
        .sidebar-profile-avatar img, .topbar-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .sidebar-profile-avatar.has-photo, .topbar-avatar.has-photo { background: var(--surface-3); box-shadow: none; }
        .sidebar-profile-name { font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: white; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sidebar-profile-role { font-size: 11px; color: rgba(255,255,255,0.45); margin-top: 1px; }
        /* An honest "yes, this is actually refreshing itself" cue -- the
           dashboard really does poll every few seconds (see setInterval
           near the bottom), so this isn't decoration pretending to be
           realtime, it's a label for something that's already true. */
        .live-indicator { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 600; letter-spacing: 0; color: #86efac; background: rgba(34,197,94,0.13); border: 1px solid rgba(34,197,94,0.24); padding: 5px 12px; border-radius: 999px; }
        .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); animation: liveDotPulse 2s infinite; flex-shrink: 0; }
        @keyframes liveDotPulse {
          0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
          70% { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
          100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
        }
        nav.tabs { display: flex; flex-direction: column; gap: 3px; padding: 4px 12px; }
        /* Each item keeps a fixed icon slot so the labels line up, and the
           active one is marked by a rail plus a soft tinted fill rather than
           a solid block of brand colour. */
        nav.tabs button { position: relative; display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; background: transparent; border: none; color: rgba(255,255,255,0.62); padding: 9px 12px; border-radius: 10px; font-size: 13.5px; font-weight: 500; cursor: pointer; transition: background .18s ease, color .18s ease, transform .18s ease; }
        nav.tabs button::before { content: ""; position: absolute; left: -12px; top: 50%; width: 3px; height: 0; border-radius: 0 3px 3px 0; background: #a5b4fc; transform: translateY(-50%); transition: height .22s cubic-bezier(.4,0,.2,1); }
        nav.tabs button .nav-icon { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(255,255,255,0.06); transition: background .18s ease, color .18s ease; }
        nav.tabs button svg { width: 15px; height: 15px; flex-shrink: 0; }
        nav.tabs button:hover { background: rgba(255,255,255,0.05); color: #fff; }
        nav.tabs button:hover .nav-icon { background: rgba(255,255,255,0.11); }
        nav.tabs button.active-tab { background: rgba(99,102,241,0.20); color: #fff; font-weight: 600; }
        nav.tabs button.active-tab::before { height: 20px; }
        nav.tabs button.active-tab .nav-icon { background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; box-shadow: 0 3px 10px var(--accent-shadow-strong); }
        .sidebar-footer { margin-top: auto; padding: 16px 12px 16px; display: flex; flex-direction: column; align-items: stretch; gap: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
        .sidebar-footer .live-indicator { margin: 0 8px 2px; align-self: flex-start; }
        .sidebar-footer-link { display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-radius: 8px; color: rgba(255,255,255,0.55); font-size: 12.5px; font-weight: 500; text-decoration: none; transition: background .15s, color .15s; }
        .sidebar-footer-link svg { width: 15px; height: 15px; flex-shrink: 0; }
        .sidebar-footer-link:hover { background: rgba(255,255,255,0.06); color: white; }
        /* stat tiles -- a light strip of its own between the topbar and
           the working area, each tile a small elevated card with an
           icon-in-a-circle, echoing the "Total Project Handled"-style
           tiles from the dashboard reference Miji shared, rather than
           the old cramped, same-color pills that all read as one blur. */
        .stat-tile { flex: 1; min-width: 190px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-shadow: var(--shadow-sm); transition: transform .15s ease, box-shadow .15s ease; }
        /* Each tile carries its own hue through one --tile/--tile-bg pair, so
           the four read as a balanced set instead of indigo twice plus two
           odd ones. Everything below is driven off those two variables. */
        .stat-tile { position: relative; overflow: hidden; --tile: var(--accent); --tile-bg: var(--accent-light); }
        .stat-tile.tile-total { --tile: var(--accent); --tile-bg: var(--accent-light); }
        .stat-tile.tile-active { --tile: var(--ok-fg); --tile-bg: var(--ok-bg); }
        .stat-tile.tile-paused { --tile: var(--warn-fg); --tile-bg: var(--warn-bg); }
        .stat-tile.tile-revenue { --tile: var(--info-fg); --tile-bg: var(--info-bg); }
        .stat-tile::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--tile); opacity: 0.85; }
        /* A soft wash of the tile's own hue behind the icon -- depth without
           another border or shadow. */
        .stat-tile::after { content: ""; position: absolute; right: -34px; top: -44px; width: 108px; height: 108px; border-radius: 50%; background: var(--tile-bg); opacity: 0.45; pointer-events: none; }
        .stat-tile > * { position: relative; z-index: 1; }
        .stat-tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); border-color: var(--tile); }
        .stat-tile .stat-value { font-family: var(--font-heading); font-size: 25px; font-weight: 700; color: var(--text); line-height: 1.1; white-space: nowrap; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
        .stat-tile .stat-label { font-size: 11.5px; color: var(--muted); margin-top: 5px; white-space: nowrap; font-weight: 500; }
        .stat-tile .stat-icon { width: 42px; height: 42px; border-radius: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--tile-bg); color: var(--tile); box-shadow: inset 0 0 0 1px var(--tile-bg); transition: transform .2s ease; }
        .stat-tile:hover .stat-icon { transform: scale(1.08) rotate(-4deg); }
        .stat-tile .stat-icon svg { width: 20px; height: 20px; }
        .layout { display: flex; flex: 1; min-height: 0; }
        .list-pane { width: 320px; border-right: 1px solid var(--border); background: var(--surface); flex-shrink: 0; display: flex; flex-direction: column; }
        .search-box { padding: 12px 12px 9px; }
        .search-box-inner { position: relative; display: flex; align-items: center; }
        .search-box-inner svg { position: absolute; left: 11px; width: 15px; height: 15px; color: var(--muted-2); pointer-events: none; }
        .search-box input { width: 100%; padding: 9px 12px 9px 34px; border: 1px solid var(--border); background: var(--surface-2); border-radius: 10px; font-size: 13px; font-family: inherit; color: var(--text); transition: background .15s, border-color .15s, box-shadow .15s; }
        .search-box input::placeholder { color: var(--muted-2); }
        .search-box input:focus { outline: none; background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        /* Real filters, not decoration -- All/Active/Paused/Starred each map
           to an actual stored field on the customer record (see setTab /
           getFilteredCustomers), the same idea as Fillow's inbox tabs but
           grounded in states this dashboard genuinely tracks. */
        /* Icon + count on every tab; the label spells itself out only on the
           one that's selected. You always see four filters and their sizes,
           but only one word at a time -- descriptive without four labels
           competing above a list that's already full of text. */
        .list-tabs { display: flex; gap: 3px; margin: 0 12px 10px; padding: 3px; background: var(--surface-3); border-radius: 11px; }
        .list-tab { flex: 0 1 auto; display: flex; align-items: center; justify-content: center; gap: 5px; background: transparent; border: none; padding: 7px 9px; font-size: 11.5px; font-weight: 600; color: var(--muted); border-radius: 9px; cursor: pointer; transition: background .18s ease, color .18s ease, box-shadow .18s ease; white-space: nowrap; min-width: 0; }
        .list-tab-icon { display: flex; flex-shrink: 0; }
        .list-tab-icon svg { width: 14px; height: 14px; }
        .list-tab-label { display: none; }
        .list-tab:hover { color: var(--text); background: var(--surface-2); }
        .list-tab.active-list-tab { flex: 1 1 auto; background: var(--surface); color: var(--text); box-shadow: var(--shadow-md); }
        .list-tab.active-list-tab .list-tab-label { display: inline; }
        .list-tab.active-list-tab .list-tab-icon { color: var(--accent); }
        .list-tab-count { font-size: 10px; font-weight: 700; line-height: 1.5; padding: 0 5px; border-radius: 999px; background: var(--border); color: var(--muted); min-width: 17px; text-align: center; }
        .list-tab.active-list-tab .list-tab-count { background: var(--accent-light); color: var(--accent); }
        .nav-badge { margin-left: auto; background: var(--danger); color: #fff; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; line-height: 1.5; flex-shrink: 0; }
        .list { flex: 1; overflow-y: auto; }
        /* The row you click to open a thread. The accent rail on the left is
           what makes "which conversation am I in" readable at a glance -- it
           grows in rather than snapping, and hover previews it faintly. */
        .list-item { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 13px 16px 13px 18px; border-bottom: 1px solid var(--border-light); cursor: pointer; transition: background .18s ease, padding-left .18s ease; }
        .list-item::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); transform: scaleY(0); transform-origin: center; transition: transform .22s cubic-bezier(.4,0,.2,1); }
        .list-item:hover { background: var(--surface-2); padding-left: 21px; }
        .list-item:hover::before { transform: scaleY(0.5); opacity: 0.45; }
        .list-item:active { background: var(--surface-3); }
        .list-item.active-row { background: var(--accent-light); padding-left: 21px; }
        .list-item.active-row::before { transform: scaleY(1); opacity: 1; }
        .list-item .list-avatar { transition: transform .2s ease; }
        .list-item:hover .list-avatar { transform: scale(1.06); }
        /* Rows stagger in when the list (re)renders, so switching a filter
           reads as the list rebuilding rather than snapping. */
        @keyframes rowIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
        .list-item.row-in { animation: rowIn .26s ease-out backwards; }
        @media (prefers-reduced-motion: reduce) {
          .list-item.row-in, .stat-tile.tile-in, .msg-row.bubble-in { animation: none; }
          .list-item, .list-item::before, .list-avatar, .stat-tile, .stat-icon { transition: none; }
        }
        .list-avatar { position: relative; width: 42px; height: 42px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; box-shadow: 0 1px 2px rgba(15,23,42,0.15); }
        .list-avatar svg { width: 22px; height: 22px; opacity: 0.95; }
        .list-avatar .status-dot { position: absolute; right: -1px; bottom: -1px; width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--surface); }
        .status-dot.active { background: var(--success); }
        .status-dot.paused { background: var(--warning); }
        .list-item-body { min-width: 0; flex: 1; }
        .list-item-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .list-item .phone { display: flex; align-items: center; gap: 5px; font-weight: 600; font-size: 13px; color: var(--text); letter-spacing: 0.1px; font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 0; overflow: hidden; }
        .row-time { font-size: 11px; color: var(--muted-2); white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        /* Second line: what was actually last said, one line, ellipsised --
           the thing that turns this from a table of counts into an inbox. */
        .list-item-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; }
        .row-preview { font-size: 12.5px; color: var(--muted); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
        .list-item.active-row .row-preview { color: var(--text); }
        .row-faint { color: var(--muted-2); }
        /* The escalation reason reads in the same muted tone as any other
           preview line -- only its little icon is coloured, so a busy list
           doesn't turn into a wall of amber sentences. */
        .row-escalation { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); min-width: 0; }
        .row-escalation svg { width: 12px; height: 12px; flex-shrink: 0; color: var(--warning); }
        .row-paid { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; color: var(--success); flex-shrink: 0; opacity: 0.85; }
        .row-paid svg { width: 11px; height: 11px; }
        .row-star { display: inline-flex; color: var(--star); flex-shrink: 0; }
        .row-star svg { width: 13px; height: 13px; }
        /* Status chips stay quiet: one small coloured dot carries the meaning,
           the label itself sits in ordinary text colour on a neutral pill.
           A row that needs a reply should read as informative, not as an
           alarm going off down the side of the screen. */
        .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 500; padding: 2px 8px 2px 7px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); line-height: 1.55; white-space: nowrap; flex-shrink: 0; }
        .badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
        .badge.paused { color: var(--muted); }
        .badge.paused::before { background: var(--warning); }
        .badge.active { color: var(--muted); }
        .badge.active::before { background: var(--success); }
        .badge.paid { color: var(--muted); }
        .badge.paid::before { background: var(--info-fg); }
        /* Refines the plain "Paused" badge for the one case that's actually
           actionable right now: paused AND the customer's last message
           still has no reply -- both real, stored facts (see
           last_message_role in saveConversation). */
        /* The one row state that's genuinely actionable gets a slightly
           firmer weight and a red dot -- still on the same neutral pill as
           everything else, so it reads as "this one" not "danger". */
        .badge.waiting { color: var(--text); font-weight: 600; }
        .badge.waiting::before { background: var(--danger); }
        .snippet { font-size: 12px; color: var(--muted); margin-top: 4px; }
        .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        /* Customer details column. Everything it shows is a field the
           dashboard genuinely stores -- see renderDetailPane. */
        /* Hidden unless the layout says otherwise -- one explicit state, so
           wide and narrow screens can't disagree about the default. */
        .detail-pane { display: none; width: 300px; flex-shrink: 0; border-left: 1px solid var(--border); background: var(--surface); overflow-y: auto; padding: 16px; flex-direction: column; gap: 12px; }
        .layout.details-on .detail-pane { display: flex; }
        .layout.details-on .detail-pane:empty { display: none; }
        .detail-head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 7px; padding: 4px 0 10px; border-bottom: 1px solid var(--border-light); }
        .detail-avatar { width: 56px; height: 56px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow-md); }
        .detail-avatar svg { width: 28px; height: 28px; opacity: 0.95; }
        .detail-phone { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
        .detail-card { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 13px; }
        .detail-card-title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
        .detail-card-title svg { width: 12px; height: 12px; color: var(--accent); flex-shrink: 0; }
        .detail-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 4px 0; }
        .detail-row + .detail-row { border-top: 1px solid var(--border-light); }
        .detail-label { font-size: 12.5px; color: var(--muted); }
        .detail-value { font-size: 12.5px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
        .detail-muted { font-size: 12px; color: var(--muted); line-height: 1.5; }
        .detail-amount { font-family: var(--font-heading); font-size: 22px; font-weight: 700; color: var(--ok-fg); letter-spacing: -0.02em; line-height: 1.15; }
        .detail-ref { font-size: 10.5px; color: var(--muted-2); margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .detail-card.paid-card { background: var(--ok-bg); border-color: var(--ok-border); }
        .detail-card.warn-card { background: var(--warn-bg); border-color: var(--warn-border); }
        .detail-card.warn-card .detail-card-title { color: var(--warn-fg); }
        .detail-pane textarea { width: 100%; min-height: 74px; padding: 9px 11px; border: 1.5px solid var(--border); border-radius: 10px; font-size: 12.5px; font-family: inherit; line-height: 1.45; resize: vertical; background: var(--surface); color: var(--text); transition: border-color .15s, box-shadow .15s; }
        .detail-pane textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .icon-btn.active-toggle { color: var(--accent); border-color: var(--accent); background: var(--accent-light); }
        .compose-hint { font-size: 11px; color: var(--muted-2); padding: 0 24px 12px; background: var(--surface); }
        .thread-header { padding: 11px 24px; border-bottom: 1px solid var(--border); background: var(--surface); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .thread-header-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .thread-avatar { position: relative; width: 40px; height: 40px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 1px 3px rgba(15,23,42,0.18); }
        .thread-avatar svg { width: 23px; height: 23px; opacity: 0.95; }
        .thread-avatar .status-dot { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; border: 2.5px solid var(--surface); }
        .thread-name { display: flex; align-items: center; gap: 6px; font-family: var(--font-heading); font-size: 16.5px; font-weight: 700; color: var(--text); letter-spacing: -0.015em; font-variant-numeric: tabular-nums; line-height: 1.25; min-width: 0; }
        .thread-num { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .detail-phone-sub { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-top: -3px; }
        /* Initials when the customer's WhatsApp name is known; the person
           mark stays for everyone else. */
        .avatar-initials { font-family: var(--font-heading); font-weight: 700; letter-spacing: 0.3px; }
        .list-avatar .avatar-initials { font-size: 14px; }
        .thread-avatar .avatar-initials { font-size: 15px; }
        .detail-avatar .avatar-initials { font-size: 19px; }
        .thread-star-mark { display: inline-flex; align-items: center; color: var(--star); flex-shrink: 0; }
        .thread-star-mark svg { width: 14px; height: 14px; }
        .lbl-short { display: none; }
        /* The status is one fact on a meta line, so it reads as text with a
           dot -- a bordered pill made it compete with the name above it. */
        .thread-id-text { min-width: 0; }
        .thread-meta { display: flex; align-items: center; gap: 0 9px; margin-top: 2px; min-width: 0; flex-wrap: nowrap; overflow: hidden; }
        .thread-meta > * { flex-shrink: 0; }
        .tm-phone { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .thread-meta > * + *::before { content: "·"; margin-right: 9px; color: var(--muted-2); }
        /* The thread column is narrow whenever the details pane is open, and
           that has nothing to do with the viewport width -- a 1440px screen
           with details showing leaves the header about 216px for a meta line
           that wants 267. Measured, not guessed. So the pane's own class is
           what drives this: the last-message time goes first, then the status
           falls back to its short wording, and the number truncates last
           because it is the identifier that matters. */
        .layout.details-on .thread-meta .thread-sub { display: none; }
        .layout.details-on .thread-meta .lbl-full { display: none; }
        .layout.details-on .thread-meta .lbl-short { display: inline; }
        .layout.details-on .tm-phone { flex-shrink: 1; }
        /* Below about 1200px the header actions alone leave the meta line
           around 100px even with the details pane closed, so the same
           degradation applies on width as well as on that class. */
        @media (max-width: 1200px) {
          .thread-meta .thread-sub { display: none; }
          .thread-meta .lbl-full { display: none; }
          .thread-meta .lbl-short { display: inline; }
          .tm-phone { flex-shrink: 1; }
        }
        .thread-status-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--ok-fg); white-space: nowrap; }
        .thread-status-chip.is-paused { color: var(--warn-fg); }
        .thread-status-chip .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
        .thread-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex-shrink: 1; }
        .thread-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .icon-btn { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s, color .15s, border-color .15s; flex-shrink: 0; }
        .icon-btn svg { width: 16px; height: 16px; }
        .icon-btn:hover { background: var(--surface-2); color: var(--text); }
        .icon-btn.starred, .icon-btn.starred:hover { color: var(--star); border-color: var(--warn-border); background: var(--warn-bg); }
        .more-menu { position: relative; }
        .more-menu-dropdown { display: none; position: absolute; right: 0; top: calc(100% + 6px); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 20px rgba(15,23,42,0.14); min-width: 190px; z-index: 20; overflow: hidden; }
        .more-menu-dropdown.open { display: block; }
        .more-menu-dropdown button { display: block; width: 100%; text-align: left; padding: 10px 14px; border: none; background: transparent; font-size: 13px; color: var(--text); cursor: pointer; font-family: inherit; }
        .more-menu-dropdown button:hover { background: var(--surface-2); }
        .more-menu-dropdown button.menu-danger { color: var(--danger); border-top: 1px solid var(--border-light); }
        .more-menu-dropdown button.menu-danger:hover { background: var(--dang-bg); }
        /* Only shown where the matching icon button has been hidden. */
        .more-menu-dropdown button.menu-sm-only { display: none; }
        /* A real chat surface rather than a blank page: a soft tinted base
           with a faint tiled pattern behind the bubbles, the thing that
           makes WhatsApp read as a conversation instead of a document.
           Inlined as a data URI (no external request) for the same
           reliability reason the fonts and Chart.js are self-hosted. */
        .thread { flex: 1; overflow-y: auto; padding: 16px 26px 20px; background-color: var(--chat-bg); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%23b9c6dc' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' opacity='0.26'%3E%3Ccircle cx='18' cy='22' r='4.5'/%3E%3Cpath d='M62 12v9M57.5 16.5h9'/%3E%3Cpath d='M96 30c3.5-4.5 8-4.5 11.5 0'/%3E%3Crect x='30' y='58' width='10' height='10' rx='3'/%3E%3Cpath d='M78 62l6 6-6 6-6-6z'/%3E%3Ccircle cx='104' cy='84' r='3.5'/%3E%3Cpath d='M14 92c4-5 9-5 13 0'/%3E%3Cpath d='M50 100v8M46 104h8'/%3E%3C/g%3E%3C/svg%3E"); }
        /* Same doodle tile, redrawn in a dark-friendly stroke -- a data URI
           can't read a CSS variable, so the dark theme swaps the whole image. */
        [data-theme="dark"] .thread { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%232b3446' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' opacity='0.55'%3E%3Ccircle cx='18' cy='22' r='4.5'/%3E%3Cpath d='M62 12v9M57.5 16.5h9'/%3E%3Cpath d='M96 30c3.5-4.5 8-4.5 11.5 0'/%3E%3Crect x='30' y='58' width='10' height='10' rx='3'/%3E%3Cpath d='M78 62l6 6-6 6-6-6z'/%3E%3Ccircle cx='104' cy='84' r='3.5'/%3E%3Cpath d='M14 92c4-5 9-5 13 0'/%3E%3Cpath d='M50 100v8M46 104h8'/%3E%3C/g%3E%3C/svg%3E"); }
        /* No per-message avatar. This is a one-to-one thread: the header
           already says who the customer is, and repeating a 26px chip plus a
           7px gap on every single row cost 33px of width on each side of a
           390px phone -- which is what made the bubbles look stranded in the
           middle of the screen. WhatsApp itself only shows avatars in group
           chats, for exactly this reason. Who wrote an outgoing message is
           now said in words on the bubble itself (see .bubble-by), which is
           information the avatar never actually carried. */
        .msg-row { display: flex; align-items: flex-end; margin-bottom: 2px; }
        .msg-row.group-end { margin-bottom: 10px; }
        .msg-row.from-assistant { justify-content: flex-end; }
        /* Shorter lines are easier to read and are what makes a thread look
           like a conversation rather than a document. */
        .bubble-col { display: flex; flex-direction: column; max-width: 66%; min-width: 0; }
        .msg-row.from-user .bubble-col { align-items: flex-start; }
        .msg-row.from-assistant .bubble-col { align-items: flex-end; }
        /* 14px is already WhatsApp's own message size -- what read as "big"
           was everything around it: a 1.45 line-height, 8px of vertical
           padding, a 14px radius and lines running to 68% of a wide screen.
           Tightened to WhatsApp's actual rhythm, the same words take about a
           fifth less vertical space at the same legibility. */
        .bubble { position: relative; padding: 7px 11px 8px 12px; font-size: 14.5px; line-height: 1.42; word-wrap: break-word; overflow-wrap: anywhere; border-radius: 12px; box-shadow: 0 1px 1px rgba(15,23,42,0.05), 0 1px 3px rgba(15,23,42,0.06); max-width: 100%; }
        .bubble-text { white-space: pre-wrap; }
        .bubble.user { background: var(--surface); color: var(--text); }
        .bubble.assistant { background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; }
        /* Only the last bubble of a group gets a real tail, pointing back at
           that side's avatar -- same rhythm WhatsApp uses. */
        .bubble.has-tail.user { border-bottom-left-radius: 4px; }
        .bubble.has-tail.assistant { border-bottom-right-radius: 4px; }
        .bubble.has-tail::after { content: ""; position: absolute; bottom: 0; width: 8px; height: 10px; }
        .bubble.has-tail.user::after { left: -6px; background: var(--surface); clip-path: polygon(100% 0, 100% 100%, 0 100%); }
        .bubble.has-tail.assistant::after { right: -6px; background: var(--accent-dark); clip-path: polygon(0 0, 0 100%, 100% 100%); }
        /* Who sent an outgoing message. Only ever rendered when the stored
           record actually says the owner typed it from the dashboard (the
           "by" field written by /api/send-message) -- an outgoing message
           without that field is left unlabelled rather than credited to
           Amara on a guess. */
        .bubble-by { float: right; font-size: 10px; line-height: 1; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; margin: 5px -1px -2px 9px; color: rgba(255,255,255,0.92); }
        .bubble-by + .bubble-time { margin-left: 5px; }
        /* Real per-message time -- only rendered when the stored message
           actually has one (see history.push's "at" field server-side).
           Older messages saved before this existed simply show no time,
           on purpose, rather than a guessed one. Floated so the message
           text wraps around it and it settles bottom-right in the bubble,
           exactly like WhatsApp, instead of adding another line of text. */
        .bubble-time { float: right; font-size: 10.5px; line-height: 1; margin: 6px -1px -2px 10px; opacity: 0.72; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .bubble.user .bubble-time { color: var(--muted-2); }
        .bubble.assistant .bubble-time { color: rgba(255,255,255,0.85); }
        .day-divider { display: flex; align-items: center; justify-content: center; margin: 14px 0; }
        .day-divider span { font-size: 11px; font-weight: 600; color: var(--muted); background: var(--surface); padding: 5px 14px; border-radius: 999px; box-shadow: var(--shadow-md); }
        button.takeover-btn { padding: 8px 16px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 5px rgba(15,23,42,0.12); transition: transform .15s ease; }
        button.takeover-btn:hover { transform: translateY(-1px); }
        button.takeover-btn.take { background: linear-gradient(135deg, #d97706, #b45309); color: white; }
        button.takeover-btn.hand { background: linear-gradient(135deg, #16a34a, #15803d); color: white; }
        .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 8px; color: var(--muted-2); font-size: 14px; padding: 24px; text-align: center; }
        .empty .empty-icon { width: 52px; height: 52px; border-radius: 16px; background: var(--accent-light); color: var(--accent); display: flex; align-items: center; justify-content: center; }
        .empty .empty-icon svg { width: 24px; height: 24px; }
        .empty .empty-title { font-size: 14px; font-weight: 600; color: var(--text); }
        .empty .empty-sub { font-size: 12px; color: var(--muted); max-width: 240px; line-height: 1.5; }
        .spinner { width: 26px; height: 26px; border-radius: 50%; border: 3px solid var(--accent-light); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        /* Stat tiles fade + rise into place once on the very first load
           only (renderStats() only passes the "tile-in" class the first
           time it ever runs -- see the statsAnimated flag) -- otherwise,
           since the whole bar re-renders every 5s poll, this would replay
           forever and read as a flicker instead of a one-time flourish. */
        /* One visible focus ring for keyboard users, everywhere. */
        /* The view transition itself lives in JS now (see playViewEnter) so it
           can restart without a forced reflow. The per-card stagger that used
           to sit here is gone deliberately: animating a dozen cards at once
           was a measurable part of the heaviness on a mid-range phone, and one
           clean movement of the whole view reads better than twelve competing
           ones anyway. */
        /* A press you can feel, on the nav and on every button-ish control. */
        nav.tabs button:active { transform: scale(0.975); }
        .list-tab:active, .cat-chip:active, .seg-control button:active,
        .catalog-btn:active, .btn-quiet:active, .icon-btn:active,
        .sidebar-footer-link:active, .swatch:active { transform: scale(0.96); }
        .sidebar-footer-link { transition: background .15s, color .15s, transform .12s ease; }
        .cat-chip, .swatch, .btn-quiet, .icon-btn { transition: background .15s, color .15s, border-color .15s, box-shadow .15s, transform .12s ease; }
        @media (prefers-reduced-motion: reduce) {
          nav.tabs button:active, .list-tab:active, .cat-chip:active, .seg-control button:active,
          .catalog-btn:active, .btn-quiet:active, .icon-btn:active, .sidebar-footer-link:active, .swatch:active { transform: none; }
        }
        /* Two separate things caused the box that flashed on click:
           the mobile tap highlight, and a focus ring left behind after a
           pointer click. Keyboard users still get a clear ring -- only
           pointer-driven focus is silenced. */
        * { -webkit-tap-highlight-color: transparent; }
        :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
        :focus:not(:focus-visible) { outline: none; }
        /* Skeleton rows while the first load is in flight -- the list keeps
           its real shape instead of collapsing to a spinner and jumping. */
        @keyframes shimmer { from { background-position: -200px 0; } to { background-position: calc(200px + 100%) 0; } }
        .skeleton-row { display: flex; align-items: flex-start; gap: 12px; padding: 13px 18px; border-bottom: 1px solid var(--border-light); }
        .sk { background: var(--surface-3); background-image: linear-gradient(90deg, transparent, var(--border-light), transparent); background-size: 200px 100%; background-repeat: no-repeat; animation: shimmer 1.2s ease-in-out infinite; border-radius: 6px; }
        .sk-avatar { width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0; }
        .sk-lines { flex: 1; display: flex; flex-direction: column; gap: 7px; padding-top: 3px; }
        .sk-line { height: 10px; }
        @media (prefers-reduced-motion: reduce) {
          .sk { animation: none; }
          /* The live dot pulses forever, so it is the one piece of motion that
             never stops on its own -- exactly the kind someone with reduced
             motion set has asked not to see. It keeps its colour, loses the
             pulse. */
          .live-dot, .pulse-dot { animation: none; }
          .inline-panel { animation: none; }
        }
        @keyframes tileIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .stat-tile.tile-in { animation: tileIn 0.4s ease-out backwards; }
        /* A newly arrived message lands from its own side, so you can see
           where it came from rather than it just appearing. */
        @keyframes bubbleInLeft { from { opacity: 0; transform: translateY(8px) translateX(-6px); } to { opacity: 1; transform: none; } }
        @keyframes bubbleInRight { from { opacity: 0; transform: translateY(8px) translateX(6px); } to { opacity: 1; transform: none; } }
        .msg-row.from-user.bubble-in { animation: bubbleInLeft .28s cubic-bezier(.4,0,.2,1) backwards; }
        .msg-row.from-assistant.bubble-in { animation: bubbleInRight .28s cubic-bezier(.4,0,.2,1) backwards; }
        /* scrollbar-gutter reserves the scrollbar's width whether or not a
           scrollbar is currently showing. Without it, moving from a tab whose
           content overflows to one that doesn't takes the scrollbar away, and
           because these views are centred, everything on the page slides
           sideways by its width on every switch. */
        .catalog-view { flex: 1; min-height: 0; padding: 24px; max-width: 800px; margin: 0 auto; overflow-y: auto; scrollbar-gutter: stable; width: 100%; }
        /* Analytics is the one view that is a dashboard rather than a form or
           a reading column, so it gets the room a dashboard needs. Capping it
           at the same 800px as Settings is what squeezed four KPI cards into
           172px each and made them read as one crowded strip. */
        .catalog-view#analyticsView { max-width: 1260px; padding: 24px 28px 30px; }
        .catalog-card { background: var(--surface); border-radius: 14px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border); box-shadow: var(--shadow-sm); transition: box-shadow .15s ease; }
        /* Settings is around 2650px of form. Revealing it laid the whole thing
           out in a single frame, which measured as a 57ms stall right as the
           view animated in. content-visibility lets the browser skip laying
           out the cards that are still below the fold; the intrinsic size
           keeps the scrollbar honest in the meantime. */
        .catalog-view > .catalog-card { content-visibility: auto; contain-intrinsic-size: auto 320px; }
        .catalog-card:hover { box-shadow: 0 4px 14px rgba(15,23,42,0.07); }
        .catalog-card h2 { font-family: var(--font-heading); font-size: 15px; margin: 0 0 14px; }
        table.catalog-table { width: 100%; border-collapse: collapse; }
        table.catalog-table th, table.catalog-table td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border-light); font-size: 13px; vertical-align: middle; }
        table.catalog-table th { color: var(--muted); font-weight: 600; font-size: 12px; background: var(--surface-2); }
        table.catalog-table th:first-child { border-top-left-radius: 8px; }
        table.catalog-table th:last-child { border-top-right-radius: 8px; }
        table.catalog-table tbody tr { transition: background .15s; }
        table.catalog-table tbody tr:hover { background: var(--surface-2); }
        table.catalog-table img { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; background: var(--border-light); }
        table.catalog-table td.booking-date-header { background: var(--surface-2); color: var(--muted); font-weight: 600; font-size: 12px; padding-top: 14px; border-bottom: 1px solid var(--border); }
        .catalog-form { display: grid; grid-template-columns: 1fr 1fr 1.4fr auto; gap: 8px; align-items: end; margin-top: 4px; }
        .catalog-form label { font-size: 12.5px; font-weight: 500; color: var(--text); display: block; margin-bottom: 5px; }
        .catalog-form input { width: 100%; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; background: var(--surface); color: var(--text); font-family: inherit; }
        .catalog-form input:focus, .catalog-form select:focus, .catalog-form textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .catalog-form textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; background: var(--surface); color: var(--text); }
        .catalog-form select { width: 100%; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); }
        /* Native widgets (date pickers, scrollbars, select arrows) follow this. */
        [data-theme="dark"] { color-scheme: dark; }
        .catalog-btn { background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: white; border: none; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; box-shadow: 0 2px 5px var(--accent-shadow); transition: box-shadow .15s, transform .15s; }
        .catalog-btn:hover { box-shadow: 0 4px 10px var(--accent-shadow-strong); transform: translateY(-1px); }
        .catalog-btn.danger { background: transparent; color: var(--danger); font-weight: 500; padding: 4px 8px; box-shadow: none; }
        .catalog-btn.small { padding: 6px 10px; font-size: 12px; }
        /* Toasts. Until now a save either silently worked or wrote a line of
           small grey text next to the form -- which is invisible if you are
           looking anywhere else on the page, and absent entirely on a phone
           where the form has scrolled. Every real save now says so. */
        .toast-stack { position: fixed; z-index: 200; right: 22px; bottom: 22px; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
        .toast { display: flex; align-items: flex-start; gap: 11px; min-width: 240px; max-width: 380px; padding: 13px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-lg); font-size: 13.5px; line-height: 1.45; color: var(--text); pointer-events: auto; }
        .toast-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
        .toast-icon svg { width: 12px; height: 12px; }
        .toast.ok .toast-icon { background: var(--ok-bg); color: var(--ok-fg); }
        .toast.bad .toast-icon { background: var(--danger-bg); color: var(--danger); }
        .toast.info .toast-icon { background: var(--accent-light); color: var(--accent); }
        .toast-body { min-width: 0; }
        .toast-title { font-weight: 650; }
        .toast-sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
        @media (max-width: 700px) {
          /* Bottom-anchored on a phone would sit under the composer and the
             home indicator, so they come down from the top instead. */
          .toast-stack { right: 12px; left: 12px; bottom: auto; top: calc(10px + env(safe-area-inset-top)); }
          .toast { min-width: 0; max-width: none; padding: 12px 14px; font-size: 13px; }
        }
        .catalog-msg { font-size: 12px; margin-top: 8px; min-height: 16px; }
        /* The min-height above reserves room so the card doesn't jump when a
           save message appears. Inside a card header that stacks on mobile,
           though, an empty status span becomes a visible blank row between the
           description and the button -- so there it collapses until it has
           something to say. */
        .card-head .catalog-msg:empty { display: none; }
        .catalog-msg.error { color: var(--danger); }
        .catalog-msg.ok { color: var(--ok-fg); }
        /* A card header with its own action, instead of a bare <h2> and a
           form permanently open underneath it. */
        .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
        .card-head h2 { margin: 0; }
        .card-sub { font-size: 12.5px; color: var(--muted); margin-top: 4px; line-height: 1.5; }
        .catalog-btn svg { flex-shrink: 0; }
        .catalog-btn { display: inline-flex; align-items: center; gap: 7px; }
        .btn-quiet { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background .15s, color .15s; }
        .btn-quiet:hover { background: var(--surface-2); color: var(--text); }
        .table-wrap { overflow-x: auto; }
        .card-head-products { align-items: center; }
        /* Analytics */
        /* minmax(0, 1fr), not minmax(150px, 1fr): a grid item's default
           min-width is min-content, so .stat-tile's own min-width: 190px made
           every card 15px wider than its 175px track. Four of them overflowed
           into each other and the 12px gap measured -2.7px -- the cards were
           literally touching. Tracks that can shrink, plus min-width: 0 on the
           card, is the fix. */
        .kpi-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 22px; }
        .kpi-row > * { min-width: 0; }
        @media (min-width: 1080px) { .kpi-row { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; } }
        .kpi-card { position: relative; min-width: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 16px 18px 15px; box-shadow: var(--shadow-sm); overflow: hidden; --tint: var(--accent); --tint-bg: var(--accent-light); transition: transform .2s cubic-bezier(.22,1,.36,1), box-shadow .2s ease, border-color .2s ease; }
        .kpi-card.k-revenue { --tint: var(--info-fg); --tint-bg: var(--info-bg); }
        .kpi-card.k-orders { --tint: var(--accent); --tint-bg: var(--accent-light); }
        .kpi-card.k-average { --tint: var(--ok-fg); --tint-bg: var(--ok-bg); }
        .kpi-card.k-best { --tint: var(--warn-fg); --tint-bg: var(--warn-bg); }
        .kpi-card::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: var(--tint); opacity: 0.9; }
        .kpi-card::after { content: ""; position: absolute; inset: 0; background: radial-gradient(125% 95% at 100% 0%, var(--tint-bg), transparent 60%); opacity: 0.8; pointer-events: none; }
        .kpi-card > * { position: relative; z-index: 1; }
        .kpi-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: var(--tint); }
        .kpi-card:hover .kpi-mark { transform: scale(1.08) rotate(-5deg); }
        .kpi-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
        .kpi-mark { width: 30px; height: 30px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--tint-bg); color: var(--tint); box-shadow: inset 0 0 0 1px var(--tint-bg); transition: transform .25s cubic-bezier(.22,1,.36,1); }
        .kpi-mark svg { width: 15px; height: 15px; }
        .kpi-name { font-size: 11px; font-weight: 700; letter-spacing: 0.055em; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .kpi-figure { font-family: var(--font-heading); font-size: 26px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.08; color: var(--text); font-variant-numeric: tabular-nums; margin-top: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .kpi-foot { margin-top: 10px; display: flex; align-items: center; min-height: 21px; min-width: 0; }
        .kpi-bottom { display: flex; flex-direction: column; min-width: 0; }
        /* Measured, not guessed: side-by-side, a 270px card could not hold
           "N173,436" at 29px next to "-9% vs prev 14d" -- both ellipsised.
           The figure and its comparison stack; the figure just gets bigger
           to use the width instead. */
        @media (min-width: 1080px) {
          .kpi-card { padding: 17px 20px 16px; }
          .kpi-bottom .kpi-figure { font-size: 30px; margin-top: 15px; }
          .kpi-bottom .kpi-foot { margin-top: 12px; }
        }
        .kpi-sub { font-size: 11px; color: var(--muted-2); margin-top: 3px; }

        /* ---- Analytics ---- */
        .an-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
        .an-title { font-family: var(--font-heading); font-size: 20px; font-weight: 800; letter-spacing: -0.02em; margin: 0; color: var(--text); }
        .an-range { flex-shrink: 0; }
        .an-range button { min-width: 46px; font-variant-numeric: tabular-nums; }
        .an-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
        .an-two > * { min-width: 0; }

        /* A period-over-period change, stated only when there is a previous
           period with records in it to compare against. */
        /* A pill, not loose red text. At 172px the old two-line "-37% vs last
           14 days" wrapped out of its own card; one line that can ellipsis
           cannot. */
        .kpi-delta { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-width: 0; font-size: 11px; font-weight: 650; line-height: 1.2; padding: 4px 9px 4px 7px; border-radius: 999px; white-space: nowrap; }
        .kpi-delta .d-txt { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .kpi-delta svg { width: 11px; height: 11px; flex-shrink: 0; }
        .kpi-delta.up { color: var(--ok-fg); background: var(--ok-bg); }
        .kpi-delta.down { color: var(--danger); background: var(--danger-bg); }
        .kpi-delta.down svg { transform: scaleY(-1); }
        .kpi-delta.flat, .kpi-delta.none { color: var(--muted-2); background: var(--surface-3); font-weight: 550; padding-left: 9px; }

        /* The slot used to carry its own grey fill, so a day with no orders
           read as a full-height empty box rather than as a zero. The slot is
           transparent now: what you see is the bar, sitting on one baseline. */
        .dow-row { display: flex; align-items: flex-end; gap: 10px; margin-top: 20px; position: relative; padding-bottom: 34px; }
        .dow { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
        .dow-slot { position: relative; width: 100%; height: 100px; display: flex; align-items: flex-end; }
        .dow-slot::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 2px; background: var(--border); }
        .dow-bar { position: relative; z-index: 1; width: 100%; min-height: 3px; border-radius: 8px 8px 3px 3px; background: linear-gradient(to top, var(--accent-soft), var(--accent-light)); box-shadow: inset 0 0 0 1px var(--accent-light); transition: height .7s cubic-bezier(.22,1,.36,1), transform .2s ease, box-shadow .2s ease; }
        .dow.is-zero .dow-bar { background: var(--surface-3); box-shadow: none; border-radius: 3px; }
        .dow.is-best .dow-bar { background: linear-gradient(to top, var(--accent-dark), var(--accent)); box-shadow: 0 4px 12px var(--accent-shadow); }
        .dow:hover .dow-bar { transform: translateY(-3px); }
        .dow.is-zero:hover .dow-bar { transform: none; }
        .dow-n { font-size: 12.5px; font-weight: 750; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1; }
        .dow.is-zero .dow-n { color: var(--muted-2); font-weight: 600; }
        .dow.is-best .dow-n { color: var(--accent); }
        .dow-name { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted-2); line-height: 1; }
        .dow.is-best .dow-name { color: var(--accent); }
        .dow-note { position: absolute; left: 0; bottom: 0; font-size: 12.5px; color: var(--muted); }
        .dow-note b { color: var(--text); }

        .nr-bar { display: flex; gap: 3px; height: 14px; margin-top: 20px; }
        .nr-seg { height: 100%; border-radius: 999px; min-width: 0; transition: width .7s cubic-bezier(.22,1,.36,1); }
        .nr-seg.nr-new { background: linear-gradient(90deg, var(--accent), var(--accent-dark)); box-shadow: 0 2px 8px var(--accent-shadow); }
        .nr-seg.nr-ret { background: linear-gradient(90deg, var(--ok-fg), var(--ok-fg)); }
        .nr-legend { display: flex; gap: 22px; margin-top: 16px; flex-wrap: wrap; }
        .nr-item { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
        .nr-item b { font-family: var(--font-heading); font-size: 17px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; }
        .nr-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
        .nr-dot.nr-new { background: var(--accent); }
        .nr-dot.nr-ret { background: var(--ok-fg); }
        .nr-foot { font-size: 12.5px; color: var(--muted); margin-top: 15px; padding-top: 14px; border-top: 1px solid var(--border-light); line-height: 1.5; }
        .nr-foot b { color: var(--text); }
        .period-chip { font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px; white-space: nowrap; flex-shrink: 0; }
        .seller-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border-light); }
        .seller-row:last-child { border-bottom: none; }
        .seller-rank { width: 22px; height: 22px; border-radius: 7px; background: var(--surface-3); color: var(--muted); font-size: 11.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
        .seller-row:first-child .seller-rank { background: var(--accent-light); color: var(--accent); }
        .seller-main { flex: 1; min-width: 0; }
        .seller-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
        .seller-name { font-size: 13.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .seller-rev { font-family: var(--font-heading); font-size: 13.5px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .seller-units { font-size: 11.5px; color: var(--muted); margin-top: 5px; }
        .conversion-block { display: flex; flex-direction: column; gap: 10px; }
        .conversion-meter { height: 8px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
        .conversion-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-dark)); transition: width .5s cubic-bezier(.4,0,.2,1); }
        .card-head-products > div:last-child { display: flex; align-items: center; }
        /* Products as cards led by their photo -- that photo is exactly what
           Amara sends a customer, so it's the thing worth recognising. */
        .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
        /* Catalogue toolbar: search and sort sit above the category chips, so
           all three compose instead of each one resetting the others. */
        .cat-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
        .cat-search { position: relative; flex: 1; min-width: 190px; display: flex; align-items: center; }
        .cat-search svg { position: absolute; left: 12px; width: 15px; height: 15px; color: var(--muted-2); pointer-events: none; }
        .cat-search input { width: 100%; padding: 9px 12px 9px 34px; border: 1px solid var(--border-strong); border-radius: 10px; font-size: 13.5px; font-family: inherit; background: var(--surface); color: var(--text); transition: border-color .15s, box-shadow .15s; }
        .cat-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .cat-sort { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .cat-sort label { font-size: 12.5px; color: var(--muted); font-weight: 600; }
        .cat-sort select { padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 10px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); cursor: pointer; }
        .cat-sort select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        /* ---- Bookings & services ----
           Both were six-column tables, which is unusable on a phone and not
           much better on a laptop for rows that carry five different kinds of
           fact. Cards, with the one thing you scan for -- the time, the name --
           given the weight. */
        .bk-daygroup { font-family: var(--font-heading); font-size: 12.5px; font-weight: 700; color: var(--muted); margin: 18px 0 9px; padding-bottom: 7px; border-bottom: 1px solid var(--border-light); }
        .bk-daygroup:first-child { margin-top: 4px; }
        .bk-card { display: flex; align-items: center; gap: 14px; padding: 13px 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); margin-bottom: 9px; transition: border-color .15s ease, box-shadow .15s ease; }
        .bk-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
        .bk-time { flex-shrink: 0; width: 66px; display: flex; flex-direction: column; gap: 2px; padding-right: 14px; border-right: 1px solid var(--border-light); }
        .bk-time b { font-family: var(--font-heading); font-size: 16px; font-weight: 750; letter-spacing: -0.02em; color: var(--text); font-variant-numeric: tabular-nums; }
        .bk-time span { font-size: 10.5px; color: var(--muted-2); }
        .bk-main { flex: 1; min-width: 0; }
        .bk-service { font-size: 14px; font-weight: 650; color: var(--text); }
        .bk-who { font-size: 12.5px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bk-phone { color: var(--muted-2); font-variant-numeric: tabular-nums; }
        .bk-ref { font-size: 11px; color: var(--muted-2); margin-top: 3px; font-variant-numeric: tabular-nums; }
        .bk-actions { display: flex; gap: 7px; flex-shrink: 0; }
        .bk-reschedule { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); padding: 14px; margin: -4px 0 12px; }
        .bk-resched-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
        .bk-slots { margin-top: 10px; font-size: 13px; color: var(--muted); }

        .svc-card { display: flex; align-items: center; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); margin-bottom: 9px; transition: border-color .15s ease, box-shadow .15s ease; }
        .svc-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
        .svc-card.needs-work { border-color: var(--warn-border); }
        .svc-main { flex: 1; min-width: 0; }
        .svc-name { font-size: 14.5px; font-weight: 650; color: var(--text); }
        .svc-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0 12px; margin-top: 5px; font-size: 12.5px; color: var(--muted); }
        .svc-meta > span { padding-right: 12px; border-right: 1px solid var(--border); }
        .svc-meta > span:last-child { border-right: none; padding-right: 0; }
        .svc-price { font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
        .svc-mode.warn, .svc-price.warn { color: var(--warn-fg); font-weight: 650; }
        .svc-key { font-size: 11px; color: var(--muted-2); margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .svc-actions { display: flex; gap: 7px; flex-shrink: 0; }

        .cat-summary { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-light); font-size: 12px; color: var(--muted-2); }
        .cat-summary span { display: inline-flex; align-items: center; padding-right: 16px; border-right: 1px solid var(--border); }
        .cat-summary span:last-child { border-right: none; padding-right: 0; }
        .cat-summary .sum-warn { color: var(--warn-fg); font-weight: 650; }
        .cat-summary .sum-ok { color: var(--ok-fg); font-weight: 650; }

        .product-card { position: relative; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--surface); transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
        /* A product Amara can't quote properly is worth pointing at, quietly. */
        .product-card.needs-work { border-color: var(--warn-border); }
        .thumb-cat, .thumb-sold { position: absolute; z-index: 2; font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; letter-spacing: 0.01em; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
        .thumb-cat { left: 9px; top: 9px; background: rgba(255,255,255,0.9); color: #111827; }
        .thumb-sold { right: 9px; top: 9px; background: rgba(17,24,39,0.78); color: #fff; }
        .product-flag { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--warn-fg); margin-top: 7px; }
        .product-flag svg { width: 12px; height: 12px; flex-shrink: 0; }
        .price-missing { color: var(--warn-fg); font-weight: 600; font-size: 13px; }
        /* Actions read as controls now, not two words of body text. */
        .product-actions { display: flex; align-items: center; gap: 7px; padding: 0 12px 12px; }
        .pact { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 1; padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface); color: var(--text); font-size: 12.5px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background .15s, border-color .15s, color .15s, transform .12s ease; }
        .pact svg { width: 13px; height: 13px; }
        .pact:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
        .pact:active { transform: scale(0.96); }
        .pact.danger { flex: 0 0 auto; padding: 7px 10px; color: var(--muted); }
        .pact.danger:hover { border-color: var(--danger); color: var(--danger); background: var(--danger-bg); }
        .product-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); border-color: var(--border-strong); }
        .product-thumb { position: relative; aspect-ratio: 4 / 3; background: var(--surface-3); overflow: hidden; }
        .product-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        /* A product with no usable photo shows a calm placeholder rather than
           a broken-image icon. */
        .product-thumb.no-photo img { display: none; }
        /* An icon instead of the words "No photo" in grey: a grid of eight
           products with the same sentence repeated eight times read as an
           error state rather than as products waiting for a picture. */
        .product-thumb.no-photo { background: var(--surface-2); }
        .product-thumb.no-photo::after { content: ""; position: absolute; inset: 0; background-repeat: no-repeat; background-position: center; background-size: 30px 30px; opacity: 0.32;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4.5' width='18' height='15' rx='2.5'/%3E%3Ccircle cx='8.5' cy='10' r='1.6'/%3E%3Cpath d='m3.6 17.5 4.9-4.4a2 2 0 0 1 2.7 0l3.4 3.1a2 2 0 0 0 2.7 0l3.1-2.8'/%3E%3C/svg%3E"); }
        .product-body { padding: 11px 12px 4px; flex: 1; }
        .product-cat { display: inline-block; font-size: 10.5px; font-weight: 600; color: var(--accent); background: var(--accent-light); border: 1px solid var(--accent-soft); padding: 1px 7px; border-radius: 999px; margin-bottom: 6px; }
        .product-name { font-size: 13.5px; font-weight: 600; color: var(--text); line-height: 1.35; }
        .product-price { font-family: var(--font-heading); font-size: 14.5px; font-weight: 700; color: var(--text); margin-top: 3px; font-variant-numeric: tabular-nums; }
        .product-desc { font-size: 11.5px; color: var(--muted); margin-top: 5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .product-actions { display: flex; gap: 6px; padding: 10px 12px 12px; }
        .btn-tiny { padding: 5px 10px; font-size: 11.5px; }
        .danger-quiet:hover { background: var(--dang-bg); color: var(--dang-fg); border-color: var(--dang-border); }
        /* Category chips, built from the categories actually in use. */
        .cat-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
        .cat-filter:empty { display: none; }
        .cat-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font-size: 12px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .cat-chip:hover { color: var(--text); border-color: var(--border-strong); }
        .cat-chip-active { background: var(--accent-light); color: var(--accent); border-color: var(--accent-soft); }
        .cat-chip-count { font-size: 10px; font-weight: 700; opacity: 0.75; }
        /* A real drop target with a preview, instead of a bare file input. */
        .dropzone { border: 1.5px dashed var(--border-strong); border-radius: 12px; background: var(--surface); padding: 18px; text-align: center; cursor: pointer; transition: border-color .18s ease, background .18s ease; }
        .dropzone:hover, .dropzone:focus-visible { border-color: var(--accent); background: var(--accent-light); }
        .dropzone.dragging { border-color: var(--accent); background: var(--accent-light); }
        .dropzone-empty svg { width: 28px; height: 28px; color: var(--muted-2); }
        .dropzone-title { font-size: 13px; font-weight: 600; color: var(--text); margin-top: 8px; }
        .dropzone-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
        .dropzone-preview img { max-height: 150px; max-width: 100%; border-radius: 10px; display: block; margin: 0 auto; box-shadow: var(--shadow-md); }
        .dropzone-meta { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; font-size: 11.5px; color: var(--muted); }
        /* The add/edit form, revealed on demand, as one coherent grid rather
           than three stacked half-grids. */
        .inline-panel { margin-top: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); animation: panelIn .18s ease-out; }
        @keyframes panelIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
        .inline-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
        .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
        .field-full { grid-column: 1 / -1; }
        .field label { display: block; font-size: 12.5px; font-weight: 500; color: var(--text); margin-bottom: 5px; }
        .field-hint { font-size: 11.5px; color: var(--muted); margin: -2px 0 6px; line-height: 1.45; }
        .field input, .field textarea, .field select { width: 100%; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); resize: vertical; }
        .field input:focus, .field textarea:focus, .field select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .inline-panel-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }

        /* Grouped form steps. Six fields and a save button all visible at once
           with no grouping is the thing that reads as noise -- the eye has
           nowhere to start. Three numbered groups give it somewhere. */
        .form-step { padding: 15px 0; border-top: 1px solid var(--border); }
        .form-step:first-of-type { border-top: none; padding-top: 4px; }
        .form-step-label { display: flex; align-items: center; gap: 9px; font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 11px; letter-spacing: -0.005em; }
        .form-step-num { width: 20px; height: 20px; border-radius: 50%; background: var(--accent-light); color: var(--accent); font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-family: var(--font-sans); }
        .edit-note { font-size: 12.5px; color: var(--muted); background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 9px; padding: 8px 11px; margin-bottom: 13px; }
        .edit-note b { color: var(--text); }

        /* A unit that belongs to a field belongs inside it, not in the label. */
        .input-prefix, .input-suffix { display: flex; align-items: stretch; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); overflow: hidden; transition: border-color .15s, box-shadow .15s; }
        .input-prefix:focus-within, .input-suffix:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .input-prefix span, .input-suffix span { display: flex; align-items: center; padding: 0 10px; font-size: 12.5px; font-weight: 600; color: var(--muted); background: var(--surface-2); flex-shrink: 0; }
        .input-prefix span { border-right: 1px solid var(--border); }
        .input-suffix span { border-left: 1px solid var(--border); }
        .input-prefix input, .input-suffix input { flex: 1; min-width: 0; border: none; border-radius: 0; background: transparent; padding: 8px 10px; font-size: 13px; font-family: inherit; color: var(--text); }
        .input-prefix input:focus, .input-suffix input:focus { outline: none; box-shadow: none; }

        /* Four options is a row of buttons, not a dropdown you have to open to
           discover what is in it. The <select> stays as the value's home. */
        .choice-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .choice { padding: 8px 14px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 12.5px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background .15s, color .15s, border-color .15s, transform .12s ease; }
        .choice:hover { border-color: var(--accent); color: var(--accent); }
        .choice:active { transform: scale(0.96); }
        .choice.on { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 2px 8px var(--accent-shadow); }
        .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
        @media (max-width: 700px) { .field-grid { grid-template-columns: 1fr; } }
        /* Settings rows: label + explanation on the left, the control on the
           right. Every control here changes something that genuinely works. */
        .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--border-light); }
        .setting-row:last-of-type { border-bottom: none; }
        .setting-text { min-width: 0; }
        .setting-name { font-size: 13.5px; font-weight: 600; color: var(--text); }
        .setting-desc { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.5; }
        .setting-static { font-size: 13px; font-weight: 600; color: var(--text); text-align: right; flex-shrink: 0; }
        .setting-note { font-size: 12px; color: var(--muted); line-height: 1.55; margin-top: 12px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
        .seg-control { display: inline-flex; gap: 2px; padding: 3px; background: var(--surface-3); border-radius: 10px; flex-shrink: 0; }
        .seg-control button { border: none; background: transparent; padding: 6px 13px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); cursor: pointer; font-family: inherit; transition: background .15s, color .15s, box-shadow .15s; }
        .seg-control button:hover { color: var(--text); }
        .seg-control button.seg-active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-md); }
        .swatches { display: flex; gap: 7px; flex-shrink: 0; }
        .swatch { width: 26px; height: 26px; border-radius: 50%; border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(15,23,42,0.12); cursor: pointer; padding: 0; transition: transform .15s ease, box-shadow .15s ease; }
        .swatch:hover { transform: scale(1.12); }
        .swatch-active { border-color: var(--surface); box-shadow: 0 0 0 2px var(--text); }
        /* Compact density: the same layout, tightened. Only spacing changes —
           nothing is hidden, so nothing becomes undiscoverable. */
        [data-density="compact"] .list-item { padding-top: 9px; padding-bottom: 9px; }
        [data-density="compact"] .stat-tile { padding: 10px 14px; }
        [data-density="compact"] .catalog-card { padding: 15px; margin-bottom: 14px; }
        [data-density="compact"] .setting-row { padding: 10px 0; }
        /* Compact density now reaches the messages themselves, so it is a real
           lever on how dense a thread reads rather than only page padding. */
        [data-density="compact"] .thread { padding: 12px 18px 16px; }
        [data-density="compact"] .bubble { font-size: 13.5px; line-height: 1.36; padding: 6px 10px 7px 11px; }
        [data-density="compact"] .msg-row.group-end { margin-bottom: 8px; }
        [data-density="compact"] .bubble-col { max-width: 70%; }
        [data-density="compact"] .msg-row.group-end { margin-bottom: 10px; }
        [data-density="compact"] .detail-pane { padding: 12px; gap: 10px; }
        [data-density="compact"] .product-grid { gap: 10px; }
        .switch { position: relative; width: 42px; height: 24px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-3); cursor: pointer; flex-shrink: 0; padding: 0; transition: background .18s ease, border-color .18s ease; }
        .switch span { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-md); transition: transform .18s cubic-bezier(.4,0,.2,1); }
        .switch.on { background: var(--accent); border-color: var(--accent); }
        .switch.on span { transform: translateX(18px); }
        .fees-row { display: flex; gap: 16px; align-items: end; }
        .fees-row div { width: 160px; }
        /* These fields sit outside .catalog-form, so they were rendering with
           browser-default label sizing and unstyled inputs -- the one place
           on the page that still looked like a raw HTML form. */
        .fees-row label { font-size: 12.5px; font-weight: 500; color: var(--text); display: block; margin-bottom: 5px; }
        .fees-row input, .fees-row select { width: 100%; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); }
        .fees-row input:focus, .fees-row select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        /* Real search over the messages already on the page -- no server
           round trip, no separate index, just a substring match. */
        .thread-search-bar { display: flex; align-items: center; gap: 8px; padding: 8px 24px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
        .thread-search-bar input { flex: 1; padding: 6px 9px; border: 1px solid var(--border-strong); border-radius: 6px; font-size: 13px; }
        .thread-search-bar input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
        .thread-search-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
        .bubble mark { background: var(--warn-border); color: #1e293b; border-radius: 3px; padding: 0 1px; }
        .msg-row.search-hidden { display: none; }
        /* The format controls live inside the composer pill, so they line up
           with the message text itself instead of floating above it in a
           separate strip on a different left edge. */
        .compose-tools { display: flex; align-items: center; gap: 2px; margin-top: 2px; }
        .toolbar-divider { width: 1px; height: 16px; background: var(--border); margin: 0 4px; flex-shrink: 0; }
        .icon-btn.small-icon-btn { width: 27px; height: 27px; border-radius: 6px; font-size: 12px; border: none; background: transparent; color: var(--text); }
        .icon-btn.small-icon-btn:hover { background: var(--surface); color: var(--accent); box-shadow: 0 1px 3px rgba(15,23,42,0.12); }
        .icon-btn.small-icon-btn svg { width: 14px; height: 14px; }
        .emoji-picker-wrap { position: relative; }
        .emoji-picker-dropdown { display: none; position: absolute; left: 0; bottom: calc(100% + 8px); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 10px 26px rgba(15,23,42,0.16); padding: 10px; z-index: 20; width: 232px; }
        .emoji-picker-dropdown.open { display: block; }
        .emoji-picker-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 7px; padding: 0 2px; }
        .emoji-picker-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; }
        .emoji-picker-grid button { border: none; background: transparent; font-size: 18px; padding: 5px; border-radius: 6px; cursor: pointer; line-height: 1; }
        .emoji-picker-grid button:hover { background: var(--accent-light); }
        .msg-compose { display: flex; align-items: flex-end; gap: 10px; padding: 12px 24px 14px; border-top: 1px solid var(--border); background: var(--surface); }
        .msg-compose-inner { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; border: 1.5px solid var(--border); border-radius: 18px; padding: 6px 10px 6px 14px; background: var(--surface-2); transition: border-color .15s, box-shadow .15s, background .15s; }
        .msg-compose-inner:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); background: var(--surface); }
        .msg-compose textarea { width: 100%; border: none; background: transparent; resize: none; font-size: 14px; font-family: inherit; line-height: 1.45; padding: 6px 0 2px; max-height: 120px; }
        .msg-compose textarea:focus { outline: none; }
        .msg-send-btn { width: 38px; height: 38px; border-radius: 50%; border: none; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; box-shadow: 0 2px 6px var(--accent-shadow); transition: transform .15s ease, box-shadow .15s ease; }
        .msg-send-btn svg { width: 17px; height: 17px; }
        .msg-send-btn:hover { transform: translateY(-1px) scale(1.04); box-shadow: 0 4px 10px var(--accent-shadow-strong); }
        .msg-send-btn:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }
        .notes-box-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
        .trend-chart-wrap { position: relative; height: 240px; padding-top: 8px; }
        @media (min-width: 1080px) { .trend-chart-wrap { height: 300px; } }
        .best-seller-bar-track { background: var(--accent-light); border-radius: 999px; height: 6px; width: 100%; margin-top: 5px; overflow: hidden; }
        .best-seller-bar-fill { background: linear-gradient(90deg, var(--accent), var(--accent-dark)); height: 100%; border-radius: 999px; }
        .conversion-stat { font-family: var(--font-heading); font-size: 32px; font-weight: 700; color: var(--text); }
        .conversion-sub { font-size: 13px; color: var(--muted); margin-top: 4px; }

        /* ---------- Responsive ----------
           Below 1000px the fixed-width sidebar becomes an off-canvas drawer
           (hamburger-toggled, closes on an outside click) instead of
           squeezing three fixed-width columns into a shrinking viewport --
           the thing that made this "a mess" on anything narrower than a
           laptop. Below 700px the conversation list and the open thread
           become a real single-pane master/detail (like a phone's own
           Messages app, and the same back-arrow pattern Vora's own mobile
           chat view uses) instead of both trying to share a width that
           can't fit either one legibly. */
        @media (max-width: 1000px) {
          .hamburger-btn { display: flex; }
          .sidebar { position: fixed; left: 0; top: 0; z-index: 30; transform: translateX(-100%); transition: transform .2s ease; }
          .sidebar.open { transform: translateX(0); box-shadow: 8px 0 24px rgba(15,23,42,0.3); }
          .list-pane { width: 260px; }
        }
        /* Below this three columns stop fitting side by side, so the details
           panel slides over the thread instead of squeezing it. */
        @media (max-width: 1280px) {
          .layout { position: relative; }
          .layout.details-on .detail-pane { position: absolute; right: 0; top: 0; bottom: 0; z-index: 12; box-shadow: var(--shadow-lg); }
        }
        /* ---- Home tab ----
           The masthead is the piece that has to carry the whole page, so it is
           built as one: a cover, a ring-mounted avatar breaking its lower edge,
           and a typographic block with real hierarchy rather than three stacked
           grey lines. Everything below it steps down in weight from there. */
        .home-view { flex: 1; overflow-y: auto; scrollbar-gutter: stable; padding: 22px 24px 34px; background: var(--bg); }
        .home-inner { max-width: 960px; margin: 0 auto; }

        .brand-card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; box-shadow: var(--shadow-sm); margin-bottom: 22px; }
        /* Without a photo the cover is still a designed surface: three
           accent-derived washes over a deep base, so it changes with the
           seller's accent instead of being a flat grey band. */
        .brand-cover {
          position: relative; height: 168px;
          background-color: var(--accent-dark);
          background-image:
            radial-gradient(115% 165% at 8% 100%, var(--accent) 0%, transparent 60%),
            radial-gradient(95% 150% at 95% 0%, rgba(255,255,255,0.30) 0%, transparent 58%),
            linear-gradient(115deg, var(--accent-dark) 0%, var(--accent) 58%, var(--accent-dark) 100%);
          background-size: cover; background-position: center;
        }
        /* A very fine diagonal weave keeps the placeholder from reading as a
           flat CSS gradient. It is one repeating SVG, no image request. */
        .brand-cover::before {
          content: ""; position: absolute; inset: 0; opacity: 0.5;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Cpath d='M0 40L40 0M-10 10L10 -10M30 50L50 30' stroke='%23ffffff' stroke-opacity='0.09' stroke-width='1.2'/%3E%3C/svg%3E");
        }
        .brand-cover.has-photo { background-image: var(--cover-img); }
        .brand-cover.has-photo::before { display: none; }
        /* A scrim only under a real photo, so the control on top of it stays
           readable whatever the seller uploaded. */
        .brand-cover.has-photo::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.34) 100%); }

        /* No backdrop blur here on purpose. The button sits inside the view
           whose opacity animates on every tab switch, and a backdrop-filter
           under an animating ancestor has to be recomposited every frame --
           it measured as jank on Home. The fill is 92% opaque anyway, so the
           blur was costing frames for something almost invisible. */
        .photo-btn { position: absolute; display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.92); color: #111827; border: none; border-radius: 999px; padding: 7px 13px; font-size: 12px; font-weight: 650; font-family: inherit; cursor: pointer; z-index: 3; box-shadow: 0 2px 10px rgba(0,0,0,0.20); transition: background .15s, transform .12s ease; }
        .photo-btn:hover { background: #fff; }
        .photo-btn:active { transform: scale(0.96); }
        .photo-btn svg { width: 14px; height: 14px; }
        .cover-photo-btn { right: 16px; bottom: 16px; }

        .brand-body { padding: 0 26px 24px; position: relative; }
        .brand-avatar-wrap { position: relative; width: 104px; margin-top: -52px; margin-bottom: 16px; }
        /* The ring is the card's own background, so the avatar reads as
           mounted on the card rather than pasted over the cover. */
        .brand-avatar { width: 104px; height: 104px; border-radius: 30px; border: 5px solid var(--surface); background: linear-gradient(140deg, var(--accent), var(--accent-dark)); color: #fff; display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 38px; font-weight: 700; letter-spacing: -0.02em; overflow: hidden; box-shadow: 0 10px 26px var(--accent-shadow); }
        /* With a real photograph in it, an accent-coloured glow reads as a
           rendering fault rather than depth. A neutral drop shadow is what a
           photo actually wants. */
        .brand-avatar.has-photo { background: var(--surface-3); box-shadow: 0 8px 22px rgba(15,23,42,0.18); }
        [data-theme="dark"] .brand-avatar.has-photo { box-shadow: 0 8px 22px rgba(0,0,0,0.42); }
        .brand-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .avatar-photo-btn { right: -6px; bottom: -2px; padding: 7px; border-radius: 50%; }
        .avatar-photo-btn svg { width: 15px; height: 15px; }

        .brand-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; }
        .brand-text { min-width: 0; flex: 1; }
        .brand-title-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .brand-name { font-family: var(--font-heading); font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: var(--text); margin: 0; line-height: 1.12; }
        /* Real state, not decoration: this only says live when the number is
           actually connected (see the connected flag from /api/home). */
        .live-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; padding: 4px 10px 4px 8px; border-radius: 999px; background: var(--ok-bg); color: var(--ok-fg); white-space: nowrap; }
        .live-pill.off { background: var(--warn-bg); color: var(--warn-fg); }
        .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
        .brand-tagline { font-size: 15px; color: var(--muted); margin-top: 7px; line-height: 1.5; max-width: 56ch; }
        .brand-empty-hint { font-size: 14px; color: var(--muted-2); margin-top: 7px; }
        .brand-empty-hint button { background: none; border: none; padding: 0; font: inherit; color: var(--accent); font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
        /* Meta reads as a row of facts separated by hairlines, which is why it
           doesn't blur into the tagline above it. */
        .brand-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0 14px; margin-top: 14px; font-size: 12.5px; color: var(--muted-2); }
        .brand-meta span { display: inline-flex; align-items: center; gap: 6px; padding-right: 14px; border-right: 1px solid var(--border); }
        .brand-meta span:last-child { border-right: none; padding-right: 0; }
        .brand-meta svg { width: 13.5px; height: 13.5px; opacity: 0.85; }
        .brand-about { font-size: 14px; color: var(--text); line-height: 1.65; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border-light); max-width: 68ch; white-space: pre-wrap; }
        .brand-edit-btn { flex-shrink: 0; }

        /* Setup prompt */
        .setup-card { position: relative; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 20px 22px; margin-bottom: 22px; box-shadow: var(--shadow-sm); }
        .setup-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: linear-gradient(to bottom, var(--accent), var(--accent-dark)); }
        .setup-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
        .setup-title { font-family: var(--font-heading); font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
        .setup-sub { font-size: 13px; color: var(--muted); margin-top: 5px; line-height: 1.55; max-width: 60ch; }
        .setup-progress { display: flex; align-items: center; gap: 10px; margin-top: 15px; }
        .setup-bar { flex: 1; height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
        .setup-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-dark)); transition: width .5s cubic-bezier(.22,1,.36,1); }
        .setup-progress-text { font-size: 12px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .setup-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 15px; }
        .setup-step { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: var(--text); padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-2); transition: border-color .15s, background .15s, transform .12s ease; }
        .setup-step:not(.done) { cursor: pointer; }
        .setup-step:not(.done):hover { border-color: var(--accent); background: var(--accent-light); }
        .setup-step:not(.done):active { transform: scale(0.985); }
        .setup-step.done { color: var(--muted-2); background: transparent; border-color: transparent; }
        .setup-step .tick { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--border-strong); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: transparent; }
        .setup-step.done .tick { background: var(--ok-fg); border-color: var(--ok-fg); color: #fff; }
        .setup-step .tick svg { width: 11px; height: 11px; }
        .setup-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }

        /* Alerts */
        .home-alert { display: flex; align-items: flex-start; gap: 12px; border-radius: 16px; padding: 15px 18px; margin-bottom: 20px; font-size: 13.5px; line-height: 1.55; border: 1px solid; }
        .home-alert svg { width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px; }
        .home-alert.warn { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-fg); }
        .home-alert.bad { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }
        .home-alert b { font-weight: 750; }

        .home-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 2px 12px; }
        .home-section-label { display: flex; align-items: center; gap: 8px; font-family: var(--font-heading); font-size: 13px; font-weight: 700; letter-spacing: -0.005em; color: var(--text); }
        .home-section-note { font-size: 11.5px; color: var(--muted-2); }
        .pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); box-shadow: 0 0 0 3px var(--ok-bg); }

        /* Home's own tiles. The analytics tile is a number with an icon beside
           it; these carry a third line of real context, so the icon moves up
           next to the value and the two text lines stack cleanly beneath. */
        .home-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 13px; margin-bottom: 26px; }
        .htile { position: relative; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 16px 17px 15px; box-shadow: var(--shadow-sm); transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; --tint: var(--accent); --tint-bg: var(--accent-light); }
        .htile.t-total { --tint: var(--accent); --tint-bg: var(--accent-light); }
        .htile.t-active { --tint: var(--ok-fg); --tint-bg: var(--ok-bg); }
        .htile.t-paused { --tint: var(--warn-fg); --tint-bg: var(--warn-bg); }
        .htile.t-revenue { --tint: var(--info-fg); --tint-bg: var(--info-bg); }
        .htile::after { content: ""; position: absolute; right: -40px; top: -48px; width: 104px; height: 104px; border-radius: 50%; background: var(--tint-bg); opacity: 0.42; pointer-events: none; }
        .htile > * { position: relative; z-index: 1; }
        .htile:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); border-color: var(--tint); }
        .htile-top { display: flex; align-items: center; gap: 10px; }
        .htile-icon { width: 32px; height: 32px; border-radius: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--tint-bg); color: var(--tint); }
        .htile-icon svg { width: 16px; height: 16px; }
        .htile-value { font-family: var(--font-heading); font-size: 26px; font-weight: 800; letter-spacing: -0.03em; color: var(--text); line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .htile-label { font-size: 13px; font-weight: 600; color: var(--text); margin-top: 12px; }
        .htile-context { font-size: 11.5px; color: var(--muted-2); margin-top: 3px; line-height: 1.35; }

        .home-col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }

        /* Seven bars, drawn from real per-day counts. */
        .wk-chart { display: flex; align-items: flex-end; gap: 7px; height: 92px; margin-top: 16px; }
        .wk-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; height: 100%; }
        .wk-bar-slot { flex: 1; width: 100%; display: flex; align-items: flex-end; background: var(--surface-2); border-radius: 8px; overflow: hidden; }
        .wk-bar { width: 100%; border-radius: 8px; background: linear-gradient(to top, var(--accent-dark), var(--accent)); transition: height .55s cubic-bezier(.22,1,.36,1); }
        .wk-col.is-today .wk-bar-slot { box-shadow: inset 0 0 0 1.5px var(--accent-soft); }
        .wk-day { font-size: 10.5px; font-weight: 600; color: var(--muted-2); }
        .wk-col.is-today .wk-day { color: var(--accent); }
        .wk-foot { display: flex; gap: 0; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-light); }
        .wk-stat { flex: 1; display: flex; flex-direction: column; gap: 2px; padding-right: 12px; border-right: 1px solid var(--border-light); }
        .wk-stat:last-child { border-right: none; padding-right: 0; }
        .wk-stat b { font-family: var(--font-heading); font-size: 17px; font-weight: 750; letter-spacing: -0.02em; color: var(--text); font-variant-numeric: tabular-nums; }
        .wk-stat span { font-size: 11px; color: var(--muted-2); }

        /* The catalogue card. The point of it is the products, so they get the
           space: the price sits on the image rather than on a line of its own,
           and the completeness ring became a badge beside the title because it
           is a status, not a section. */
        .ring-badge { position: relative; width: 44px; height: 44px; flex-shrink: 0; }
        .ring-badge svg { width: 44px; height: 44px; transform: rotate(-90deg); }
        .ring-badge .track { fill: none; stroke: var(--surface-3); stroke-width: 4.5; }
        .ring-badge .fill { fill: none; stroke: var(--accent); stroke-width: 4.5; stroke-linecap: round; transition: stroke-dashoffset .9s cubic-bezier(.22,1,.36,1); }
        .ring-badge b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 12.5px; font-weight: 800; color: var(--text); letter-spacing: -0.03em; }
        .ring-badge b i { font-style: normal; font-size: 8px; margin-left: 0.5px; color: var(--muted-2); }

        .ptile-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 11px; margin-top: 18px; }
        .ptile { min-width: 0; cursor: pointer; }
        .ptile-img { position: relative; aspect-ratio: 1 / 1; border-radius: 13px; overflow: hidden; background: var(--surface-3); display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); transition: transform .28s cubic-bezier(.22,1,.36,1), box-shadow .28s ease, border-color .2s ease; }
        .ptile-img img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .45s cubic-bezier(.22,1,.36,1); }
        .ptile:hover .ptile-img { transform: translateY(-4px); border-color: var(--accent); box-shadow: 0 10px 24px rgba(15,23,42,0.14); }
        [data-theme="dark"] .ptile:hover .ptile-img { box-shadow: 0 10px 24px rgba(0,0,0,0.45); }
        .ptile:hover .ptile-img img { transform: scale(1.07); }
        .ptile:active .ptile-img { transform: translateY(-1px) scale(0.985); }
        .ptile-blank { color: var(--muted-2); display: flex; }
        .ptile-blank svg { width: 22px; height: 22px; }
        /* The price rides up out of the image on hover; the veil is what keeps
           it readable over a photograph of any brightness. */
        .ptile-veil { position: absolute; left: 0; right: 0; bottom: 0; height: 54%; background: linear-gradient(to top, rgba(0,0,0,0.62), rgba(0,0,0,0)); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
        .ptile-price { position: absolute; left: 8px; bottom: 7px; right: 8px; font-size: 11.5px; font-weight: 750; color: #fff; letter-spacing: -0.01em; opacity: 0; transform: translateY(6px); transition: opacity .25s ease, transform .28s cubic-bezier(.22,1,.36,1); pointer-events: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ptile:hover .ptile-veil { opacity: 1; }
        .ptile:hover .ptile-price { opacity: 1; transform: none; }
        .ptile-sold { position: absolute; right: 7px; top: 7px; font-size: 9.5px; font-weight: 750; padding: 2.5px 7px; border-radius: 999px; background: rgba(17,24,39,0.82); color: #fff; }
        .ptile-name { font-size: 12px; font-weight: 600; color: var(--text); margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .gap-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 16px; padding-top: 15px; border-top: 1px solid var(--border-light); }
        .gchip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-fg); }
        .gchip.ok { background: var(--ok-bg); color: var(--ok-fg); }
        .gchip svg { width: 11px; height: 11px; }
        /* min-width:0 on the tracks. A grid item defaults to min-content
           width, so a card holding rows with negative margins (the waiting
           list) pushed itself 46px wider than its own column -- invisible on a
           wide screen, a sideways scroll inside the view on a phone. */
        .home-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; align-items: start; }
        .home-grid > * { min-width: 0; }
        /* Home's own cards, a step softer and rounder than the catalogue's. */
        .home-card { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 20px 22px; box-shadow: var(--shadow-sm); }
        .home-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
        .home-card h3 { font-family: var(--font-heading); font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; margin: 0; color: var(--text); }
        .home-card-sub { font-size: 12.5px; color: var(--muted); margin-top: 4px; line-height: 1.5; }
        .home-count-chip { font-size: 12px; font-weight: 750; padding: 3px 10px; border-radius: 999px; background: var(--accent-light); color: var(--accent); flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .home-count-chip.calm { background: var(--surface-3); color: var(--muted); }

        .waiting-list { margin-top: 14px; }
        .waiting-row { display: flex; align-items: center; gap: 12px; padding: 11px 10px; margin: 0 -10px; border-radius: 13px; cursor: pointer; transition: background .15s ease; }
        .waiting-row + .waiting-row { border-top: 1px solid var(--border-light); }
        .waiting-row:hover { background: var(--surface-2); }
        .waiting-row:active { background: var(--surface-3); }
        .waiting-avatar { width: 38px; height: 38px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-size: 13.5px; font-weight: 700; color: #fff; flex-shrink: 0; }
        .waiting-main { min-width: 0; flex: 1; }
        .waiting-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .waiting-name { font-size: 14px; font-weight: 650; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .waiting-when { font-size: 11.5px; color: var(--muted-2); flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .waiting-preview { font-size: 13px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .waiting-flag { font-size: 10px; font-weight: 750; padding: 2.5px 8px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-fg); flex-shrink: 0; letter-spacing: 0.01em; }
        .waiting-chev { color: var(--muted-2); flex-shrink: 0; display: flex; }
        .waiting-chev svg { width: 16px; height: 16px; }

        /* Catalogue completeness: one honest ratio, drawn once, instead of
           three rows of numbers the seller has to add up themselves. */
        .cat-health { display: flex; align-items: center; gap: 16px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border-light); }
        .health-ring { position: relative; width: 74px; height: 74px; flex-shrink: 0; }
        .health-ring svg { width: 74px; height: 74px; transform: rotate(-90deg); }
        .health-ring .track { fill: none; stroke: var(--surface-3); stroke-width: 8; }
        .health-ring .fill { fill: none; stroke: var(--accent); stroke-width: 8; stroke-linecap: round; transition: stroke-dashoffset .7s cubic-bezier(.22,1,.36,1); }
        .health-num { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .health-num b { font-family: var(--font-heading); font-size: 17px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; line-height: 1; }
        .health-num span { font-size: 9.5px; color: var(--muted-2); margin-top: 2px; }
        .gap-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
        .gap-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
        .gap-label { color: var(--muted); }
        .gap-count { font-weight: 700; font-size: 12.5px; font-variant-numeric: tabular-nums; padding: 2px 9px; border-radius: 999px; }
        .gap-count.zero { color: var(--ok-fg); background: var(--ok-bg); }
        .gap-count.some { color: var(--warn-fg); background: var(--warn-bg); }
        .home-empty { font-size: 13.5px; color: var(--muted); padding: 22px 0 18px; text-align: center; line-height: 1.6; }
        .home-empty-icon { display: flex; justify-content: center; margin-bottom: 10px; color: var(--muted-2); }
        .home-empty-icon svg { width: 26px; height: 26px; }

        /* Edit-profile form */
        .profile-form { display: grid; gap: 15px; margin-top: 16px; }
        .profile-field label { font-size: 12.5px; font-weight: 650; color: var(--text); display: block; margin-bottom: 6px; }
        .profile-field input, .profile-field textarea { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: 11px; font-size: 14px; font-family: inherit; background: var(--surface); color: var(--text); transition: border-color .15s, box-shadow .15s; }
        .profile-field textarea { resize: vertical; min-height: 96px; line-height: 1.55; }
        .profile-field input:focus, .profile-field textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }

        /* The awkward middle. A tablet, or a laptop window narrowed to half the
           screen, still has the 232px sidebar taking a chunk out of it, so the
           working area is far narrower than the viewport suggests. auto-fit at
           minmax(150px) put three tiles on one row and stranded the fourth on
           its own underneath -- and squeezed each one so the number and its
           icon fought for the same space. Two clean rows of two instead. */
        @media (min-width: 701px) and (max-width: 1080px) {
          .kpi-row, .home-stats { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
          .catalog-view#analyticsView { padding: 22px 20px 26px; }
          .an-two { grid-template-columns: minmax(0, 1fr); }
          .home-grid { grid-template-columns: 1fr; }
          .stat-tile { min-width: 0; }
          .brand-name { font-size: 26px; }
          .trend-chart-wrap { height: 210px; }
        }

        @media (max-width: 700px) {
          .list-pane { width: 100%; }
          .layout { position: relative; overflow: hidden; }
          /* List and thread are a real navigation on a phone, so they move
             like one: the thread slides in from the right, the list slides
             back in from the left. */
          .layout:not(.thread-open) .main { display: none; }
          .layout.thread-open .list-pane { display: none; }
          @keyframes paneInRight { from { opacity: 0; transform: translateX(22px); } to { opacity: 1; transform: none; } }
          @keyframes paneInLeft { from { opacity: 0; transform: translateX(-22px); } to { opacity: 1; transform: none; } }
          .layout.thread-open .main { animation: paneInRight .26s cubic-bezier(.22,1,.36,1) both; }
          .layout:not(.thread-open) .list-pane { animation: paneInLeft .24s cubic-bezier(.22,1,.36,1) both; }
          button.mobile-back-btn.icon-btn { display: flex; }
          .thread-header { flex-wrap: wrap; gap: 10px; }
          .thread-actions { flex-wrap: wrap; }
          .bubble-col { max-width: 78%; }
          .catalog-form { grid-template-columns: 1fr !important; }
          .fees-row { flex-direction: column; }
          .fees-row div { width: 100%; }
          /* The live numbers are Home's content now, not a band under the
             topbar on every tab. Two per row, compact. */
          /* On a phone the tile is restacked: the icon sits on its own line as
             a tinted mark, the number gets the room, and the context line is
             clipped to one line so four tiles can never turn into a wall of
             sentences. */
          .home-stats { grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
          .htile { padding: 13px 13px 12px; border-radius: 16px; }
          .htile-top { flex-direction: column; align-items: flex-start; gap: 9px; }
          .htile-icon { width: 30px; height: 30px; border-radius: 10px; }
          .htile-icon svg { width: 15px; height: 15px; }
          .htile-value { font-size: 25px; }
          .htile-label { font-size: 12px; margin-top: 8px; }
          .htile-context { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .htile::after { width: 82px; height: 82px; right: -30px; top: -38px; }
          /* A thin accent rule at the top of each tile, so the four read as a
             set of distinct things at a glance rather than four grey boxes. */
          .htile::before { content: ""; position: absolute; left: 13px; right: 13px; top: 0; height: 2.5px; border-radius: 0 0 3px 3px; background: var(--tint); opacity: 0.9; }
          .home-col { gap: 14px; }
          .wk-chart { height: 76px; gap: 5px; margin-top: 14px; }
          .wk-foot { margin-top: 13px; padding-top: 12px; }
          .wk-stat b { font-size: 15.5px; }
          .wk-stat span { font-size: 10.5px; }
          /* Two across on a phone, bigger than four squeezed ones, and the
             price stays visible rather than waiting for a hover that a touch
             screen never delivers. */
          .ptile-row { grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
          .ptile-img { border-radius: 12px; }
          .ptile-veil, .ptile-price { opacity: 1; transform: none; }
          .ptile-name { font-size: 11.5px; margin-top: 7px; }
          .ring-badge, .ring-badge svg { width: 40px; height: 40px; }
          .gap-chips { gap: 6px; margin-top: 14px; padding-top: 13px; }
          .gchip { font-size: 11px; padding: 4px 9px; }
          .stat-tile { min-width: 0; padding: 10px 11px; border-radius: 12px; flex-direction: row-reverse; align-items: center; gap: 9px; }
          .stat-tile::before { height: 0; }
          .stat-tile::after { display: none; }
          .stat-tile .stat-icon { width: 29px; height: 29px; border-radius: 9px; flex-shrink: 0; }
          .stat-tile .stat-icon svg { width: 14px; height: 14px; }
          .stat-tile .stat-value { font-size: 15.5px; letter-spacing: -0.2px; }
          .stat-tile .stat-label { font-size: 10.5px; margin-top: 1px; }
          .stat-tile:hover { transform: none; box-shadow: var(--shadow-sm); }
          /* Home on a phone. The masthead keeps its proportions -- a smaller
             cover and avatar, the same relationship between them -- so it
             still reads as a profile rather than a stack of boxes. */
          .home-view { padding: 14px 13px 24px; }
          .home-grid { grid-template-columns: minmax(0, 1fr); gap: 14px; }
          .brand-card { border-radius: 18px; margin-bottom: 16px; }
          .brand-cover { height: 120px; }
          .brand-body { padding: 0 17px 18px; }
          .brand-avatar-wrap { width: 78px; margin-top: -39px; margin-bottom: 13px; }
          .brand-avatar { width: 78px; height: 78px; border-radius: 24px; font-size: 29px; border-width: 4px; }
          .brand-name { font-size: 23px; }
          .brand-title-line { gap: 8px; }
          .live-pill { font-size: 10.5px; padding: 3px 9px 3px 7px; }
          .brand-tagline { font-size: 14px; margin-top: 6px; }
          /* The hairline separators only work on a single line. Once the row
             wraps -- which it does on a phone -- the last item on each line
             leaves a divider hanging in empty space, so spacing carries the
             separation here instead. */
          .brand-meta { gap: 6px 16px; margin-top: 12px; font-size: 12px; }
          .brand-meta span { padding-right: 0; border-right: none; }
          .brand-about { font-size: 13.5px; margin-top: 15px; padding-top: 15px; }
          .brand-head-row { flex-direction: column; gap: 0; }
          .brand-edit-btn { width: 100%; text-align: center; margin-top: 16px; padding: 10px 14px; }
          .cover-photo-btn { right: 11px; bottom: 11px; padding: 6px 11px; font-size: 11.5px; }
          .setup-card { padding: 16px 16px; border-radius: 16px; margin-bottom: 16px; }
          /* One per row. Two columns squeezed "Profile picture" and left the
             completed rows floating in half-width boxes with nothing in them. */
          .setup-steps { grid-template-columns: 1fr; gap: 6px; }
          .setup-step { font-size: 13px; padding: 10px 12px; gap: 10px; border-radius: 12px; }
          .setup-step .tick { width: 19px; height: 19px; }
          .setup-step.done { padding: 8px 12px; }
          .setup-title { font-size: 15px; }
          .setup-sub { font-size: 12.5px; }
          .setup-progress { margin-top: 13px; }
          .home-card { padding: 17px 16px; border-radius: 16px; }
          .home-alert { padding: 13px 15px; border-radius: 14px; font-size: 13px; }
          .cat-health { gap: 14px; }
          .health-ring, .health-ring svg { width: 74px; height: 74px; }
          .waiting-row { padding: 10px 8px; margin: 0 -8px; }
          .waiting-avatar { width: 36px; height: 36px; border-radius: 12px; }
          .waiting-chev { display: none; }
          .setup-actions .catalog-btn, .setup-actions .btn-quiet { width: 100%; justify-content: center; text-align: center; }
          /* Topbar on one row, with room to breathe. */
          /* Respects the notch / home indicator when installed to the home
             screen (viewport-fit=cover is set in the meta tag). */
          /* --vvh is the real visible height reported by visualViewport,
             which shrinks when the keyboard opens; 100dvh is the fallback
             where that API isn't available. */
          .app-shell, .main-column, .sidebar { height: var(--vvh, 100dvh); }
          /* Nothing above the thread is allowed to scroll. The app is a fixed
             pane the exact size of the visible area, and the only thing that
             moves inside it is the message list. Without this the page itself
             scrolls when the keyboard opens -- the composer can be dragged up
             out of reach and the header disappears. position:fixed is what
             actually stops iOS Safari, which ignores interactive-widget and
             will happily scroll the document behind its own keyboard. */
          html, body { height: var(--vvh, 100dvh); overflow: hidden; overscroll-behavior: none; }
          body { position: fixed; top: 0; left: 0; right: 0; width: 100%; }
          .topbar { flex-wrap: nowrap; gap: 8px; padding: calc(10px + env(safe-area-inset-top)) 14px 10px; }
          .msg-compose { padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
          .sidebar { padding-top: env(safe-area-inset-top); }
          .topbar-left { gap: 8px; flex: 1; min-width: 0; }
          .topbar h1 { font-size: 15px; overflow: hidden; text-overflow: ellipsis; }
          .topbar-biz { max-width: 40vw; padding: 3px 9px 3px 8px; font-size: 11.5px; }
          .topbar-right { gap: 8px; flex-shrink: 0; }
          .theme-toggle { width: 32px; height: 32px; }
          .topbar-avatar { width: 30px; height: 30px; font-size: 12.5px; box-shadow: 0 2px 6px var(--accent-shadow); }
          /* Thread header: identity on one line, one primary action beside it.
             Search, star and details move into the ⋮ menu rather than wrapping
             onto a second row. */
          .thread-header { flex-wrap: nowrap; gap: 8px; padding: 9px 12px; }
          .thread-header-id { gap: 9px; flex: 1; min-width: 0; }
          .thread-avatar { width: 34px; height: 34px; }
          .thread-avatar svg { width: 18px; height: 18px; }
          button.mobile-back-btn.icon-btn { width: 30px; height: 30px; }
          .thread-header-id { gap: 8px; }
          /* On a phone the meta line carries ONE fact, and it is a sentence:
             who is answering this customer right now. The number was fighting
             it for a 150px slot and losing -- which is what reduced the status
             to the bare word "Amara" with a green dot beside it, a label that
             says nothing. The number is still on the customer's row in the
             list and in the details panel, so nothing is actually lost. */
          .thread-meta .thread-sub { display: none; }
          .thread-meta .tm-phone { display: none; }
          .thread-meta .thread-status-chip .lbl-full { display: inline; }
          .thread-meta .thread-status-chip .lbl-short { display: none; }
          .thread-status-chip { font-size: 12px; }
          .thread-meta { gap: 0 8px; margin-top: 1px; }
          /* One item on the line, so no separator. A display:none sibling is
             still a sibling to "* + *", which is why a stray middot was
             floating on its own between the avatar and the status. */
          .thread-meta > * + *::before { content: none; margin-right: 0; }
          .thread-name { font-size: 15.5px; }
          .bubble-col { max-width: 84%; }
          .bubble { font-size: 14px; line-height: 1.41; padding: 7px 10px 8px 11px; }
          .thread { padding: 10px 14px 14px; }
          .day-divider { margin: 11px 0; }
          .thread-sub { display: none; }
          .thread-actions { gap: 6px; flex-wrap: nowrap; flex-shrink: 0; }
          .thread-actions .icon-btn.hide-sm { display: none; }
          .more-menu-dropdown button.menu-sm-only { display: block; }
          button.takeover-btn { padding: 7px 10px; font-size: 12.5px; max-width: 34vw; }
          .lbl-full { display: none; }
          .lbl-short { display: inline; }
          .thread-name { font-size: 15px; }
          .thread-header-id > div:last-child { min-width: 0; overflow: hidden; }
          .compose-hint { display: none; }
          /* Settings on a phone: label above, control below at full width,
             instead of a squeezed control fighting its own label. */
          .setting-row { flex-direction: column; align-items: stretch; gap: 10px; padding: 13px 0; }
          .setting-static { text-align: left; font-size: 14px; }
          .seg-control { width: 100%; }
          .seg-control button { flex: 1; padding: 8px 4px; }
          .swatches { justify-content: flex-start; }
          .setting-row .switch, .setting-row .btn-quiet { align-self: flex-start; }
          .setting-row .thread-status-chip { align-self: flex-start; }
          .catalog-card { padding: 16px 14px; }
          .fees-row { flex-direction: column; align-items: stretch; }
          .fees-row div { width: 100% !important; }
          .fees-row .catalog-btn { width: 100%; justify-content: center; }
          .layout.details-on .detail-pane { display: none; }

          /* ---- Catalog on a phone ----
             Was: a full-width card per product with a 4:3 photo, so seven
             products ran to roughly five screens of scrolling and the card
             header squeezed its own description into three lines beside the
             button. Now a two-column grid with square thumbs -- the same
             shape a phone shopping app uses -- and a header that stacks. */
          .catalog-card { padding: 15px 13px; margin-bottom: 14px; border-radius: 13px; }
          .catalog-card h2 { font-size: 14.5px; margin-bottom: 11px; }
          /* Stacked, but only the action button stretches -- align-items on
             stretch made every child full width, which turned the "14 days"
             chip into a full-width bar. */
          .card-head, .card-head-products { flex-direction: column; align-items: flex-start; gap: 10px; }
          .card-head > *, .card-head-products > * { max-width: 100%; }
          .card-head .catalog-btn, .card-head-products .catalog-btn { width: 100%; justify-content: center; padding: 10px 14px; }
          .card-head-products > div:last-child { width: 100%; }
          /* The sub-heading right above it already says "over the last 14
             days", so on a narrow screen the chip is repeating itself. */
          .card-head .period-chip { display: none; }
          /* Category chips scroll sideways instead of wrapping onto a second
             and third row and pushing the products off the screen. */
          .cat-filter { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
          .cat-filter::-webkit-scrollbar { display: none; }
          .cat-chip { flex: 0 0 auto; }
          .product-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
          .product-thumb { aspect-ratio: 1 / 1; }
          .product-thumb.no-photo::after { background-size: 24px 24px; }
          .product-body { padding: 9px 10px 10px; gap: 3px; }
          .product-name { font-size: 13px; line-height: 1.3; }
          .product-price { font-size: 13.5px; }
          .product-cat { font-size: 10px; padding: 2px 7px; }
          /* Bookings and services stack on a phone: the actions go full width
             under the detail rather than being squeezed beside it. */
          .bk-card, .svc-card { flex-wrap: wrap; gap: 10px 12px; padding: 12px 13px; }
          .bk-time { width: auto; padding-right: 12px; flex-direction: row; align-items: baseline; gap: 7px; }
          .bk-main { flex: 1 1 100%; order: 3; }
          .bk-actions, .svc-actions { flex: 1 1 100%; order: 4; }
          .bk-actions .pact, .svc-actions .pact { flex: 1; }
          .bk-actions .pact.danger, .svc-actions .pact.danger { flex: 0 0 auto; }
          .svc-main { flex: 1 1 100%; }
          .svc-meta { gap: 4px 10px; }
          .svc-meta > span { padding-right: 10px; }
          .bk-resched-row { gap: 8px; }
          .bk-resched-row .catalog-btn { width: 100%; justify-content: center; }
          .cat-toolbar { gap: 8px; margin-bottom: 10px; }
          .cat-search { min-width: 0; flex: 1 1 100%; }
          .cat-sort { flex: 1 1 100%; }
          .cat-sort select { flex: 1; }
          .cat-summary { gap: 4px 12px; font-size: 11.5px; }
          .cat-summary span { padding-right: 12px; }
          .product-actions { gap: 6px; padding: 0 10px 10px; }
          .pact { padding: 6px 8px; font-size: 11.5px; gap: 5px; }
          .thumb-cat, .thumb-sold { font-size: 9.5px; padding: 2px 7px; }
          .dropzone { padding: 14px; }
          .dropzone-preview img { max-height: 110px; }

          /* ---- Analytics on a phone ----
             The KPI tiles were desktop tiles at phone width: icon, big number,
             label and a sub-line each, four of them, before the chart even
             started. Halved in height, two per row. */
          .kpi-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-bottom: 16px; }
          .an-head { gap: 12px; margin-bottom: 13px; }
          .an-title { font-size: 18px; }
          .an-range { width: 100%; }
          .an-range button { flex: 1; }
          .an-two { grid-template-columns: minmax(0, 1fr); gap: 14px; }
          .dow-row { gap: 5px; margin-top: 15px; }
          .dow-slot { height: 68px; border-radius: 7px; }
          .dow-n { font-size: 11px; }
          .nr-legend { gap: 16px; }
          /* Same card, phone proportions: the mark shrinks, the figure stays
             the biggest thing in the card, and the pill gets its own line
             with room to ellipsis instead of wrapping out of the border. */
          .catalog-view#analyticsView { padding: 16px 14px 24px; }
          .kpi-card { padding: 11px 12px 11px 13px; border-radius: 14px; }
          .kpi-card::before { width: 2.5px; top: 9px; bottom: 9px; }
          .kpi-top { gap: 7px; }
          .kpi-mark { width: 25px; height: 25px; border-radius: 8px; }
          .kpi-mark svg { width: 13px; height: 13px; }
          .kpi-name { font-size: 9.5px; letter-spacing: 0.045em; }
          .kpi-figure { font-size: 19px; margin-top: 9px; letter-spacing: -0.025em; }
          .kpi-foot { margin-top: 7px; min-height: 18px; }
          .kpi-delta { font-size: 9.5px; padding: 3px 7px 3px 6px; gap: 3px; }
          .kpi-delta svg { width: 9px; height: 9px; }
          .trend-chart-wrap { height: 190px; padding-top: 4px; }
          .seller-row { padding: 10px 0; gap: 10px; }
          .seller-name { font-size: 13px; }
          .seller-rev { font-size: 13px; }
          .seller-units { font-size: 11px; }
          .conversion-stat { font-size: 30px; }
        }
        @media (max-width: 480px) {
          .topbar-date-chip { display: none; }
          .topbar h1 { font-size: 14px; }
        }
      </style>
    </head>
    <body>
    <div class="app-shell">
      <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="closeSidebar()"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">${brandMark({ dark: true, size: "small" })}</div>
        <div class="sidebar-profile">
          <div class="sidebar-profile-avatar">${escapeHtmlServer((businessName || "S").trim().charAt(0).toUpperCase())}</div>
          <div style="min-width:0;">
            <div class="sidebar-profile-name">${escapeHtmlServer(businessName || "Your business")}</div>
            <div class="sidebar-profile-role">${isBookable ? "Bookings &amp; services" : "Product seller"}</div>
          </div>
        </div>
        <div class="sidebar-section-label">Menu</div>
        <nav class="tabs">
          <button id="tabHome" class="active-tab" onclick="switchTab('home')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/></svg></span>Home</button>
          <button id="tabConversations" onclick="switchTab('conversations')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>Conversations<span class="nav-badge" id="navBadgeConversations" style="display:none;"></span></button>
          ${
            isBookable
              ? `<button id="tabServices" onclick="switchTab('services')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></span>Services</button>
          <button id="tabBookings" onclick="switchTab('bookings')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>Bookings</button>`
              : `<button id="tabCatalog" onclick="switchTab('catalog')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></span>Catalog</button>`
          }
          <button id="tabAnalytics" onclick="switchTab('analytics')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg></span>Analytics</button>
          <button id="tabSettings" onclick="switchTab('settings')"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.66 1.03 1.28 1.06H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>Settings</button>
        </nav>
        <div class="sidebar-footer">
          <span class="live-indicator" title="This dashboard refreshes itself automatically every few seconds"><span class="live-dot"></span>Live</span>
          <a class="sidebar-footer-link" href="/customers?key=${key}${sellerId ? "&sellerId=" + encodeURIComponent(sellerId) : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>Plain table view</a>
          ${key ? `<a class="sidebar-footer-link" href="/admin?key=${key}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>All sellers</a>` : ""}
        </div>
      </aside>
      <div class="main-column">
      <header class="topbar">
        <div class="topbar-left">
          <button class="hamburger-btn" id="hamburgerBtn" onclick="toggleSidebar()" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
          <h1>Live Dashboard</h1>
          ${businessName ? `<span class="topbar-biz" title="${escapeHtmlServer(businessName)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg><span>${escapeHtmlServer(businessName)}</span></span>` : ""}
        </div>
        <div class="topbar-right">
          <span class="topbar-date-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/></svg><span id="topbarDate"></span></span>
          <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Switch between light and dark" aria-label="Switch theme">
            <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>
            <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          </button>
          <span class="topbar-avatar" title="${escapeHtmlServer(businessName || "Your business")}">${escapeHtmlServer((businessName || "S").trim().charAt(0).toUpperCase())}</span>
        </div>
      </header>
      <div class="home-view" id="homeView"></div>
      <div class="layout" id="conversationsView" style="display:none;">
        <div class="list-pane">
          <div class="search-box"><div class="search-box-inner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="searchBox" placeholder="Search by name, phone or reason..." oninput="applyFilter()"></div></div>
          <div class="list-tabs">
            <button class="list-tab active-list-tab" id="tab-all" onclick="setTab('all')" title="All conversations"><span class="list-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg></span><span class="list-tab-label">All</span><span class="list-tab-count">0</span></button>
            <button class="list-tab" id="tab-active" onclick="setTab('active')" title="Amara is handling these"><span class="list-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span><span class="list-tab-label">Active</span><span class="list-tab-count">0</span></button>
            <button class="list-tab" id="tab-paused" onclick="setTab('paused')" title="Paused — you're handling these"><span class="list-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg></span><span class="list-tab-label">Paused</span><span class="list-tab-count">0</span></button>
            <button class="list-tab" id="tab-starred" onclick="setTab('starred')" title="Starred"><span class="list-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 3 14.9 8.9 21.5 9.8 16.7 14.4 17.9 21 12 17.9 6.1 21 7.3 14.4 2.5 9.8 9.1 8.9 12 3"/></svg></span><span class="list-tab-label">Starred</span><span class="list-tab-count">0</span></button>
          </div>
          <div class="list" id="list"><div class="skeleton-row"><div class="sk sk-avatar"></div><div class="sk-lines"><div class="sk sk-line" style="width:62%"></div><div class="sk sk-line" style="width:40%"></div></div></div><div class="skeleton-row"><div class="sk sk-avatar"></div><div class="sk-lines"><div class="sk sk-line" style="width:54%"></div><div class="sk sk-line" style="width:34%"></div></div></div><div class="skeleton-row"><div class="sk sk-avatar"></div><div class="sk-lines"><div class="sk sk-line" style="width:58%"></div><div class="sk sk-line" style="width:44%"></div></div></div></div>
        </div>
        <div class="main" id="main"><div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div><div class="empty-title">Select a conversation</div><div class="empty-sub">Pick a customer from the list on the left to see the full thread.</div></div></div>
        <aside class="detail-pane" id="detailPane"></aside>
      </div>
      <div class="catalog-view" id="catalogView" style="display:none;">
        <div class="catalog-card">
          <div class="card-head card-head-products">
            <div>
              <h2>Products</h2>
              <div class="card-sub">What Amara can quote, describe and sell on your behalf.</div>
            </div>
            <span class="catalog-msg" id="catalogStatus" style="margin-right:10px;"></span>
            <button class="catalog-btn" id="addProductBtn" onclick="openProductForm()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add product
            </button>
          </div>
          <div class="cat-toolbar">
            <div class="cat-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="productSearch" placeholder="Search products" oninput="renderProductGrid()" autocomplete="off">
            </div>
            <div class="cat-sort">
              <label for="productSort">Sort</label>
              <select id="productSort" onchange="renderProductGrid()">
                <option value="name">Name</option>
                <option value="price-desc">Price, high to low</option>
                <option value="price-asc">Price, low to high</option>
                <option value="sold">Best selling</option>
                <option value="incomplete">Needs attention</option>
              </select>
            </div>
          </div>
          <div class="cat-filter" id="categoryFilter"></div>
          <div class="product-grid" id="productGrid"></div>
          <div class="cat-summary" id="catalogSummary"></div>
          <div class="inline-panel" id="productPanel" style="display:none;">
            <div class="inline-panel-head">
              <span id="productPanelTitle">New product</span>
              <button class="icon-btn small-icon-btn" onclick="closeProductForm()" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div id="productEditingNote" style="display:none;font-size:12px;color:var(--muted);margin-bottom:10px;">
              Editing "<b id="productEditingName"></b>" -- <a href="#" onclick="cancelEditProduct();return false;">cancel, add a new product instead</a>
            </div>
            <input type="hidden" id="pKey">
            <div class="field-grid">
              <div class="field">
                <label>Name</label>
                <input id="pName" placeholder="e.g. Plain white tee">
              </div>
              <div class="field">
                <label>Price (N)</label>
                <input id="pPrice" type="number" min="1" placeholder="7500">
              </div>
              <div class="field field-full">
                <label>Category</label>
                <div class="field-hint">Your own grouping &mdash; Amara uses it to answer questions like "what hoodies do you have?". Leave blank if you don't group products.</div>
                <input id="pCategory" list="categorySuggestions" placeholder="e.g. Tees">
                <datalist id="categorySuggestions"></datalist>
              </div>
              <div class="field field-full">
                <label>Description</label>
                <div class="field-hint">Materials, sizes, colours &mdash; anything Amara needs to answer questions accurately.</div>
                <textarea id="pDescription" rows="2" placeholder="e.g. 100% cotton, true to size, available in S-XL, machine washable"></textarea>
              </div>
              <div class="field field-full">
                <label>Photo</label>
                <div class="field-hint">This is the exact image Amara sends a customer who asks to see it. Drag one in, or click to choose. Max 1.5MB.</div>
                <div class="dropzone" id="photoDrop" tabindex="0" role="button" aria-label="Choose or drop a product photo"
                     onclick="document.getElementById('pPhotoFile').click()"
                     onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('pPhotoFile').click();}">
                  <input id="pPhotoFile" type="file" accept="image/*" hidden onchange="handlePhotoPick(this.files)">
                  <div class="dropzone-empty" id="dropEmpty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 15-5-5L6 20"/></svg>
                    <div class="dropzone-title">Drop a photo here</div>
                    <div class="dropzone-sub">or click to browse &mdash; PNG or JPG, up to 1.5MB</div>
                  </div>
                  <div class="dropzone-preview" id="dropPreview" style="display:none;">
                    <img id="dropPreviewImg" alt="Selected product photo">
                    <div class="dropzone-meta"><span id="dropFileName"></span><button type="button" class="btn-quiet btn-tiny" onclick="event.stopPropagation();clearPhotoPick()">Remove</button></div>
                  </div>
                </div>
              </div>
              <div class="field field-full">
                <label>...or paste a photo URL instead</label>
                <div class="field-hint">Use this if the image already lives online somewhere.</div>
                <input id="pImageUrl" placeholder="https://...">
              </div>
            </div>
            <div class="inline-panel-actions">
              <button class="catalog-btn" onclick="saveProduct()">Save product</button>
              <button class="btn-quiet" onclick="closeProductForm()">Cancel</button>
              <span class="catalog-msg" id="catalogMsg"></span>
            </div>
          </div>
        </div>
        <div class="catalog-card">
          <h2>Delivery fees</h2>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
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
          <div class="fees-row" style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px;">
            <div style="width:280px;">
              <label>Fallback fee for any other state (N)</label>
              <input id="feeDefault" type="number" min="0" placeholder="Leave blank = don't deliver there yet">
            </div>
            <button class="catalog-btn" onclick="saveDeliveryDefaultFee()">Save fallback fee</button>
          </div>
          <div class="catalog-msg" id="feesMsg"></div>
        </div>
      </div>
      <div class="catalog-view" id="servicesView" style="display:none;">
        <div class="catalog-card">
          <div class="card-head">
            <div>
              <h2>Services</h2>
              <div class="card-sub">What Amara can quote, describe and book on your behalf.</div>
            </div>
            <button class="catalog-btn" id="addServiceBtn" onclick="openOfferingForm()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add service
            </button>
          </div>
          <div id="offeringsList"></div>
          <div class="inline-panel" id="offeringPanel" style="display:none;">
            <div class="inline-panel-head">
              <span id="offeringPanelTitle">New service</span>
              <button class="icon-btn small-icon-btn" onclick="closeOfferingForm()" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <input type="hidden" id="oKey">
            <div id="offeringEditingNote" style="display:none;" class="edit-note">
              Editing <b id="offeringEditingName"></b> &mdash; <a href="#" onclick="cancelEditOffering();return false;">cancel and add a new one instead</a>
            </div>

            <div class="form-step">
              <div class="form-step-label"><span class="form-step-num">1</span>What it is</div>
              <div class="field-grid">
                <div class="field field-full">
                  <label for="oName">Service name</label>
                  <input id="oName" placeholder="e.g. Knotless Box Braids">
                </div>
                <div class="field field-full">
                  <label for="oDescription">What's included</label>
                  <div class="field-hint">Anything a customer would ask before booking. Amara answers from this.</div>
                  <textarea id="oDescription" rows="2" placeholder="e.g. Washing, sectioning and braiding. Extensions not included."></textarea>
                </div>
              </div>
            </div>

            <div class="form-step">
              <div class="form-step-label"><span class="form-step-num">2</span>Price and how long it takes</div>
              <div class="field-grid">
                <div class="field">
                  <label for="oPrice">Price</label>
                  <div class="input-prefix"><span>N</span><input id="oPrice" type="number" min="1" placeholder="15000"></div>
                </div>
                <div class="field">
                  <label for="oDuration">Duration</label>
                  <div class="input-suffix"><input id="oDuration" type="number" min="1" max="480" placeholder="30"><span>minutes</span></div>
                </div>
              </div>
            </div>

            <div class="form-step">
              <div class="form-step-label"><span class="form-step-num">3</span>How it's delivered</div>
              <div class="field-hint" style="margin-bottom:9px;">So Amara can answer "is this online?" without coming back to you.</div>
              <div class="choice-row" id="oDeliveryChoices">
                <button type="button" class="choice" data-delivery="in_person">In person</button>
                <button type="button" class="choice" data-delivery="online">Online</button>
                <button type="button" class="choice" data-delivery="either">Either</button>
                <button type="button" class="choice" data-delivery="">Not sure yet</button>
              </div>
              <select id="oDeliveryMode" class="visually-hidden" tabindex="-1" aria-hidden="true">
                <option value="">Not set</option>
                <option value="online">Online only</option>
                <option value="in_person">In-person only</option>
                <option value="either">Either</option>
              </select>
            </div>

            <div class="inline-panel-actions">
              <button class="catalog-btn" onclick="saveOffering()">Save service</button>
              <button class="btn-quiet" onclick="closeOfferingForm()">Cancel</button>
              <span class="catalog-msg" id="offeringsMsg"></span>
            </div>
          </div>
        </div>
        <div class="catalog-card">
          <h2>Weekly availability</h2>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
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
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Block a specific date (holiday, personal day) without touching the weekly schedule.</div>
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
          <div class="card-head">
            <div>
              <h2 id="bookingsHeading">Upcoming bookings</h2>
              <div class="card-sub">Everything Amara has booked in, soonest first.</div>
            </div>
          </div>
          <div id="bookingsList"></div>
        </div>
      </div>
      <div class="catalog-view" id="settingsView" style="display:none;">
        <div class="catalog-card">
          <h2>Appearance</h2>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Theme</div>
              <div class="setting-desc">Applies on this browser. New sessions follow your device setting until you choose.</div>
            </div>
            <div class="seg-control" id="themeSeg">
              <button data-theme-choice="light" onclick="setThemeChoice('light')">Light</button>
              <button data-theme-choice="dark" onclick="setThemeChoice('dark')">Dark</button>
              <button data-theme-choice="system" onclick="setThemeChoice('system')">System</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Accent colour</div>
              <div class="setting-desc">Used for buttons, highlights and Amara's replies in the conversation.</div>
            </div>
            <div class="swatches" id="accentSwatches"></div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Density</div>
              <div class="setting-desc">Compact fits more conversations and products on screen at once.</div>
            </div>
            <div class="seg-control" id="densitySeg">
              <button data-density-choice="comfortable" onclick="setDensity('comfortable')">Comfortable</button>
              <button data-density-choice="compact" onclick="setDensity('compact')">Compact</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Customer details panel</div>
              <div class="setting-desc">Show the panel beside a conversation by default on wide screens.</div>
            </div>
            <button class="switch" id="detailsSwitch" role="switch" onclick="toggleDetailDefault()"><span></span></button>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Setup checklist</div>
              <div class="setting-desc">The "finish setting up your shop" card on Home. It hides itself once everything on it is done.</div>
            </div>
            <button class="switch" id="setupSwitch" role="switch" onclick="setSetupDismissed(!homeSetupHidden())"><span></span></button>
          </div>
          <div class="setting-row" id="hapticsRow">
            <div class="setting-text">
              <div class="setting-name">Tap feedback</div>
              <div class="setting-desc" id="hapticsDesc">A short buzz when you switch tabs or open a conversation.</div>
            </div>
            <button class="switch" id="hapticsSwitch" role="switch" onclick="setHaptics(!hapticsEnabled())"><span></span></button>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Full screen</div>
              <div class="setting-desc" id="fullscreenDesc">Hides the browser bars so the dashboard fills the screen.</div>
            </div>
            <button class="btn-quiet" id="fullscreenBtn" onclick="toggleFullscreen()">Enter full screen</button>
          </div>
        </div>
        <div class="catalog-card">
          <h2>Live updates</h2>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Refresh rate</div>
              <div class="setting-desc">How often this dashboard checks for new messages. Slower saves mobile data; Off means it only updates when you reload.</div>
            </div>
            <div class="seg-control" id="refreshSeg">
              <button data-refresh-choice="5000" onclick="setRefreshRate(5000)">5s</button>
              <button data-refresh-choice="15000" onclick="setRefreshRate(15000)">15s</button>
              <button data-refresh-choice="30000" onclick="setRefreshRate(30000)">30s</button>
              <button data-refresh-choice="0" onclick="setRefreshRate(0)">Off</button>
            </div>
          </div>
        </div>
        <div class="catalog-card">
          <h2>WhatsApp connection</h2>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Status</div>
              <div class="setting-desc">Amara can only send and receive once your WhatsApp Business number is connected.</div>
            </div>
            <span class="thread-status-chip${whatsappConnected ? "" : " is-paused"}"><span class="chip-dot"></span>${whatsappConnected ? "Connected" : "Not connected"}</span>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Alerts go to</div>
              <div class="setting-desc">The number Amara messages when she hands a conversation back to you.</div>
            </div>
            <div class="setting-static">${ownerAlertNumber ? escapeHtmlServer(ownerAlertNumber) : "Not set"}</div>
          </div>
          <div class="setting-note">${whatsappConnected
            ? "Connected numbers are managed by Stafly.AI. Reply to your setup contact if you need to change the number Amara sends from or alerts."
            : "Your number isn't connected yet, so Amara can't reply to customers. Reply to your Stafly.AI setup contact to finish connecting it."}</div>
        </div>
        <div class="catalog-card">
          <h2>Bank transfer details</h2>
          <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Offered to a customer only if they specifically ask to pay by bank transfer instead of the payment link.</div>
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
            <button class="catalog-btn small" style="background:transparent;color:var(--accent);padding:4px 0;" onclick="showBank2Form()">+ Add a second account</button>
          </div>
          <div id="bank2Form" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9;">
            <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">A second option, in case a customer's bank can't send to the first account. Amara only mentions this one if asked for an alternative.</div>
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
            <button class="catalog-btn small" style="background:transparent;color:var(--danger);padding:4px 0;margin-top:6px;" onclick="removeBankDetails2()">Remove second account</button>
            <div class="catalog-msg" id="bank2Msg"></div>
          </div>
        </div>
        <div class="catalog-card">
          <h2>Your data</h2>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Export customers</div>
              <div class="setting-desc">Downloads every customer currently loaded here as a CSV &mdash; phone, status, message count, first and last contact, and any payment.</div>
            </div>
            <button class="btn-quiet" onclick="exportCustomersCsv()">Download CSV</button>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Sign out</div>
              <div class="setting-desc">Ends this session on this browser. Amara keeps running and keeps replying to customers.</div>
            </div>
            <button class="btn-quiet danger-quiet" onclick="signOut()">Sign out</button>
          </div>
        </div>
        <div class="catalog-card">
          <h2>Business</h2>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Business name</div>
              <div class="setting-desc">Shown to you here, and used by Amara when she introduces your shop.</div>
            </div>
            <div class="setting-static">${escapeHtmlServer(businessName || "Not set")}</div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-name">Business type</div>
              <div class="setting-desc">Decides whether Amara sells products or takes bookings.</div>
            </div>
            <div class="setting-static">${isBookable ? "Bookings &amp; services" : "Product seller"}</div>
          </div>
          <div class="setting-note">These were set when your account was created. To change either one, reply to your Stafly.AI setup contact &mdash; changing them mid-flight affects how Amara answers live customers, so it isn't a self-serve switch yet.</div>
        </div>
      </div>
      <div class="catalog-view" id="analyticsView" style="display:none;">
        <!-- Every figure below is derived from the same 14-day trend the
             chart draws, or from stored payment records. Nothing here is
             projected, estimated or benchmarked. -->
        <div class="an-head">
          <div>
            <h2 class="an-title">Analytics</h2>
            <div class="card-sub" id="anRangeLabel">Last 14 days</div>
          </div>
          <div class="seg-control an-range" id="anRange">
            <button data-days="7" onclick="setAnalyticsRange(7)">7d</button>
            <button data-days="14" class="seg-active" onclick="setAnalyticsRange(14)">14d</button>
            <button data-days="30" onclick="setAnalyticsRange(30)">30d</button>
          </div>
        </div>
        <div class="kpi-row" id="analyticsKpis"></div>
        <div class="catalog-card">
          <div class="card-head">
            <div>
              <h2>Revenue</h2>
              <div class="card-sub" id="revenueCardSub">Paid orders over the last 14 days.</div>
            </div>
          </div>
          <div class="trend-chart-wrap"><canvas id="trendChart"></canvas></div>
        </div>
        <div class="an-two">
          <div class="catalog-card">
            <div class="card-head">
              <div>
                <h2>Busiest days</h2>
                <div class="card-sub">Which days of the week orders actually land on.</div>
              </div>
            </div>
            <div class="dow-row" id="dowRow"></div>
          </div>
          <div class="catalog-card">
            <div class="card-head">
              <div>
                <h2>New and returning</h2>
                <div class="card-sub" id="nrSub">People who messaged you in this window.</div>
              </div>
            </div>
            <div id="newReturning"></div>
          </div>
        </div>
        <div class="catalog-card">
          <div class="card-head">
            <div>
              <h2>Best sellers</h2>
              <div class="card-sub">By units sold, across every paid order.</div>
            </div>
          </div>
          <div id="bestSellersList"></div>
        </div>
        <div class="catalog-card">
          <div class="card-head">
            <div>
              <h2>Chat to order</h2>
              <div class="card-sub">How many people who ever messaged you have gone on to pay.</div>
            </div>
          </div>
          <div class="conversion-block">
            <div class="conversion-stat" id="conversionStat">&mdash;</div>
            <div class="conversion-meter"><div class="conversion-fill" id="conversionFill" style="width:0%"></div></div>
            <div class="conversion-sub" id="conversionSub"></div>
          </div>
        </div>
      </div>
      </div>
    </div>
      <script src="/vendor/chart.js"></script>
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

        // ---- Toasts -------------------------------------------------------
        // One place for "that worked" and "that didn't". Uses the Web
        // Animations API for the same reason the view transition does: it
        // needs no reflow and stays on the compositor.
        function toast(title, opts) {
          const o = opts || {};
          let stack = document.getElementById("toastStack");
          if (!stack) {
            stack = document.createElement("div");
            stack.id = "toastStack";
            stack.className = "toast-stack";
            stack.setAttribute("role", "status");
            stack.setAttribute("aria-live", "polite");
            document.body.appendChild(stack);
          }
          const kind = o.kind === "bad" ? "bad" : o.kind === "info" ? "info" : "ok";
          const icon = kind === "bad" ? ICON_ALERT : kind === "info" ? ICON_INFO : ICON_CHECK;
          const el = document.createElement("div");
          el.className = "toast " + kind;
          el.innerHTML =
            '<span class="toast-icon">' + icon + '</span>' +
            '<div class="toast-body"><div class="toast-title"></div>' +
            (o.sub ? '<div class="toast-sub"></div>' : '') + '</div>';
          // textContent rather than interpolation: some of these carry a
          // server error message or a product name straight from input.
          el.querySelector(".toast-title").textContent = title;
          if (o.sub) el.querySelector(".toast-sub").textContent = o.sub;
          stack.appendChild(el);
          const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const fromY = window.innerWidth <= 700 ? -14 : 14;
          if (el.animate && !reduce) {
            el.animate([{ opacity: 0, transform: "translateY(" + fromY + "px)" }, { opacity: 1, transform: "none" }],
              { duration: 220, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
          }
          const life = o.kind === "bad" ? 6000 : 3200;
          setTimeout(() => {
            if (!el.isConnected) return;
            if (el.animate && !reduce) {
              const out = el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(" + (fromY / 2) + "px)" }],
                { duration: 200, easing: "ease-in", fill: "both" });
              out.finished.then(() => el.remove()).catch(() => el.remove());
            } else {
              el.remove();
            }
          }, life);
        }

        // Every save in this file already wrote a small inline message next to
        // its form. flash() keeps that -- it is still the right place for the
        // detail -- and adds the toast, so the outcome is visible even when
        // you are looking somewhere else or the form has scrolled away.
        function flash(el, text, kind, title) {
          const bad = kind === "bad" || kind === "error";
          if (el) {
            el.textContent = text;
            el.className = text ? "catalog-msg " + (bad ? "error" : "ok") : "catalog-msg";
          }
          const sub = title && text ? text : undefined;
          toast(title || text, bad ? { kind: "bad", sub: sub } : { sub: sub });
        }

        function escapeHtml(str) {
          return String(str || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
        }

        // Real customers have no photo on file -- WhatsApp doesn't hand one
        // over, and inventing one would be fake data in a dashboard that's
        // otherwise careful never to show anything that isn't real. So
        // instead of one generic gray phone-icon circle for every row (the
        // old look), each phone number gets its own small, consistent
        // "contact chip" -- two real digits from their own number, on a
        // color picked deterministically from a small curated palette so
        // the same customer always lands on the same color and the list
        // reads as genuinely distinct people, the same pattern Slack/Gmail
        // use for contacts without a picture.
        const AVATAR_PALETTE = ["#4f46e5", "#0891b2", "#be185d", "#b45309", "#15803d", "#7c3aed", "#0f766e", "#c2410c", "#1d4ed8", "#a21caf"];
        function avatarColorFor(phone) {
          const str = String(phone || "");
          let hash = 0;
          for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
          return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
        }
        function avatarStyleFor(phone) {
          return "background:" + avatarColorFor(phone) + ";";
        }

        // A raw WhatsApp phone number ("2348087014578") is real data, but as
        // a wall of 13 identical-weight digits it's genuinely hard to scan --
        // this only re-groups the SAME real digits for readability, never
        // invents or hides any of them.
        // A customer's WhatsApp profile name when Meta gave us one, otherwise
        // their formatted number. The name is what THEY set on their own
        // account -- unverified and changeable -- so the number always stays
        // visible somewhere nearby rather than being replaced outright.
        function displayNameFor(c) {
          const n = (c && c.wa_name || "").trim();
          return n || formatPhoneDisplay(c && c.phone);
        }
        function hasWaName(c) {
          return !!((c && c.wa_name || "").trim());
        }
        // Initials from a real name read far better than two digits.
        function avatarTextFor(c) {
          const n = (c && c.wa_name || "").trim();
          if (!n) return "";
          const parts = n.split(/\s+/).filter(Boolean);
          const first = parts[0] ? parts[0][0] : "";
          const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
          return (first + second).toUpperCase();
        }
        function formatPhoneDisplay(phone) {
          const digits = String(phone || "").replace(/\\D/g, "");
          if (!digits) return phone || "";
          if (digits.length === 13 && digits.startsWith("234")) {
            return "+234 " + digits.slice(3, 6) + " " + digits.slice(6, 9) + " " + digits.slice(9);
          }
          if (digits.length === 11) {
            return digits.slice(0, 4) + " " + digits.slice(4, 7) + " " + digits.slice(7);
          }
          if (digits.length > 7) {
            return "+" + digits.slice(0, digits.length - 7) + " " + digits.slice(-7, -4) + " " + digits.slice(-4);
          }
          return digits;
        }

        // Relative time for real timestamps we actually store (last_contact)
        // -- never used to imply live "online" presence, which WhatsApp
        // doesn't give us at all.
        function timeAgo(dateStr) {
          if (!dateStr) return "";
          const then = new Date(dateStr).getTime();
          if (isNaN(then)) return "";
          const mins = Math.floor((Date.now() - then) / 60000);
          if (mins < 1) return "just now";
          if (mins < 60) return mins + "m ago";
          const hours = Math.floor(mins / 60);
          if (hours < 24) return hours + "h ago";
          const days = Math.floor(hours / 24);
          if (days < 7) return days + "d ago";
          return new Date(dateStr).toLocaleDateString();
        }

        // Every NEW message from this round forward carries a real "at"
        // timestamp (see history.push(...) call sites in the server code --
        // stamped the moment it's actually added to the conversation).
        // Messages saved before this change won't have one, and that's
        // shown honestly as no time at all rather than a guessed one --
        // see renderBubblesHtml below.
        function isSameCalendarDay(a, b) {
          return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
        }
        function formatDayDivider(ts) {
          const d = new Date(ts);
          const now = new Date();
          if (isSameCalendarDay(d, now)) return "Today";
          const yesterday = new Date(now);
          yesterday.setDate(now.getDate() - 1);
          if (isSameCalendarDay(d, yesterday)) return "Yesterday";
          return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        }
        function formatBubbleTime(ts) {
          return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        }

        async function loadDashboard() {
          try {
            const res = await fetch("/api/dashboard-data?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            customersCache = data.customers;
            renderStats(data.stats);
            updateListTabCounts();
            // Home shows live state too, so it follows the same poll -- but
            // only while it is the tab on screen, so an open Conversations
            // view isn't paying for a request it can't show.
            if (document.body.getAttribute("data-tab") === "home") loadHome();
            // The poll runs every 5s whether or not anything changed. Diffing
            // the rendered rows against a cheap signature means an idle
            // dashboard does no DOM work at all, instead of rebuilding the
            // whole list (and dropping any text selection or hover with it)
            // twelve times a minute.
            const filtered = getFilteredCustomers();
            if (listSignature(filtered) !== lastListSignature) renderList(filtered);
            if (selectedPhone) loadConversation(selectedPhone, false);
          } catch (err) {
            console.error("dashboard load failed", err);
          }
        }

        // Small hand-written stroke icons (same visual family as the
        // marketing site's lucide-react icons, just inlined as raw SVG
        // since this dashboard has no build step / icon package of its
        // own) -- one per stat tile, so each reads at a glance instead of
        // every tile being the same undifferentiated block of text.
        const ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
        const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>';
        const ICON_WALLET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
        const ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
        const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        const ICON_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        const ICON_STAR_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
        const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
        const ICON_EMOJI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
        const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        const ICON_SIDEPANEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><line x1="15" y1="4" x2="15" y2="20"/></svg>';
        const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        const ICON_TREND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>';
        const ICON_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
        const ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
        const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
        const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m3.6 17.5 4.9-4.4a2 2 0 0 1 2.7 0l3.4 3.1a2 2 0 0 0 2.7 0l3.1-2.8"/></svg>';
        const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/></svg>';
        const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        // WhatsApp gives us no profile photo and no name, so a contact chip
        // shows a person mark rather than repeating digits we already print
        // as text right beside it -- the per-contact colour is what makes
        // one customer visually distinct from another.
        const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8.2" r="4"/><path d="M12 13.6c-4.2 0-7.2 2.3-7.2 5.2 0 .7.5 1.2 1.2 1.2h12c.7 0 1.2-.5 1.2-1.2 0-2.9-3-5.2-7.2-5.2z"/></svg>';
        // Real WhatsApp-sendable unicode emoji, nothing that needs a font or
        // library to render -- inserted straight into the compose textarea.
        const EMOJI_SET = ["😀","😂","😍","👍","🙏","🎉","❤️","😊","🔥","👏","😢","😅","🤔","💯","✅","⏳","📦","💰","🙌","😎"];

        function statTile(cls, icon, value, label) {
          return '<div class="stat-tile ' + cls + '"><div><div class="stat-value">' + value + '</div><div class="stat-label">' + label + '</div></div><div class="stat-icon">' + icon + '</div></div>';
        }

        // Counts up to the REAL figure on first paint only -- the end value is
        // always the true number, this just animates the way there. Respects
        // prefers-reduced-motion by jumping straight to the final value.
        function countUp(el, target, prefix) {
          const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const finalText = (prefix || "") + Math.round(target).toLocaleString();
          if (reduce || target <= 0) { el.textContent = finalText; return; }
          const duration = 650;
          const start = performance.now();
          function step(now) {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = (prefix || "") + Math.round(target * eased).toLocaleString();
            if (t < 1) requestAnimationFrame(step);
            else el.textContent = finalText;
          }
          requestAnimationFrame(step);
        }

        // Only the very first render gets the fade-in -- renderStats() runs
        // again on every 5s poll, and replaying the animation every single
        // time would read as a flicker, not a flourish.
        let statsAnimated = false;
        let trendChartInstance = null;
        let lastRenderedCount = 0; // messages already on screen, for the new-bubble animation
        // These four numbers used to sit in a strip under the topbar on every
        // tab, which put dashboard context above the catalogue and the
        // settings form where it had nothing to do with the task at hand.
        // They live on Home now, as content rather than as a header band.
        // The 5s poll still drives them, so they stay live.
        // Home owns its own tiles now (see renderHomeStats), because they
        // carry a second line of context this function has no access to. This
        // stays as the single place the poll hands stats to, so nothing else
        // has to know where they ended up.
        let lastStats = null;
        function renderStats(stats) {
          lastStats = stats;
        }

        // Which list-tab is active -- each one maps to a real stored field
        // (paused / starred), never a fabricated bucket.
        let currentTab = "all";
        let animateNextList = true; // first paint staggers; polls do not
        let lastListSignature = null; // lets an unchanged poll skip re-rendering
        function setTab(tab) {
          currentTab = tab;
          animateNextList = true;
          document.querySelectorAll(".list-tab").forEach((b) => b.classList.remove("active-list-tab"));
          const btn = document.getElementById("tab-" + tab);
          if (btn) btn.classList.add("active-list-tab");
          renderList(getFilteredCustomers());
        }

        function getFilteredCustomers() {
          let list = customersCache;
          if (currentTab === "active") list = list.filter((c) => c.paused !== "yes");
          else if (currentTab === "paused") list = list.filter((c) => c.paused === "yes");
          else if (currentTab === "starred") list = list.filter((c) => c.starred === "yes");
          const q = (document.getElementById("searchBox").value || "").trim().toLowerCase();
          if (!q) return list;
          return list.filter((c) =>
            (c.phone || "").toLowerCase().indexOf(q) !== -1 ||
            (c.wa_name || "").toLowerCase().indexOf(q) !== -1 ||
            (c.last_escalation_reason || "").toLowerCase().indexOf(q) !== -1
          );
        }

        function applyFilter() {
          renderList(getFilteredCustomers());
        }

        // Real counts on every tab (like Fillow's "Inbox (2,456)"), plus the
        // sidebar's red badge -- both computed from data already on the
        // page, nothing fetched separately. The badge specifically counts
        // customers who are BOTH paused (the owner took over) AND whose
        // last message was from the customer (last_message_role, stamped by
        // saveConversation on the server every time a message is saved) --
        // i.e. genuinely waiting on a reply from the owner, not just "any
        // paused chat" which the Paused stat tile already covers.
        function updateListTabCounts() {
          // Only the count chip is rewritten -- the label markup stays put,
          // so the star glyph never gets re-escaped on every poll.
          const setCount = (id, n) => {
            const el = document.getElementById(id);
            const countEl = el && el.querySelector(".list-tab-count");
            if (countEl) countEl.textContent = String(n);
          };
          setCount("tab-all", customersCache.length);
          setCount("tab-active", customersCache.filter((c) => c.paused !== "yes").length);
          setCount("tab-paused", customersCache.filter((c) => c.paused === "yes").length);
          setCount("tab-starred", customersCache.filter((c) => c.starred === "yes").length);
          const needsReply = customersCache.filter((c) => c.paused === "yes" && c.last_message_role === "user").length;
          const badge = document.getElementById("navBadgeConversations");
          if (badge) {
            badge.textContent = needsReply > 0 ? String(needsReply) : "";
            badge.style.display = needsReply > 0 ? "inline-block" : "none";
          }
        }

        const TAB_EMPTY_TEXT = {
          all: "Once someone messages your WhatsApp number, they'll show up here.",
          active: "No active conversations right now.",
          paused: "Nothing's paused right now -- Amara is handling every conversation.",
          starred: "Star a conversation from its thread header to pin it here.",
        };
        // Cheap fingerprint of everything a rendered row actually shows, so
        // the 5s poll can skip the DOM entirely when nothing has changed.
        function listSignature(customers) {
          return currentTab + "|" + selectedPhone + "|" + customers.map((c) =>
            [c.phone, c.wa_name, c.paused, c.starred, c.last_contact, c.last_payment_at,
             c.last_escalation_reason, c.last_message_preview, c.message_count].join("~")
          ).join("|");
        }
        function renderList(customers) {
          lastListSignature = listSignature(customers);
          const list = document.getElementById("list");
          if (customers.length === 0) {
            list.innerHTML = '<div class="empty"><div class="empty-icon">' + ICON_USERS + '</div><div class="empty-title">No ' + (currentTab === "all" ? "customers" : currentTab) + ' yet</div><div class="empty-sub">' + (TAB_EMPTY_TEXT[currentTab] || TAB_EMPTY_TEXT.all) + '</div></div>';
            return;
          }
          // Rows only animate when the list genuinely changes shape (first
          // load, a filter switch, someone new arriving) -- never on the
          // routine 5s poll, which would strobe the whole list.
          const stagger = animateNextList;
          animateNextList = false;
          list.innerHTML = customers.map((c, rowIndex) => {
            const isActiveRow = c.phone === selectedPhone;
            const rowAnim = stagger
              ? ' row-in" style="animation-delay:' + Math.min(rowIndex * 35, 280) + 'ms'
              : '';
            const needsReply = c.paused === "yes" && c.last_message_role === "user";
            // One badge at most, and only when something is genuinely off --
            // an ordinary live conversation says so with the green dot on its
            // avatar rather than repeating the word "Active" down every row.
            const statusBadge = needsReply
              ? '<span class="badge waiting" title="Paused, and the customer spoke last">Needs reply</span>'
              : (c.paused === "yes" ? '<span class="badge paused">Paused</span>' : "");
            const paidMark = c.last_payment_at
              ? '<span class="row-paid" title="This customer has paid">' + ICON_CHECK + '</span>'
              : "";
            const starIcon = c.starred === "yes" ? '<span class="row-star">' + ICON_STAR_FILLED + '</span>' : "";
            const timeLabel = c.last_contact ? timeAgo(c.last_contact).replace(" ago", "") : "";
            // The second line carries meaning rather than metadata: why Amara
            // stepped back if she did, otherwise what was actually last said.
            // Conversations saved before last_message_preview existed fall
            // back to the old count instead of showing a guess.
            const preview = c.last_escalation_reason
              ? '<span class="row-escalation">' + ICON_ALERT + escapeHtml(c.last_escalation_reason) + '</span>'
              : (c.last_message_preview
                ? escapeHtml(c.last_message_preview)
                : '<span class="row-faint">' + (c.message_count || 0) + ' message' + (Number(c.message_count) === 1 ? '' : 's') + '</span>');
            const dotClass = c.paused === "yes" ? "paused" : "active";
            return '<div class="list-item' + (isActiveRow ? " active-row" : "") + rowAnim + '" onclick="loadConversation(\\'' + c.phone + '\\', true)">' +
              '<div class="list-avatar" style="' + avatarStyleFor(c.phone) + '">' + (avatarTextFor(c) ? '<span class="avatar-initials">' + escapeHtml(avatarTextFor(c)) + '</span>' : ICON_PERSON) + '<span class="status-dot ' + dotClass + '"></span></div>' +
              '<div class="list-item-body">' +
                '<div class="list-item-top">' +
                  '<span class="phone">' + starIcon + escapeHtml(displayNameFor(c)) + paidMark + '</span>' +
                  // A row that needs attention says so up here instead of
                  // squeezing the preview line; ordinary rows show the time.
                  (statusBadge || '<span class="row-time">' + escapeHtml(timeLabel) + '</span>') +
                '</div>' +
                '<div class="list-item-bottom">' +
                  '<span class="row-preview">' + preview + '</span>' +
                '</div>' +
              '</div>' +
              '</div>';
          }).join("");
        }

        async function loadConversation(phone, isClick) {
          selectedPhone = phone;
          if (isClick) {
            renderList(getFilteredCustomers()); // re-highlight the selected row immediately
            // On a narrow screen this is a real navigation, list -> thread
            // (see the .layout.thread-open rule in the mobile media query) --
            // on a wide screen this class does nothing, both panes already
            // show side by side.
            const layoutEl = document.getElementById("conversationsView");
            if (layoutEl) layoutEl.classList.add("thread-open");
            // On a phone the conversation should own the screen -- the stat
            // tiles above it are dashboard context, not part of reading a
            // thread (the media query below is what actually hides them, so
            // this class does nothing on a wide screen).
            document.body.classList.add("mobile-thread-open");
          }
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

        // Shared by both renderThread() (first open / switching conversation)
        // and updateThreadMessages() (the 5s background poll on the SAME
        // conversation) so the two never quietly drift into rendering
        // bubbles differently. Each row carries a real avatar chip -- see
        // above -- so a thread reads as a genuine two-sided conversation
        // rather than a flat stack of identical gray/navy blocks. Note:
        // there's deliberately no per-message timestamp here -- the stored
        // conversation history only ever keeps {role, content}, never a
        // timestamp, so a time on each bubble would have to be invented
        // rather than real. The thread header's "Last message Nm ago" line
        // uses a real stored timestamp instead (see renderThread).
        function renderBubblesHtml(history) {
          if (!history || history.length === 0) return '<div class="empty"><div class="empty-icon">' + ICON_CHAT + '</div><div class="empty-title">No messages yet</div><div class="empty-sub">Nothing in this conversation yet.</div></div>';
          // The customer's chip uses the same color/initials as their row in
          // the list and their thread-header avatar (all keyed off the same
          // phone number) so the same person reads as the same person
          // everywhere on the page. Amara's own avatar stays a fixed "S" --
          // that's a brand identity, not a per-contact one, same idea as the
          // sidebar profile mark.
          const dayKeyOf = (msg) => {
            if (!msg || !msg.at) return null;
            const d = new Date(msg.at);
            return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
          };
          let html = "";
          let lastDayKey = null;
          history.forEach((m, i) => {
            const dayKey = dayKeyOf(m);
            if (dayKey && dayKey !== lastDayKey) {
              html += '<div class="day-divider"><span>' + formatDayDivider(m.at) + '</span></div>';
              lastDayKey = dayKey;
            }
            // Consecutive messages from the same side are grouped the way
            // WhatsApp groups them: one avatar and one tail per group, tight
            // spacing inside a group and a real gap between groups, instead
            // of repeating an avatar on every single line.
            const next = history[i + 1];
            const nextDayKey = dayKeyOf(next);
            const endsGroup = !next || next.role !== m.role || (!!nextDayKey && nextDayKey !== lastDayKey);
            const isUser = m.role === "user";
            // The time now sits inside the bubble, bottom-right, the way it
            // does in WhatsApp -- it stays outside .bubble-text so search
            // never matches or overwrites it (see filterThreadSearch).
            const timeHtml = m.at ? '<span class="bubble-time">' + formatBubbleTime(m.at) + '</span>' : "";
            // Only messages the dashboard itself sent carry by:"owner". An
            // outgoing message without it gets no label at all rather than a
            // guessed one.
            const byHtml = (!isUser && m.by === "owner") ? '<span class="bubble-by">You</span>' : "";
            html += '<div class="msg-row ' + (isUser ? "from-user" : "from-assistant") + (endsGroup ? " group-end" : "") + '">' +
              '<div class="bubble-col">' +
                '<div class="bubble ' + (isUser ? "user" : "assistant") + (endsGroup ? " has-tail" : "") + '">' +
                  '<span class="bubble-text">' + escapeHtml(m.content) + '</span>' + byHtml + timeHtml +
                '</div>' +
              '</div>' +
              '</div>';
          });
          return html;
        }

        function updateThreadMessages(history, customer) {
          const threadEl = document.getElementById("thread");
          if (!threadEl) return; // panel isn't built yet, nothing to update
          const nearBottom = threadEl.scrollTop + threadEl.clientHeight >= threadEl.scrollHeight - 20;
          // Only genuinely NEW messages animate in. The poll re-renders the
          // whole thread every 5s, so without this every bubble would replay
          // its entrance on a loop.
          const grew = history.length - lastRenderedCount;
          lastRenderedCount = history.length;
          threadEl.innerHTML = renderBubblesHtml(history);
          if (grew > 0 && grew <= 5) {
            const rows = threadEl.querySelectorAll(".msg-row");
            for (let i = Math.max(0, rows.length - grew); i < rows.length; i++) {
              rows[i].classList.add("bubble-in");
            }
          }
          if (nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
          // A poll rebuilds the bubbles from scratch, which would otherwise
          // silently wipe an active search's highlights every 5 seconds --
          // if the search bar is open, just re-run the same filter against
          // the freshly rendered bubbles instead.
          const searchBar = document.getElementById("threadSearchBar");
          if (searchBar && searchBar.style.display !== "none" && document.getElementById("threadSearchInput")?.value) {
            filterThreadSearch();
          }

          // Keep the header status (avatar dot + subtitle) and the Take
          // over / Hand back button in sync too (e.g. if the owner
          // paused/resumed from elsewhere), without touching the compose
          // or notes box at all.
          const isPaused = customer && customer.paused === "yes";
          const btn = document.querySelector(".takeover-btn");
          if (btn) {
            btn.className = "takeover-btn " + (isPaused ? "hand" : "take");
            // innerHTML, not textContent: textContent wiped the two
            // breakpoint labels, so five seconds after opening a paused
            // thread the mobile button silently grew back to the long
            // wording and started colliding with the number again.
            btn.innerHTML = isPaused
              ? '<span class="lbl-full">Hand back to Amara</span><span class="lbl-short">Hand back</span>'
              : '<span class="lbl-full">Take over</span><span class="lbl-short">Take over</span>';
            btn.onclick = function () { toggleTakeover(selectedPhone, isPaused); };
          }
          const dot = document.querySelector(".thread-avatar .status-dot");
          if (dot) dot.className = "status-dot " + (isPaused ? "paused" : "active");
          const sub = document.querySelector(".thread-sub");
          if (sub) sub.textContent = threadSubtitle(customer);
          const statusChip = document.getElementById("threadStatusChip");
          if (statusChip) {
            statusChip.className = "thread-status-chip" + (isPaused ? " is-paused" : "");
            statusChip.innerHTML = '<span class="chip-dot"></span>' + (isPaused
              ? '<span class="lbl-full">You&#39;re handling this</span><span class="lbl-short">You&#39;re on it</span>'
              : '<span class="lbl-full">Amara is replying</span><span class="lbl-short">Amara replying</span>');
          }
          // Keep the details panel current too, but never while the owner is
          // mid-sentence in the note -- re-rendering would wipe what they've
          // typed. Skipped entirely if the note field has focus.
          const noteEl = document.getElementById("notesInput");
          if (customer && document.activeElement !== noteEl) {
            renderDetailPane(selectedPhone, customer);
          }
          const starBtn = document.getElementById("starBtn");
          if (starBtn && customer) {
            const starred = customer.starred === "yes";
            starBtn.dataset.starred = starred ? "yes" : "no";
            starBtn.innerHTML = starred ? ICON_STAR_FILLED : ICON_STAR;
            starBtn.classList.toggle("starred", starred);
            const mk = document.getElementById("threadStarMark");
            if (mk) mk.style.display = starred ? "" : "none";
          }
        }

        // Real, not invented: paused state and last_contact are both actual
        // stored fields, never a fake "online"/"typing..." claim -- WhatsApp
        // gives us no live presence signal to show one honestly.
        function threadSubtitle(customer) {
          if (customer && customer.last_contact) return "Last message " + timeAgo(customer.last_contact);
          return "New conversation";
        }
        // The paused/active state now reads as a real status chip rather than
        // a run of grey text -- same two states, same stored field.
        function threadStatusChipHtml(isPaused) {
          // Long form on desktop, short on a phone -- the full sentence and
          // the starred chip together wrapped the header onto a second row.
          return isPaused
            ? '<span class="thread-status-chip is-paused" id="threadStatusChip"><span class="chip-dot"></span><span class="lbl-full">You\\'re handling this</span><span class="lbl-short">You\\'re on it</span></span>'
            : '<span class="thread-status-chip" id="threadStatusChip"><span class="chip-dot"></span><span class="lbl-full">Amara is replying</span><span class="lbl-short">Amara replying</span></span>';
        }

        function renderThread(phone, history, customer) {
          const isPaused = customer && customer.paused === "yes";
          const main = document.getElementById("main");
          main.innerHTML =
            '<div class="thread-header">' +
              '<div class="thread-header-id" style="--thread-accent:' + avatarColorFor(phone) + ';">' +
                '<button class="mobile-back-btn icon-btn" onclick="closeThreadMobile()" title="Back to conversations" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
                '<div class="thread-avatar" style="' + avatarStyleFor(phone) + '">' + (avatarTextFor(customer) ? '<span class="avatar-initials">' + escapeHtml(avatarTextFor(customer)) + '</span>' : ICON_PERSON) + '<span class="status-dot ' + (isPaused ? "paused" : "active") + '"></span></div>' +
                // Two lines, the way a messaging app does it: who, then one
                // meta line. This used to be four stacked rows -- name, number,
                // then a wrapping row carrying a starred pill, a bordered
                // status pill and the last-message time -- which is what made
                // the header feel crowded next to the thread below it.
                '<div class="thread-id-text">' +
                  '<div class="thread-name">' +
                    '<span class="thread-num">' + escapeHtml(displayNameFor(customer)) + '</span>' +
                    '<span class="thread-star-mark" id="threadStarMark"' + ((customer && customer.starred === "yes") ? '' : ' style="display:none;"') + ' title="Starred">' + ICON_STAR_FILLED + '</span>' +
                  '</div>' +
                  '<div class="thread-meta">' +
                    // The number still has to be on screen when a profile name
                    // is showing: it is the identifier that ties to a payment,
                    // and a WhatsApp name is neither unique nor verified.
                    (hasWaName(customer) ? '<span class="tm-phone">' + escapeHtml(formatPhoneDisplay(phone)) + '</span>' : '') +
                    threadStatusChipHtml(isPaused) +
                    '<span class="thread-sub">' + threadSubtitle(customer) + '</span>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div class="thread-actions">' +
                '<button class="icon-btn hide-sm" onclick="toggleThreadSearch()" title="Search in this conversation">' + ICON_SEARCH + '</button>' +
                '<button class="icon-btn hide-sm" id="detailToggle" onclick="toggleDetailPane()" title="Customer details">' + ICON_SIDEPANEL + '</button>' +
                '<button class="icon-btn hide-sm' + ((customer && customer.starred === "yes") ? " starred" : "") + '" id="starBtn" data-starred="' + ((customer && customer.starred === "yes") ? "yes" : "no") + '" onclick="toggleStar(\\'' + phone + '\\')" title="Star this conversation">' +
                  ((customer && customer.starred === "yes") ? ICON_STAR_FILLED : ICON_STAR) +
                '</button>' +
                '<button class="takeover-btn ' + (isPaused ? "hand" : "take") + '" onclick="toggleTakeover(\\'' + phone + '\\', ' + (isPaused ? "true" : "false") + ')">' +
                  // Two labels, one shown per breakpoint: the full sentence
                  // doesn't fit beside a phone number on a 390px header, and
                  // truncating a button is worse than shortening its wording.
                  (isPaused
                    ? '<span class="lbl-full">Hand back to Amara</span><span class="lbl-short">Hand back</span>'
                    : '<span class="lbl-full">Take over</span><span class="lbl-short">Take over</span>') +
                '</button>' +
                '<div class="more-menu">' +
                  '<button class="icon-btn" id="moreMenuBtn" onclick="toggleMoreMenu()" title="More">' + ICON_MORE + '</button>' +
                  '<div class="more-menu-dropdown" id="moreMenuDropdown">' +
                    // Mirrors of the icon buttons that are hidden on a narrow
                    // screen, so nothing becomes unreachable on a phone.
                    '<button class="menu-sm-only" onclick="toggleMoreMenu(); toggleThreadSearch();">Search this conversation</button>' +
                    '<button class="menu-sm-only menu-star" onclick="toggleMoreMenu(); toggleStar(\\'' + phone + '\\');">' + ((customer && customer.starred === "yes") ? "Remove star" : "Star this conversation") + '</button>' +
                    '<button onclick="toggleMoreMenu(); clearConversation(\\'' + phone + '\\');" title="Wipe this conversation and customer record so you can retest from a clean slate" class="menu-danger">Clear conversation</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="thread-search-bar" id="threadSearchBar" style="display:none;">' +
              '<input id="threadSearchInput" placeholder="Search in this conversation..." oninput="filterThreadSearch()" onkeydown="if(event.key===\\'Enter\\') jumpToNextMatch(event.shiftKey)">' +
              '<span class="thread-search-count" id="threadSearchCount"></span>' +
              '<button class="icon-btn" onclick="closeThreadSearch()" title="Close search" aria-label="Close search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="thread" id="thread"></div>' +
            '<div class="msg-compose">' +
              '<div class="msg-compose-inner">' +
                '<textarea id="composeInput" rows="1" placeholder="Message ' + escapeHtml(displayNameFor(customer)) + ' directly..." oninput="autoGrowCompose(this)" onfocus="onComposeFocus()" onkeydown="handleComposeKeydown(event, \\'' + phone + '\\')"></textarea>' +
                '<div class="compose-tools">' +
                  '<button class="icon-btn small-icon-btn" onclick="wrapSelection(\\'*\\', \\'*\\')" title="Bold — sends as real WhatsApp *text*"><b>B</b></button>' +
                  '<button class="icon-btn small-icon-btn" onclick="wrapSelection(\\'_\\', \\'_\\')" title="Italic — sends as real WhatsApp _text_"><i>I</i></button>' +
                  '<span class="toolbar-divider"></span>' +
                  '<div class="emoji-picker-wrap">' +
                    '<button class="icon-btn small-icon-btn" onclick="toggleEmojiPicker()" title="Emoji">' + ICON_EMOJI + '</button>' +
                    '<div class="emoji-picker-dropdown" id="emojiPicker">' +
                      '<div class="emoji-picker-label">Emoji</div>' +
                      '<div class="emoji-picker-grid">' +
                        EMOJI_SET.map((e) => '<button onclick="insertAtCursor(\\'' + e + '\\')">' + e + '</button>').join("") +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<button class="msg-send-btn" id="composeSendBtn" onclick="sendManualMessage(\\'' + phone + '\\')" title="Send" aria-label="Send">' + ICON_SEND + '</button>' +
            '</div>' +
            // The private note moved into the details panel beside the thread
            // -- it's reference material, and keeping it out of this column
            // gives the whole height back to the conversation itself.
            '<div class="compose-hint">Enter to send · Shift + Enter for a new line</div>';
          renderDetailPane(phone, customer);
          const threadEl = document.getElementById("thread");
          threadEl.innerHTML = renderBubblesHtml(history);
          lastRenderedCount = history.length; // baseline for the new-message animation
          threadEl.scrollTop = threadEl.scrollHeight;
        }

        // Lets the compose box grow with what's typed (up to a cap, then it
        // scrolls) instead of staying a fixed single line -- and Enter sends
        // while Shift+Enter still inserts a real newline, the convention
        // WhatsApp itself and most chat apps use.
        function autoGrowCompose(el) {
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 120) + "px";
        }
        // ---- Mobile keyboard ------------------------------------------
        // When the on-screen keyboard opens, the visual viewport shrinks but
        // the layout viewport often doesn't, so a full-height app keeps its
        // old height and the composer ends up behind the keyboard. Tracking
        // visualViewport and driving the app's height from it keeps the
        // composer sitting directly on top of the keyboard instead.
        function syncViewportHeight() {
          const vv = window.visualViewport;
          if (!vv) return;
          document.documentElement.style.setProperty("--vvh", Math.round(vv.height) + "px");
          // iOS scrolls the page itself to reveal a focused field; that moves
          // the whole app out of frame, so put it back.
          if (window.scrollY !== 0) window.scrollTo(0, 0);
        }
        if (window.visualViewport) {
          window.visualViewport.addEventListener("resize", syncViewportHeight);
          window.visualViewport.addEventListener("scroll", syncViewportHeight);
          syncViewportHeight();
        }
        // Typing should always show the newest message, not leave you looking
        // at the middle of the thread with the keyboard over the rest.
        function onComposeFocus() {
          const scrollThread = () => {
            const t = document.getElementById("thread");
            if (t) t.scrollTop = t.scrollHeight;
          };
          scrollThread();
          // The keyboard animates in, so the useful height isn't known yet.
          setTimeout(() => { syncViewportHeight(); scrollThread(); }, 180);
          setTimeout(scrollThread, 420);
        }

        function handleComposeKeydown(event, phone) {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendManualMessage(phone);
          }
        }

        async function sendManualMessage(phone) {
          const input = document.getElementById("composeInput");
          const sendBtn = document.getElementById("composeSendBtn");
          const text = input.value.trim();
          if (!text) return;
          input.disabled = true;
          if (sendBtn) sendBtn.disabled = true;
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
              if (sendBtn) sendBtn.disabled = false;
              return;
            }
            input.value = "";
            input.style.height = "auto";
            input.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
            loadDashboard();
            loadConversation(phone, false);
          } catch (err) {
            alert("Network error, please try again.");
            input.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
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
              flash(msg, data.error || "Could not save note.", "bad");
              return;
            }
            flash(msg, "", "ok", "Private note saved");
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
          }
        }

        function toggleMoreMenu() {
          const el = document.getElementById("moreMenuDropdown");
          if (el) el.classList.toggle("open");
        }
        function toggleEmojiPicker() {
          const el = document.getElementById("emojiPicker");
          if (el) el.classList.toggle("open");
        }
        // Close the more-menu / emoji picker on an outside click --
        // registered once, not rebuilt on every renderThread(), so it stays
        // attached across conversation switches.
        document.addEventListener("click", function (e) {
          const menu = document.getElementById("moreMenuDropdown");
          const trigger = document.getElementById("moreMenuBtn");
          if (menu && menu.classList.contains("open") && !menu.contains(e.target) && e.target !== trigger && !trigger?.contains(e.target)) {
            menu.classList.remove("open");
          }
          const emoji = document.getElementById("emojiPicker");
          if (emoji && emoji.classList.contains("open") && !emoji.parentElement?.contains(e.target)) {
            emoji.classList.remove("open");
          }
        });

        // ---- Search within the currently open conversation ----
        // Client-side only, over messages already loaded on the page --
        // there's no separate search index or API call, just a real
        // substring match against the same text already rendered.
        let threadSearchMatches = [];
        let threadSearchIndex = -1;
        function toggleThreadSearch() {
          const bar = document.getElementById("threadSearchBar");
          if (!bar) return;
          const showing = bar.style.display !== "none";
          if (showing) {
            closeThreadSearch();
          } else {
            bar.style.display = "flex";
            document.getElementById("threadSearchInput")?.focus();
          }
        }
        function closeThreadSearch() {
          const bar = document.getElementById("threadSearchBar");
          if (bar) bar.style.display = "none";
          const input = document.getElementById("threadSearchInput");
          if (input) input.value = "";
          clearThreadHighlights();
        }
        function clearThreadHighlights() {
          document.querySelectorAll(".thread .bubble-text mark").forEach((m) => {
            const parent = m.parentNode;
            if (parent) {
              parent.replaceChild(document.createTextNode(m.textContent), m);
              parent.normalize();
            }
          });
          document.querySelectorAll(".thread .msg-row.search-hidden").forEach((el) => el.classList.remove("search-hidden"));
          const count = document.getElementById("threadSearchCount");
          if (count) count.textContent = "";
          threadSearchMatches = [];
          threadSearchIndex = -1;
        }
        function highlightMatch(bubbleEl, q) {
          // Rebuilt from the bubble's own plain textContent (never from
          // stored HTML), then re-escaped -- this can only ever add a
          // <mark>, never reintroduce markup from message content.
          const text = bubbleEl.textContent || "";
          const idx = text.toLowerCase().indexOf(q);
          if (idx === -1) return;
          bubbleEl.innerHTML = escapeHtml(text.slice(0, idx)) + "<mark>" + escapeHtml(text.slice(idx, idx + q.length)) + "</mark>" + escapeHtml(text.slice(idx + q.length));
        }
        function filterThreadSearch() {
          clearThreadHighlights();
          const q = (document.getElementById("threadSearchInput")?.value || "").trim().toLowerCase();
          const count = document.getElementById("threadSearchCount");
          if (!q) return;
          const rows = Array.from(document.querySelectorAll(".thread .msg-row"));
          rows.forEach((row) => {
            // .bubble-text, not .bubble -- the in-bubble timestamp must never
            // be searchable text, nor get wiped when a match is highlighted.
            const bubble = row.querySelector(".bubble-text");
            if (!bubble) return;
            if ((bubble.textContent || "").toLowerCase().indexOf(q) === -1) {
              row.classList.add("search-hidden");
            } else {
              threadSearchMatches.push(row);
              highlightMatch(bubble, q);
            }
          });
          threadSearchIndex = threadSearchMatches.length > 0 ? 0 : -1;
          if (count) count.textContent = threadSearchMatches.length > 0 ? (threadSearchIndex + 1) + " of " + threadSearchMatches.length : "No matches";
          if (threadSearchMatches.length > 0) threadSearchMatches[0].scrollIntoView({ block: "center", behavior: "smooth" });
        }
        function jumpToNextMatch(reverse) {
          if (threadSearchMatches.length === 0) return;
          threadSearchIndex = reverse
            ? (threadSearchIndex - 1 + threadSearchMatches.length) % threadSearchMatches.length
            : (threadSearchIndex + 1) % threadSearchMatches.length;
          threadSearchMatches[threadSearchIndex].scrollIntoView({ block: "center", behavior: "smooth" });
          const count = document.getElementById("threadSearchCount");
          if (count) count.textContent = (threadSearchIndex + 1) + " of " + threadSearchMatches.length;
        }

        // ---- Real WhatsApp text formatting + emoji in the compose box ----
        function wrapSelection(prefix, suffix) {
          const ta = document.getElementById("composeInput");
          if (!ta) return;
          const start = ta.selectionStart, end = ta.selectionEnd;
          const value = ta.value;
          const selected = value.slice(start, end) || "text";
          ta.value = value.slice(0, start) + prefix + selected + suffix + value.slice(end);
          ta.focus();
          ta.selectionStart = start + prefix.length;
          ta.selectionEnd = start + prefix.length + selected.length;
          autoGrowCompose(ta);
        }
        function insertAtCursor(text) {
          const ta = document.getElementById("composeInput");
          if (!ta) return;
          const start = ta.selectionStart, end = ta.selectionEnd;
          const value = ta.value;
          ta.value = value.slice(0, start) + text + value.slice(end);
          const pos = start + text.length;
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos;
          autoGrowCompose(ta);
          document.getElementById("emojiPicker")?.classList.remove("open");
        }

        async function toggleStar(phone) {
          const btn = document.getElementById("starBtn");
          if (!btn) return;
          const next = btn.dataset.starred !== "yes";
          btn.dataset.starred = next ? "yes" : "no";
          btn.innerHTML = next ? ICON_STAR_FILLED : ICON_STAR;
          btn.classList.toggle("starred", next);
          // Header indicator and the ⋮ menu wording follow the same state, so
          // a phone (where the star button itself is hidden) still shows it.
          const mark = document.getElementById("threadStarMark");
          if (mark) mark.style.display = next ? "" : "none";
          const menuStar = document.querySelector("#moreMenuDropdown .menu-star");
          if (menuStar) menuStar.textContent = next ? "Remove star" : "Star this conversation";
          const c = customersCache.find((c) => c.phone === phone);
          if (c) c.starred = next ? "yes" : "no";
          updateListTabCounts();
          renderList(getFilteredCustomers());
          try {
            await fetch("/api/star?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phone: phone, starred: next }),
            });
          } catch (err) {
            console.error("star toggle failed", err);
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

        async function clearConversation(phone) {
          if (!confirm("Clear this conversation? This wipes the chat history and this customer's record completely, so you can retest from a clean slate. Any bookings they made are NOT affected -- cancel those separately if needed. This can't be undone.")) return;
          try {
            await fetch("/api/conversation/clear?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ phone: phone }),
            });
            selectedPhone = null;
            renderedThreadPhone = null;
            document.getElementById("main").innerHTML = '<div class="empty"><div class="empty-icon">' + ICON_CHAT + '</div><div class="empty-title">Select a conversation</div><div class="empty-sub">Pick a customer from the list on the left to see the full thread.</div></div>';
            loadDashboard();
          } catch (err) {
            alert("Network error, please try again.");
          }
        }

        // The view transition, driven by the Web Animations API rather than a
        // CSS class. The class version had to be removed, forced through a
        // synchronous layout (void offsetWidth) and re-added on every switch
        // just to restart itself -- a forced reflow immediately after changing
        // the display of seven elements, which measured as a 30-36ms block
        // before the animation had even begun. WAAPI restarts on every call by
        // definition, needs no reflow, and animates only opacity and transform,
        // so the whole thing stays on the compositor.
        let viewEnterAnim = null;
        function prefersReducedMotion() {
          return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        }
        function playViewEnter(el) {
          viewEnterAnim = null;
          if (!el || !el.animate || prefersReducedMotion()) return;
          viewEnterAnim = el.animate(
            [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
            { duration: 240, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
          );
        }
        // Runs work once the transition has finished, so a heavy render can
        // never share a frame with the motion. Falls through immediately when
        // there is no animation to wait for (reduced motion, or a browser
        // without WAAPI), so nothing depends on the animation existing.
        function afterViewEnter(fn) {
          if (!viewEnterAnim) return void setTimeout(fn, 0);
          let done = false;
          // One extra frame after the animation reports finished, so the work
          // can't share the frame that commits its final state.
          const run = () => { if (!done) { done = true; requestAnimationFrame(() => setTimeout(fn, 0)); } };
          viewEnterAnim.finished.then(run).catch(run);
          // A tab switched away from mid-animation cancels it; the safety net
          // means a loader can never be dropped entirely.
          setTimeout(run, 400);
        }

        function switchTab(tab) {
          // Not every element below exists on every seller's dashboard --
          // a goods seller never gets tabServices/tabBookings, a bookable
          // seller never gets tabCatalog. Guarded with optional chaining
          // so this one function works for either businessType without
          // needing its own fork.
          const views = { home: "homeView", conversations: "conversationsView", catalog: "catalogView", services: "servicesView", bookings: "bookingsView", analytics: "analyticsView", settings: "settingsView" };
          let entering = null;
          for (const t in views) {
            const el = document.getElementById(views[t]);
            if (!el) continue;
            if (t === tab) {
              el.style.display = t === "conversations" ? "flex" : "block";
              entering = el;
            } else {
              el.style.display = "none";
            }
          }
          const tabs = { home: "tabHome", conversations: "tabConversations", catalog: "tabCatalog", services: "tabServices", bookings: "tabBookings", analytics: "tabAnalytics", settings: "tabSettings" };
          for (const t in tabs) {
            const el = document.getElementById(tabs[t]);
            if (el) el.className = t === tab ? "active-tab" : "";
          }
          // Coming back to Conversations from the menu should land on the
          // LIST, not silently reopen whichever thread was last read -- on a
          // phone that made it look like the menu item did nothing.
          if (tab === "conversations" && window.innerWidth <= 700) closeThreadMobile();
          playViewEnter(entering);
          // Loading is deliberately NOT done inline here. Measured on a
          // 4x-throttled phone, building the analytics chart cost a single
          // 129ms frame, and it landed in the middle of the transition --
          // which is the heaviness you feel rather than see. The fetch and
          // the render both wait for the motion to finish; 260ms is nothing
          // next to a network round trip, and the tab arrives smooth.
          afterViewEnter(() => {
            if (tab === "home") loadHome();
            if (tab === "catalog") loadCatalog();
            if (tab === "services" || tab === "bookings") loadBookable();
            if (tab === "analytics") loadAnalytics();
            if (tab === "settings") { loadCatalog(); syncSettingsControls(); } // catalog load fills the bank fields
          });
          // Leaving Conversations must give the stat tiles back on mobile,
          // otherwise they'd stay hidden on every other tab.
          if (tab !== "conversations") document.body.classList.remove("mobile-thread-open");
          // Which tab is open drives the mobile stats rule below: on a phone
          // the stat strip is dashboard context, and the conversations tab
          // needs its full height for the list and the thread.
          document.body.setAttribute("data-tab", tab);
          closeSidebar(); // no-op on desktop; on the mobile drawer, picking a tab should close it
        }

        function toggleSidebar() {
          document.getElementById("sidebar")?.classList.toggle("open");
          document.getElementById("sidebarBackdrop")?.classList.toggle("open");
        }
        function closeSidebar() {
          document.getElementById("sidebar")?.classList.remove("open");
          document.getElementById("sidebarBackdrop")?.classList.remove("open");
        }
        // Mobile master/detail: leaving the open thread goes back to the
        // conversation list (see .layout.thread-open in the responsive CSS
        // -- this class does nothing above the 700px breakpoint, both
        // panes are simply shown side by side there already).
        // Light / dark. The choice is remembered per browser; until the owner
        // picks one, the OS preference decides (see the inline script in
        // <head>, which applies it before first paint).
        // ---- Customer details panel ----------------------------------
        // Every line in here is a field this dashboard genuinely stores on
        // the customer record (see recordCustomerContact / upsertCustomer):
        // first_contact, message_count, last_contact, last_payment_*,
        // last_escalation_reason, note. Nothing is inferred or invented --
        // WhatsApp gives us no name, location, or "customer tier", so none
        // is shown.
        function detailRow(label, value) {
          return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
        }
        function formatFullDate(iso) {
          if (!iso) return "";
          const d = new Date(iso);
          if (isNaN(d.getTime())) return "";
          return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
        }
        function renderDetailPane(phone, customer) {
          const pane = document.getElementById("detailPane");
          if (!pane) return;
          const c = customer || {};
          const isPaused = c.paused === "yes";
          const since = formatFullDate(c.first_contact);
          const msgCount = Number(c.message_count || 0);

          const paymentBlock = c.last_payment_at
            ? '<div class="detail-card paid-card">' +
                '<div class="detail-card-title">Last payment</div>' +
                '<div class="detail-amount">N' + Number(c.last_payment_amount || 0).toLocaleString() + '</div>' +
                '<div class="detail-muted">' + escapeHtml(formatFullDate(c.last_payment_at)) + '</div>' +
                (c.last_payment_reference
                  ? '<div class="detail-ref" title="' + escapeHtml(c.last_payment_reference) + '">Ref ' + escapeHtml(String(c.last_payment_reference).slice(0, 18)) + '</div>'
                  : "") +
              '</div>'
            : '<div class="detail-card">' +
                '<div class="detail-card-title">Payments</div>' +
                '<div class="detail-muted">No payment recorded for this customer yet.</div>' +
              '</div>';

          const escalationBlock = c.last_escalation_reason
            ? '<div class="detail-card warn-card">' +
                '<div class="detail-card-title">Why Amara stepped back</div>' +
                '<div class="detail-muted">' + escapeHtml(c.last_escalation_reason) + '</div>' +
              '</div>'
            : "";

          pane.innerHTML =
            '<div class="detail-head">' +
              '<div class="detail-avatar" style="' + avatarStyleFor(phone) + '">' + (avatarTextFor(c) ? '<span class="avatar-initials">' + escapeHtml(avatarTextFor(c)) + '</span>' : ICON_PERSON) + '</div>' +
              '<div class="detail-phone">' + escapeHtml(displayNameFor(c)) + '</div>' +
              (hasWaName(c) ? '<div class="detail-phone-sub">' + escapeHtml(formatPhoneDisplay(phone)) + '</div>' : '') +
              '<span class="thread-status-chip' + (isPaused ? ' is-paused' : '') + '"><span class="chip-dot"></span>' +
                (isPaused ? "You&#39;re handling this" : "Amara is replying") +
              '</span>' +
            '</div>' +
            '<div class="detail-card">' +
              (hasWaName(c) ? detailRow("WhatsApp name", escapeHtml(c.wa_name)) : "") +
              detailRow("Customer since", since ? escapeHtml(since) : "&mdash;") +
              detailRow("Messages", msgCount ? msgCount.toLocaleString() : "&mdash;") +
              detailRow("Last active", c.last_contact ? escapeHtml(timeAgo(c.last_contact)) : "&mdash;") +
            '</div>' +
            paymentBlock +
            escalationBlock +
            '<div class="detail-card">' +
              '<div class="detail-card-title">' + ICON_LOCK + 'Private note</div>' +
              '<div class="detail-muted" style="margin-bottom:8px;">Only visible to you &mdash; never sent to the customer or Amara.</div>' +
              '<textarea id="notesInput" placeholder="e.g. Prefers evening delivery, always pays by transfer...">' + escapeHtml(c.note || "") + '</textarea>' +
              '<div class="notes-box-actions">' +
                '<button class="catalog-btn small" onclick="saveNote(\\'' + phone + '\\')">Save note</button>' +
                '<span class="catalog-msg" id="noteMsg"></span>' +
              '</div>' +
            '</div>';
        }

        function setDetailPane(on) {
          const view = document.getElementById("conversationsView");
          if (!view) return;
          view.classList.toggle("details-on", on);
          const btn = document.getElementById("detailToggle");
          if (btn) btn.classList.toggle("active-toggle", on);
        }
        function toggleDetailPane() {
          const view = document.getElementById("conversationsView");
          if (!view) return;
          const on = !view.classList.contains("details-on");
          setDetailPane(on);
          try { localStorage.setItem("stafly-details", on ? "on" : "off"); } catch (e) {}
        }
        // Open by default only where all three columns actually fit; below
        // that it stays closed until asked for. A saved choice always wins.
        function initDetailPane() {
          let saved = null;
          try { saved = localStorage.getItem("stafly-details"); } catch (e) {}
          setDetailPane(saved ? saved === "on" : window.innerWidth > 1280);
        }

        // ---- Settings controls ---------------------------------------
        // "system" means: store nothing and follow the device, which is what
        // the boot script in <head> already does when no choice is saved.
        function applyThemeChoice(choice) {
          const root = document.documentElement;
          const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          const dark = choice === "dark" || (choice === "system" && prefersDark);
          if (dark) root.setAttribute("data-theme", "dark");
          else root.removeAttribute("data-theme");
          if (typeof lastAnalytics !== "undefined" && lastAnalytics) renderAnalytics(lastAnalytics);
        }
        function setThemeChoice(choice) {
          try {
            if (choice === "system") localStorage.removeItem("stafly-theme");
            else localStorage.setItem("stafly-theme", choice);
          } catch (e) {}
          applyThemeChoice(choice);
          applyAccent(currentAccent()); // accent tokens differ between themes
          syncSettingsControls();
        }
        function currentThemeChoice() {
          try { return localStorage.getItem("stafly-theme") || "system"; } catch (e) { return "system"; }
        }
        function toggleDetailDefault() {
          const on = !(currentDetailDefault());
          try { localStorage.setItem("stafly-details", on ? "on" : "off"); } catch (e) {}
          setDetailPane(on);
          syncSettingsControls();
        }
        function currentDetailDefault() {
          let saved = null;
          try { saved = localStorage.getItem("stafly-details"); } catch (e) {}
          return saved ? saved === "on" : window.innerWidth > 1280;
        }
        // ---- Accent colour --------------------------------------------
        // Overrides the three accent tokens at the document level, so every
        // component that already reads var(--accent) follows automatically.
        const ACCENTS = [
          { id: "indigo", name: "Indigo", base: "#4f46e5", dark: "#4338ca", light: "#eef2ff", soft: "#e0e7ff", darkLight: "#1e2440", darkSoft: "#2a3157", darkBase: "#6366f1" },
          { id: "teal",   name: "Teal",   base: "#0d9488", dark: "#0f766e", light: "#ecfdf9", soft: "#ccfbf1", darkLight: "#0f2b2a", darkSoft: "#12403c", darkBase: "#2dd4bf" },
          { id: "blue",   name: "Blue",   base: "#2563eb", dark: "#1d4ed8", light: "#eff6ff", soft: "#dbeafe", darkLight: "#12203c", darkSoft: "#1c3260", darkBase: "#60a5fa" },
          { id: "violet", name: "Violet", base: "#7c3aed", dark: "#6d28d9", light: "#f5f3ff", soft: "#ede9fe", darkLight: "#241a40", darkSoft: "#38266b", darkBase: "#a78bfa" },
          { id: "rose",   name: "Rose",   base: "#e11d48", dark: "#be123c", light: "#fff1f3", soft: "#ffe4e8", darkLight: "#33131d", darkSoft: "#551f30", darkBase: "#fb7185" },
          { id: "amber",  name: "Amber",  base: "#d97706", dark: "#b45309", light: "#fffbeb", soft: "#fde68a", darkLight: "#2c1f0b", darkSoft: "#4a3413", darkBase: "#fbbf24" },
        ];
        function currentAccent() {
          try { return localStorage.getItem("stafly-accent") || "indigo"; } catch (e) { return "indigo"; }
        }
        function applyAccent(id) {
          const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
          const dark = document.documentElement.getAttribute("data-theme") === "dark";
          const root = document.documentElement.style;
          root.setProperty("--accent", dark ? a.darkBase : a.base);
          root.setProperty("--accent-dark", dark ? a.base : a.dark);
          root.setProperty("--accent-light", dark ? a.darkLight : a.light);
          root.setProperty("--accent-soft", dark ? a.darkSoft : a.soft);
          // The glow under accent-coloured buttons has to be derived from the
          // chosen accent too -- left hardcoded, a teal button kept an indigo
          // halo and the edges read as wrong.
          const base = dark ? a.darkBase : a.base;
          const r = parseInt(base.slice(1, 3), 16);
          const g = parseInt(base.slice(3, 5), 16);
          const bl = parseInt(base.slice(5, 7), 16);
          root.setProperty("--accent-shadow", "rgba(" + r + "," + g + "," + bl + ",0.30)");
          root.setProperty("--accent-shadow-strong", "rgba(" + r + "," + g + "," + bl + ",0.45)");
          if (typeof lastAnalytics !== "undefined" && lastAnalytics) renderAnalytics(lastAnalytics);
        }
        function setAccent(id) {
          try { localStorage.setItem("stafly-accent", id); } catch (e) {}
          applyAccent(id);
          syncSettingsControls();
        }

        // ---- Density ---------------------------------------------------
        function currentDensity() {
          try { return localStorage.getItem("stafly-density") || "comfortable"; } catch (e) { return "comfortable"; }
        }
        function applyDensity(mode) {
          document.documentElement.setAttribute("data-density", mode === "compact" ? "compact" : "comfortable");
        }
        function setDensity(mode) {
          try { localStorage.setItem("stafly-density", mode); } catch (e) {}
          applyDensity(mode);
          syncSettingsControls();
        }

        // ---- Haptics -----------------------------------------------------
        // A very short buzz when you move between tabs or open a thread, so a
        // tap registers in your hand and not only on the screen. Deliberately
        // 8ms: long enough to feel, short enough that it reads as a click
        // rather than a notification.
        //
        // navigator.vibrate is Android-only in practice -- iOS Safari has no
        // Vibration API at all, and there is no way to fake it from a web
        // page. Rather than ship a switch that does nothing on an iPhone, the
        // setting hides itself when the browser can't do it and says so.
        function hapticsSupported() {
          return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
        }
        function hapticsEnabled() {
          try { return localStorage.getItem("stafly-haptics") !== "off"; } catch (e) { return true; }
        }
        function setHaptics(on) {
          try { localStorage.setItem("stafly-haptics", on ? "on" : "off"); } catch (e) {}
          if (on) tapFeedback();
          syncSettingsControls();
        }
        // navigator.vibrate is a synchronous hop into the platform's vibrator
        // service, and on Android it can hold the main thread for a few
        // milliseconds. Firing it from switchTab put that cost inside the very
        // animation it was meant to accompany, so the motion started late --
        // measurably: the buzz landed ~24ms in, well before the view had begun
        // moving at ~51ms, and a dropped frame there is exactly the stutter
        // that made tab switching feel worse with haptics than without.
        //
        // So it moved off the transition entirely and onto the press. A tap
        // buzzes on pointerdown, before any animation exists to interfere
        // with, which is both cheaper and closer to how native apps do it:
        // the tick belongs to the finger, not to the view change.
        //
        // The cooldown stops a press that matches several selectors, or a
        // fast double-tap, from restarting the motor mid-buzz -- which reads
        // as a rattle rather than a click.
        let lastTapFeedback = 0;
        function tapFeedback(ms) {
          if (!hapticsSupported() || !hapticsEnabled()) return;
          const now = Date.now();
          if (now - lastTapFeedback < 120) return;
          lastTapFeedback = now;
          // A page that has never been interacted with can't vibrate, and
          // some browsers throw rather than returning false.
          try { navigator.vibrate(ms || 6); } catch (e) {}
        }

        // The things worth a tick: navigating, and the controls that change
        // what is on screen. Not every button on the page -- a buzz on
        // everything stops meaning anything.
        const HAPTIC_SELECTOR = "nav.tabs button, .list-tab, .cat-chip, .seg-control button, .mobile-back-btn, .catalog-btn, .swatch, .switch, .photo-btn, .waiting-row, .list-item";
        document.addEventListener("pointerdown", (e) => {
          if (e.target.closest && e.target.closest(HAPTIC_SELECTOR)) tapFeedback();
        }, { passive: true });

        // ---- Refresh rate ----------------------------------------------
        // Genuinely rewires the poll -- 0 clears the interval entirely.
        let pollTimer = null;
        function currentRefreshRate() {
          try {
            const v = localStorage.getItem("stafly-refresh");
            return v === null ? 5000 : Number(v);
          } catch (e) { return 5000; }
        }
        function applyRefreshRate(ms) {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (ms > 0) pollTimer = setInterval(loadDashboard, ms);
        }
        function setRefreshRate(ms) {
          try { localStorage.setItem("stafly-refresh", String(ms)); } catch (e) {}
          applyRefreshRate(ms);
          syncSettingsControls();
        }

        // ---- Full screen -----------------------------------------------
        // iPhone Safari has no Fullscreen API at all, so rather than offering
        // a button that silently does nothing there, the control tells the
        // truth and points at Add to Home Screen (which this app supports via
        // its manifest, and which gives a better result anyway: no browser
        // chrome and its own icon).
        function fullscreenSupported() {
          const el = document.documentElement;
          return !!(el.requestFullscreen || el.webkitRequestFullscreen);
        }
        function isStandalone() {
          return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
                 window.navigator.standalone === true;
        }
        function toggleFullscreen() {
          const el = document.documentElement;
          const current = document.fullscreenElement || document.webkitFullscreenElement;
          if (current) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
          } else {
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            if (req) req.call(el).catch(() => {});
          }
          setTimeout(syncFullscreenControl, 150);
        }
        function syncFullscreenControl() {
          const btn = document.getElementById("fullscreenBtn");
          const desc = document.getElementById("fullscreenDesc");
          if (!btn || !desc) return;
          if (isStandalone()) {
            btn.style.display = "none";
            desc.textContent = "Already running as an installed app, with no browser bars.";
            return;
          }
          if (!fullscreenSupported()) {
            btn.style.display = "none";
            desc.textContent = "This browser has no full-screen mode. On iPhone, use Share \\u2192 Add to Home Screen \\u2014 it opens with no browser bars and its own icon.";
            return;
          }
          btn.style.display = "";
          const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
          btn.textContent = on ? "Exit full screen" : "Enter full screen";
          desc.textContent = on
            ? "Full screen is on. On a phone you can also use Add to Home Screen for the same effect every time you open it."
            : "Hides the browser bars so the dashboard fills the screen. On a phone, Add to Home Screen does the same thing permanently.";
        }
        document.addEventListener("fullscreenchange", syncFullscreenControl);
        document.addEventListener("webkitfullscreenchange", syncFullscreenControl);

        // ---- Export + sign out -----------------------------------------
        function exportCustomersCsv() {
          const rows = [["phone", "whatsapp_name", "status", "messages", "first_contact", "last_contact", "last_payment_at", "last_payment_amount", "escalation_reason", "note"]];
          (customersCache || []).forEach((c) => {
            rows.push([
              c.phone || "", c.wa_name || "", c.paused === "yes" ? "paused" : "active", c.message_count || 0,
              c.first_contact || "", c.last_contact || "", c.last_payment_at || "",
              c.last_payment_amount || "", c.last_escalation_reason || "", c.note || "",
            ]);
          });
          // Quote every field and double any inner quote -- notes and
          // escalation reasons are free text and will contain commas.
          const csv = rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\\r\\n");
          const blob = new Blob(["\\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "stafly-customers-" + new Date().toISOString().slice(0, 10) + ".csv";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        async function signOut() {
          if (!confirm("Sign out of this dashboard? Amara keeps replying to your customers either way.")) return;
          try { await fetch("/logout", { method: "POST" }); } catch (e) {}
          window.location.href = "/login";
        }

        function syncSettingsControls() {
          const choice = currentThemeChoice();
          document.querySelectorAll("#themeSeg button").forEach((b) => {
            b.classList.toggle("seg-active", b.dataset.themeChoice === choice);
          });
          const sw = document.getElementById("detailsSwitch");
          if (sw) {
            const on = currentDetailDefault();
            sw.classList.toggle("on", on);
            sw.setAttribute("aria-checked", on ? "true" : "false");
          }
          // The switch is only meaningful where the browser can actually
          // vibrate. On an iPhone it stays visible but reads as unavailable
          // and says why, rather than pretending to be a working control.
          const stSw = document.getElementById("setupSwitch");
          if (stSw) {
            const on = !homeSetupHidden();
            stSw.classList.toggle("on", on);
            stSw.setAttribute("aria-checked", on ? "true" : "false");
          }
          const hSw = document.getElementById("hapticsSwitch");
          if (hSw) {
            const supported = hapticsSupported();
            const on = supported && hapticsEnabled();
            hSw.classList.toggle("on", on);
            hSw.setAttribute("aria-checked", on ? "true" : "false");
            hSw.disabled = !supported;
            hSw.style.opacity = supported ? "" : "0.45";
            hSw.style.cursor = supported ? "" : "not-allowed";
            const desc = document.getElementById("hapticsDesc");
            if (desc) {
              desc.textContent = supported
                ? "A short buzz when you switch tabs or open a conversation."
                : "This browser has no vibration support, so there's nothing to turn on. Android Chrome does.";
            }
          }
          const dens = currentDensity();
          document.querySelectorAll("#densitySeg button").forEach((b) => {
            b.classList.toggle("seg-active", b.dataset.densityChoice === dens);
          });
          const rate = String(currentRefreshRate());
          document.querySelectorAll("#refreshSeg button").forEach((b) => {
            b.classList.toggle("seg-active", b.dataset.refreshChoice === rate);
          });
          syncFullscreenControl();
          const sw2 = document.getElementById("accentSwatches");
          if (sw2) {
            const active = currentAccent();
            sw2.innerHTML = ACCENTS.map((a) =>
              '<button class="swatch' + (a.id === active ? " swatch-active" : "") + '" title="' + a.name +
              '" aria-label="' + a.name + '" style="background:' + a.base + '" onclick="setAccent(\\'' + a.id + '\\')"></button>'
            ).join("");
          }
        }

        function toggleTheme() {
          const root = document.documentElement;
          const nowDark = root.getAttribute("data-theme") !== "dark";
          if (nowDark) root.setAttribute("data-theme", "dark");
          else root.removeAttribute("data-theme");
          try { localStorage.setItem("stafly-theme", nowDark ? "dark" : "light"); } catch (e) {}
          applyAccent(currentAccent()); // accent tokens differ between themes
          syncSettingsControls(); // keep the Settings segmented control honest
          // The chart paints its axes onto a canvas, so unlike everything else
          // it can't follow a CSS variable -- it has to be redrawn.
          if (typeof lastAnalytics !== "undefined" && lastAnalytics) renderAnalytics(lastAnalytics);
        }

        function closeThreadMobile() {
          document.getElementById("conversationsView")?.classList.remove("thread-open");
          document.body.classList.remove("mobile-thread-open");
        }

        // Which weekdays orders actually land on, summed across the window.
        // Useful in a way a daily line isn't: it answers "when should I be at
        // my phone" rather than "what happened last Tuesday".
        function renderWeekdays(data) {
          const host = document.getElementById("dowRow");
          if (!host) return;
          const w = (data.weekday && data.weekday.orders) || [];
          const rev = (data.weekday && data.weekday.revenue) || [];
          const max = Math.max(1, ...w);
          const anyOrders = w.some((n) => n > 0);
          if (!anyOrders) {
            host.innerHTML = '<div class="home-empty">No paid orders in this window yet, so there is no pattern to show.</div>';
            return;
          }
          const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          const fullNames = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
          const best = w.indexOf(Math.max(...w));
          host.innerHTML = w.map((n, i) =>
            '<div class="dow' + (i === best ? " is-best" : "") + (n === 0 ? " is-zero" : "") +
              '" title="' + n + ' order' + (n === 1 ? "" : "s") +
              ', N' + (rev[i] || 0).toLocaleString() + ' on ' + fullNames[i] + '">' +
              '<div class="dow-slot"><div class="dow-bar" style="height:' + (n > 0 ? Math.max(Math.round((n / max) * 100), 12) : 0) + '%"></div></div>' +
              '<div class="dow-n">' + n + '</div>' +
              '<div class="dow-name">' + names[i].slice(0, 1) + '</div>' +
            '</div>'
          ).join("") +
          '<div class="dow-note">Busiest: <b>' + fullNames[best] + '</b></div>';
        }

        // New versus returning over the same window, both counted from stored
        // contact dates rather than a stored metric that could drift.
        function renderNewReturning(data, span) {
          const host = document.getElementById("newReturning");
          if (!host) return;
          const c = data.customers || { new: 0, returning: 0, total: 0, handledByOwner: 0 };
          const sub = document.getElementById("nrSub");
          if (sub) sub.textContent = "People who messaged you in the last " + span + " days.";
          const active = c.new + c.returning;
          if (active === 0) {
            host.innerHTML = '<div class="home-empty">Nobody messaged you in this window.</div>';
            return;
          }
          const newPct = Math.round((c.new / active) * 100);
          host.innerHTML =
            '<div class="nr-bar">' +
              (c.new ? '<div class="nr-seg nr-new" style="width:' + newPct + '%"></div>' : '') +
              (c.returning ? '<div class="nr-seg nr-ret" style="width:' + (100 - newPct) + '%"></div>' : '') +
            '</div>' +
            '<div class="nr-legend">' +
              '<div class="nr-item"><span class="nr-dot nr-new"></span><b>' + c.new + '</b> new</div>' +
              '<div class="nr-item"><span class="nr-dot nr-ret"></span><b>' + c.returning + '</b> came back</div>' +
            '</div>' +
            '<div class="nr-foot">' +
              (c.handledByOwner
                ? '<b>' + c.handledByOwner + '</b> of your ' + c.total + ' conversation' + (c.total === 1 ? " is" : "s are") + ' with you rather than Amara right now.'
                : 'Amara is handling all ' + c.total + ' of your conversations right now.') +
            '</div>';
        }

        // 7 / 14 / 30 days. Every number on the page follows it, including the
        // comparison against the window immediately before.
        let analyticsRange = 14;
        function setAnalyticsRange(days) {
          analyticsRange = days;
          document.querySelectorAll("#anRange button").forEach((b) => {
            b.classList.toggle("seg-active", Number(b.dataset.days) === days);
          });
          loadAnalytics();
        }

        async function loadAnalytics() {
          try {
            const res = await fetch("/api/analytics?days=" + analyticsRange + "&" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            renderAnalytics(data);
          } catch (err) {
            console.error("analytics load failed", err);
          }
        }

        let lastAnalytics = null;
        function renderAnalytics(data) {
          lastAnalytics = data; // kept so a theme switch can redraw the canvas
          const themeVar = (name, fallback) => {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
          };
          const axisColor = themeVar("--muted-2", "#94a3b8");
          const gridColor = themeVar("--border-light", "#f1f5f9");
          const labels = data.trend.map((d) => new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" }));
          const values = data.trend.map((d) => d.revenue);
          const orders = data.trend.map((d) => d.orders);
          // Building the chart is by far the most expensive thing on this
          // page -- 128ms in one frame on a 4x-throttled phone. The numbers
          // and lists below are cheap text, so they are painted first and the
          // chart is drawn in a later frame. The tab arrives complete-looking
          // straight away and the canvas fills in a beat behind it.
          const drawTrendChart = () => {
          const canvas = document.getElementById("trendChart");
          if (!canvas) return;
          const ctx = canvas.getContext("2d");

          // A real chart (Chart.js) instead of hand-rolled divs -- a
          // smooth gradient-filled area reads as an actual analytics
          // product rather than a prototype. Destroy + recreate on every
          // poll is simplest and cheap at this data size (14 points);
          // Chart.js has no built-in "update in place" that's simpler
          // than just rebuilding here.
          if (trendChartInstance) trendChartInstance.destroy();
          // The chart has to follow the chosen accent. Hardcoded, it stayed
          // indigo while every other accent-coloured thing on the page turned
          // teal or rose -- the same mistake the button shadows had.
          const accentHex = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#4f46e5").trim();
          const rgbOf = (hex) => {
            const h = hex.replace("#", "");
            if (h.length !== 6) return "79, 70, 229";
            return parseInt(h.slice(0, 2), 16) + ", " + parseInt(h.slice(2, 4), 16) + ", " + parseInt(h.slice(4, 6), 16);
          };
          const accentRgb = rgbOf(accentHex);
          const gradient = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 220);
          gradient.addColorStop(0, "rgba(" + accentRgb + ", 0.28)");
          gradient.addColorStop(1, "rgba(" + accentRgb + ", 0)");
          // A phone is a third of the width, so it gets a third of the labels:
          // 14 rotated dates crammed under a 340px chart is unreadable.
          const narrow = window.innerWidth <= 700;
          trendChartInstance = new Chart(ctx, {
            type: "line",
            data: {
              labels: labels,
              datasets: [{
                label: "Revenue",
                data: values,
                borderColor: accentHex,
                borderWidth: narrow ? 2 : 2.5,
                backgroundColor: gradient,
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: accentHex,
                pointHoverBorderColor: "#fff",
                pointHoverBorderWidth: 2,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              // Chart.js animates itself in over ~1s by default. Straight
              // after a tab transition on a phone that is a second of extra
              // frames for a chart the seller is already looking at, and it
              // measured as a 113ms frame. The chart appears drawn instead.
              animation: narrow ? false : { duration: 400 },
              interaction: { mode: "index", intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: "#1e293b",
                  padding: 10,
                  cornerRadius: 8,
                  titleFont: { family: "Geist Variable", weight: "600" },
                  bodyFont: { family: "Geist Variable" },
                  callbacks: {
                    label: (item) => {
                      const i = item.dataIndex;
                      return "N" + item.parsed.y.toLocaleString() + " (" + orders[i] + " order" + (orders[i] === 1 ? "" : "s") + ")";
                    },
                  },
                },
              },
              scales: {
                x: {
                  grid: { display: false },
                  ticks: {
                    color: axisColor,
                    font: { family: "Geist Variable", size: narrow ? 10 : 11 },
                    maxRotation: 0,
                    minRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: narrow ? 4 : 8,
                  },
                },
                y: {
                  beginAtZero: true,
                  grid: { color: gridColor },
                  border: { display: false },
                  ticks: {
                    color: axisColor,
                    font: { family: "Geist Variable", size: narrow ? 10 : 11 },
                    maxTicksLimit: narrow ? 4 : 6,
                    padding: narrow ? 4 : 8,
                    callback: (v) => v >= 1000 ? "N" + Math.round(v / 1000) + "k" : "N" + v,
                  },
                },
              },
            },
          });
          };
          if (window.requestIdleCallback) requestIdleCallback(drawTrendChart, { timeout: 300 });
          else setTimeout(drawTrendChart, 0);

          // KPIs, all arithmetic on the same 14 days the chart draws -- no
          // projections, no benchmarks, nothing the data can't support.
          const totalRevenue = values.reduce((a2, b2) => a2 + b2, 0);
          const totalOrders = orders.reduce((a2, b2) => a2 + b2, 0);
          const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
          let bestIdx = -1;
          values.forEach((v, i) => { if (v > 0 && (bestIdx === -1 || v > values[bestIdx])) bestIdx = i; });
          const span = data.span || 14;
          const windowLabel = "last " + span + " days";
          const rl = document.getElementById("anRangeLabel");
          if (rl) rl.textContent = "Last " + span + " days, compared with the " + span + " before";
          const rcs = document.getElementById("revenueCardSub");
          if (rcs) rcs.textContent = "Paid orders over the " + windowLabel + ".";

          // A comparison is only shown when the previous window actually has
          // records to compare against. "up 100%" from a window nobody was
          // selling in yet is a made-up number, so it says so instead.
          const prev = data.previous || { hasData: false };
          // "vs prev 14d" rather than "vs last 14 days": the same fact, on one
          // line, in a card that is 172px wide on a laptop.
          const pill = (cls, icon, text) =>
            '<span class="kpi-delta ' + cls + '">' + (icon ? ICON_TREND : "") +
            '<span class="d-txt">' + text + '</span></span>';
          const delta = (now, before) => {
            if (!prev.hasData) return { html: pill("none", false, "no earlier data") };
            if (!before) {
              return { html: now > 0
                ? pill("up", true, "first in " + span + " days")
                : pill("none", false, "nothing either window") };
            }
            const pctChange = Math.round(((now - before) / before) * 100);
            if (pctChange === 0) return { html: pill("flat", false, "level with prev " + span + "d") };
            const up = pctChange > 0;
            return { html: pill(up ? "up" : "down", true, (up ? "+" : "") + pctChange + "% vs prev " + span + "d") };
          };

          const kpi = (cls, icon, value, label, footHtml) =>
            '<div class="kpi-card ' + cls + '">' +
              '<div class="kpi-top"><span class="kpi-mark">' + icon + '</span>' +
              '<span class="kpi-name">' + label + '</span></div>' +
              '<div class="kpi-bottom">' +
                '<div class="kpi-figure">' + value + '</div>' +
                '<div class="kpi-foot">' + (footHtml || "") + '</div>' +
              '</div>' +
            '</div>';
          document.getElementById("analyticsKpis").innerHTML =
            kpi("k-revenue", ICON_WALLET, "N" + totalRevenue.toLocaleString(), "Revenue", delta(totalRevenue, prev.revenue).html) +
            kpi("k-orders", ICON_BOX, totalOrders.toLocaleString(), "Paid orders", delta(totalOrders, prev.orders).html) +
            kpi("k-average", ICON_WALLET, totalOrders > 0 ? "N" + avgOrder.toLocaleString() : "\u2014", "Average order",
              pill("none", false, totalOrders > 0 ? "across " + totalOrders + " order" + (totalOrders === 1 ? "" : "s") : "no orders yet")) +
            kpi("k-best", ICON_TREND, bestIdx === -1 ? "\u2014" : "N" + values[bestIdx].toLocaleString(), "Best day",
              pill("none", false, bestIdx === -1 ? "no sales in this window" : escapeHtml(labels[bestIdx])));

          renderWeekdays(data);
          renderNewReturning(data, span);

          const maxSold = Math.max(1, ...data.bestSellers.map((p) => p.sold));
          const list = document.getElementById("bestSellersList");
          list.innerHTML = data.bestSellers.length > 0
            ? data.bestSellers.map((p, i) =>
                '<div class="seller-row">' +
                  '<span class="seller-rank">' + (i + 1) + '</span>' +
                  '<div class="seller-main">' +
                    '<div class="seller-top"><span class="seller-name">' + escapeHtml(p.name) + '</span>' +
                    '<span class="seller-rev">N' + p.revenue.toLocaleString() + '</span></div>' +
                    '<div class="best-seller-bar-track"><div class="best-seller-bar-fill" style="width:' + Math.round((p.sold / maxSold) * 100) + '%;"></div></div>' +
                    '<div class="seller-units">' + p.sold + ' sold</div>' +
                  '</div>' +
                '</div>'
              ).join("")
            : '<div class="empty"><div class="empty-icon">' + ICON_BOX + '</div><div class="empty-title">No sales yet</div><div class="empty-sub">Once a customer pays, your best sellers show up here.</div></div>';

          document.getElementById("conversionStat").textContent = data.conversion.conversionPct + "%";
          const fill = document.getElementById("conversionFill");
          if (fill) fill.style.width = Math.min(100, data.conversion.conversionPct) + "%";
          document.getElementById("conversionSub").textContent =
            data.conversion.paidCustomers + " of " + data.conversion.totalCustomers + " conversation" +
            (data.conversion.totalCustomers === 1 ? "" : "s") + " turned into a paid order";
        }

        // ---- Home tab ----------------------------------------------------
        // The landing view: who the shop is, what needs the seller now, and
        // what state the account is actually in. Every number and row here is
        // read from stored data -- nothing on this page is estimated.
        let homeData = null;
        let editingProfile = false;

        const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>';
        const ICON_TICK_CIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><polyline points="8 12.2 11 15.2 16 9.5"/></svg>';
        const ICON_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        const ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
        const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
        const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/></svg>';

        async function loadHome() {
          try {
            const res = await fetch("/api/home?" + ADMIN_QS);
            if (!res.ok) throw new Error("HTTP " + res.status);
            const wasNull = !homeData;
            homeData = await res.json();
            renderHome();
            // The Settings switch for the setup checklist reads its state from
            // homeData, which is null on the very first paint -- so the switch
            // would sit in the wrong position until something else happened to
            // refresh it. Re-sync once, the moment the real state arrives.
            if (wasNull) syncSettingsControls();
          } catch (err) {
            console.error("loadHome failed:", err);
            const host = document.getElementById("homeView");
            if (host && !homeData) {
              host.innerHTML = '<div class="home-inner"><div class="catalog-card"><div class="home-empty">Could not load your dashboard just now. It will retry on the next refresh.</div></div></div>';
            }
          }
        }

        function homeBrandCard(p, d) {
          const initial = escapeHtml((p.businessName || "S").trim().charAt(0).toUpperCase());
          const avatar = p.avatarUrl ? '<img src="' + escapeHtml(p.avatarUrl) + '" alt="">' : initial;
          const coverStyle = p.coverUrl
            ? ' class="brand-cover has-photo" style="--cover-img:url(' + encodeURI(p.coverUrl) + ')"'
            : ' class="brand-cover"';
          const meta = [];
          if (p.location) meta.push('<span>' + ICON_PIN + escapeHtml(p.location) + '</span>');
          meta.push('<span>' + ICON_BOX + d.catalogue.total + ' product' + (d.catalogue.total === 1 ? "" : "s") + '</span>');
          meta.push('<span>' + ICON_USERS + d.stats.totalCustomers + ' customer' + (d.stats.totalCustomers === 1 ? "" : "s") + '</span>');
          if (p.createdAt) {
            const dt = new Date(p.createdAt);
            if (!isNaN(dt)) meta.push('<span>' + ICON_CAL + 'Since ' + dt.toLocaleDateString(undefined, { month: "short", year: "numeric" }) + '</span>');
          }
          // The pill states a fact from the connection check, nothing more:
          // Amara literally cannot reply without both credentials.
          const live = d.connection.connected && !d.connection.suspended
            ? '<span class="live-pill"><span class="live-dot"></span>Amara is live</span>'
            : '<span class="live-pill off"><span class="live-dot"></span>Not connected</span>';
          return '' +
            '<div class="brand-card">' +
              '<div' + coverStyle + '>' +
                '<button class="photo-btn cover-photo-btn" data-home-action="pick-cover">' + ICON_CAMERA + (p.coverUrl ? "Change cover" : "Add cover") + '</button>' +
              '</div>' +
              '<div class="brand-body">' +
                '<div class="brand-avatar-wrap">' +
                  '<div class="brand-avatar' + (p.avatarUrl ? " has-photo" : "") + '">' + avatar + '</div>' +
                  '<button class="photo-btn avatar-photo-btn" data-home-action="pick-avatar" aria-label="' + (p.avatarUrl ? "Change profile picture" : "Add a profile picture") + '">' + ICON_CAMERA + '</button>' +
                '</div>' +
                '<div class="brand-head-row">' +
                  '<div class="brand-text">' +
                    '<div class="brand-title-line">' +
                      '<h2 class="brand-name">' + escapeHtml(p.businessName || "Your business") + '</h2>' + live +
                    '</div>' +
                    (p.tagline
                      ? '<div class="brand-tagline">' + escapeHtml(p.tagline) + '</div>'
                      : '<div class="brand-empty-hint">No tagline yet. <button data-home-action="edit-profile">Add one</button></div>') +
                    (meta.length ? '<div class="brand-meta">' + meta.join("") + '</div>' : '') +
                    (p.about ? '<div class="brand-about">' + escapeHtml(p.about) + '</div>' : '') +
                  '</div>' +
                  '<button class="btn-quiet brand-edit-btn" data-home-action="edit-profile">Edit profile</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        }

        function homeProfileForm(p) {
          return '' +
            '<div class="brand-card"><div style="padding:22px 24px 24px;">' +
              '<h3 style="font-family:var(--font-heading);font-size:18px;font-weight:750;letter-spacing:-0.015em;margin:0;">Edit profile</h3>' +
              '<div class="home-card-sub">Your shop in your own words. Amara never writes any of this for you.</div>' +
              '<div class="profile-form">' +
                '<div class="profile-field"><label for="pfName">Business name</label>' +
                  '<input id="pfName" maxlength="60" value="' + escapeHtml(p.businessName || "") + '"></div>' +
                '<div class="profile-field"><label for="pfTagline">Tagline</label>' +
                  '<input id="pfTagline" maxlength="90" placeholder="e.g. Ready-to-wear Ankara, made in Lagos" value="' + escapeHtml(p.tagline || "") + '"></div>' +
                '<div class="profile-field"><label for="pfLocation">Location</label>' +
                  '<input id="pfLocation" maxlength="60" placeholder="e.g. Lekki, Lagos" value="' + escapeHtml(p.location || "") + '"></div>' +
                '<div class="profile-field"><label for="pfAbout">About</label>' +
                  '<textarea id="pfAbout" maxlength="400" placeholder="What you sell, who you sell to, anything a customer should know.">' + escapeHtml(p.about || "") + '</textarea></div>' +
              '</div>' +
              '<span class="catalog-msg" id="profileStatus"></span>' +
              '<div class="setup-actions">' +
                '<button class="catalog-btn" data-home-action="save-profile">Save changes</button>' +
                '<button class="btn-quiet" data-home-action="cancel-profile">Cancel</button>' +
              '</div>' +
            '</div></div>';
        }

        function homeSetupCard(d) {
          const p = d.profile;
          const steps = [
            { done: !!p.avatarUrl, label: "Profile picture", action: "pick-avatar" },
            { done: !!p.coverUrl, label: "Cover photo", action: "pick-cover" },
            { done: !!p.tagline, label: "Short tagline", action: "edit-profile" },
            { done: d.catalogue.total > 0, label: "First product", action: "go-catalog" },
          ];
          const doneCount = steps.filter((s) => s.done).length;
          if (doneCount === steps.length || p.setupDismissed) return "";
          const pct = Math.round((doneCount / steps.length) * 100);
          return '' +
            '<div class="setup-card">' +
              '<div class="setup-top">' +
                '<div>' +
                  '<div class="setup-title">Finish setting up your shop</div>' +
                  '<div class="setup-sub">Your customers only ever meet Amara on WhatsApp, so this is for your own dashboard. Skip it and add these whenever you like.</div>' +
                '</div>' +
              '</div>' +
              '<div class="setup-progress">' +
                '<div class="setup-bar"><div class="setup-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<div class="setup-progress-text">' + doneCount + ' of ' + steps.length + '</div>' +
              '</div>' +
              '<div class="setup-steps">' +
                steps.map((s) =>
                  '<div class="setup-step' + (s.done ? " done" : "") + '"' + (s.done ? "" : ' data-home-action="' + s.action + '"') + '>' +
                    '<span class="tick">' + ICON_TICK + '</span>' + escapeHtml(s.label) +
                  '</div>'
                ).join("") +
              '</div>' +
              '<div class="setup-actions">' +
                '<button class="btn-quiet" data-home-action="dismiss-setup">Hide this</button>' +
              '</div>' +
            '</div>';
        }

        function homeAlerts(d) {
          if (d.connection.suspended) {
            return '<div class="home-alert bad">' + ICON_ALERT +
              '<div><b>This account is suspended.</b> Amara is not replying to any customer messages. Contact support to have it reviewed.</div></div>';
          }
          if (!d.connection.connected) {
            return '<div class="home-alert warn">' + ICON_ALERT +
              '<div><b>WhatsApp isn’t connected yet.</b> Amara can’t send or receive messages until your number is linked, so nothing on this dashboard will move until then.</div></div>';
          }
          return "";
        }

        function homeWaitingCard(d) {
          const rows = d.waiting.map((w) => {
            const c = { phone: w.phone, wa_name: w.wa_name };
            return '' +
              '<div class="waiting-row" data-home-action="open-thread" data-phone="' + escapeHtml(w.phone) + '">' +
                '<div class="waiting-avatar" style="background:' + avatarColorFor(w.phone) + '">' + escapeHtml(avatarTextFor(c)) + '</div>' +
                '<div class="waiting-main">' +
                  '<div class="waiting-top"><span class="waiting-name">' + escapeHtml(displayNameFor(c)) + '</span>' +
                    (w.paused
                      ? '<span class="waiting-flag">YOURS</span>'
                      : '<span class="waiting-when">' + escapeHtml(timeAgo(w.last_contact)) + '</span>') +
                  '</div>' +
                  '<div class="waiting-preview">' + escapeHtml(w.preview || "No message text") + '</div>' +
                '</div>' +
                '<span class="waiting-chev">' + ICON_CHEVRON + '</span>' +
              '</div>';
          }).join("");
          const more = d.waitingTotal > d.waiting.length
            ? '<div class="setup-actions"><button class="btn-quiet" data-home-action="go-conversations">See all ' + d.waitingTotal + ' in Conversations</button></div>'
            : "";
          return '' +
            '<div class="home-card">' +
              '<div class="home-card-head">' +
                '<div><h3>Waiting on a reply</h3>' +
                  '<div class="home-card-sub">Threads where the customer spoke last.</div></div>' +
                (d.waitingTotal ? '<span class="home-count-chip">' + d.waitingTotal + '</span>' : '<span class="home-count-chip calm">0</span>') +
              '</div>' +
              (d.waiting.length
                ? '<div class="waiting-list">' + rows + '</div>' + more
                : '<div class="home-empty"><div class="home-empty-icon">' + ICON_TICK_CIRCLE + '</div>Nobody is waiting. Every conversation has had the last word from you or from Amara.</div>') +
            '</div>';
        }

        // Tiles are built here rather than reusing the analytics stat tile, so
        // Home can carry a second line of real context under each number. Every
        // context line below is counted from stored records -- there are no
        // invented deltas and no "vs last week" where nothing was recorded.
        function homeTile(cls, icon, value, label, context) {
          return '' +
            '<div class="htile ' + cls + '">' +
              '<div class="htile-top">' +
                '<span class="htile-icon">' + icon + '</span>' +
                '<span class="htile-value">' + value + '</span>' +
              '</div>' +
              '<div class="htile-label">' + label + '</div>' +
              (context ? '<div class="htile-context">' + context + '</div>' : '') +
            '</div>';
        }

        let homeStatsAnimated = false;
        function renderHomeStats(d) {
          const host = document.getElementById("homeStats");
          if (!host || !d.stats) return;
          const s = d.stats;
          const nw = d.newThisWeek || 0;
          const paidToday = s.paymentsToday || 0;
          host.innerHTML =
            homeTile("t-total", ICON_USERS, s.totalCustomers, "Total customers",
              nw > 0 ? "+" + nw + " this week" : "none new this week") +
            homeTile("t-active", ICON_CHAT, s.activeToday, "Active today",
              s.totalCustomers ? "of " + s.totalCustomers + " you've ever spoken to" : "") +
            homeTile("t-paused", ICON_PAUSE, s.pausedNow, "You're handling",
              s.pausedNow ? "Amara has stepped back" : "Amara is on all of them") +
            homeTile("t-revenue", ICON_WALLET, "N" + (s.revenueTodayNaira || 0).toLocaleString(), "Paid today",
              paidToday ? paidToday + " order" + (paidToday === 1 ? "" : "s") : "no orders yet today");
          // Count up only the first time. The poll must not restart it, or the
          // numbers would visibly churn every few seconds.
          if (!homeStatsAnimated) {
            homeStatsAnimated = true;
            const vals = host.querySelectorAll(".htile-value");
            const targets = [s.totalCustomers, s.activeToday, s.pausedNow, s.revenueTodayNaira];
            vals.forEach((el, i) => countUp(el, targets[i] || 0, i === 3 ? "N" : ""));
          }
        }

        // Seven days of real activity: new conversations counted from each
        // customer's own first_contact, and orders from the same daily totals
        // the Analytics tab reads. Drawn as inline SVG rather than a chart
        // library, because it is eight numbers and pulling Chart.js into Home
        // would cost more than the picture is worth.
        function homeWeekCard(d) {
          const week = d.week || [];
          if (!week.length) return "";
          const maxNew = Math.max(1, ...week.map((x) => x.newCustomers));
          const totalNew = week.reduce((a, x) => a + x.newCustomers, 0);
          const totalOrders = week.reduce((a, x) => a + x.orders, 0);
          const totalRev = week.reduce((a, x) => a + x.revenue, 0);
          const today = new Date().toISOString().slice(0, 10);
          const bars = week.map((x) => {
            const h = Math.round((x.newCustomers / maxNew) * 100);
            const dt = new Date(x.date + "T00:00:00");
            const dayLetter = isNaN(dt) ? "" : dt.toLocaleDateString(undefined, { weekday: "narrow" });
            const label = x.newCustomers + (x.newCustomers === 1 ? " new conversation" : " new conversations") +
              (isNaN(dt) ? "" : " on " + dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }));
            return '' +
              '<div class="wk-col' + (x.date === today ? " is-today" : "") + '" title="' + escapeHtml(label) + '">' +
                '<div class="wk-bar-slot">' +
                  '<div class="wk-bar" style="height:' + Math.max(h, x.newCustomers > 0 ? 8 : 2) + '%"></div>' +
                '</div>' +
                '<div class="wk-day">' + escapeHtml(dayLetter) + '</div>' +
              '</div>';
          }).join("");
          return '' +
            '<div class="home-card wk-card">' +
              '<div class="home-card-head">' +
                '<div><h3>Last 7 days</h3>' +
                  '<div class="home-card-sub">New conversations per day.</div></div>' +
              '</div>' +
              '<div class="wk-chart">' + bars + '</div>' +
              '<div class="wk-foot">' +
                '<div class="wk-stat"><b>' + totalNew + '</b><span>new</span></div>' +
                '<div class="wk-stat"><b>' + totalOrders + '</b><span>paid orders</span></div>' +
                '<div class="wk-stat"><b>N' + totalRev.toLocaleString() + '</b><span>taken</span></div>' +
              '</div>' +
            '</div>';
        }

        function homeCatalogueCard(d) {
          const c = d.catalogue;
          if (c.total === 0) {
            return '' +
              '<div class="home-card">' +
                '<div class="home-card-head"><div><h3>Your catalogue</h3>' +
                  '<div class="home-card-sub">What Amara can quote and sell for you.</div></div></div>' +
                '<div class="home-empty"><div class="home-empty-icon">' + ICON_BOX + '</div>' +
                  'No products yet. Until you add one, Amara can answer questions but can’t quote a price.</div>' +
                '<div class="setup-actions"><button class="catalog-btn" data-home-action="go-catalog">Add your first product</button></div>' +
              '</div>';
          }
          // One honest ratio: how many of the three details each product could
          // carry are actually filled in. Nothing weighted, nothing estimated.
          const slots = c.total * 3;
          const missingTotal = c.missingPhoto + c.missingPrice + c.missingCategory;
          const pct = Math.round(((slots - missingTotal) / slots) * 100);
          const R = 19, CIRC = 2 * Math.PI * R;

          // The gaps read as chips rather than three labelled rows -- same
          // three facts, a third of the words, and the ones that are fine
          // simply aren't mentioned.
          const chips = [];
          if (c.missingPhoto) chips.push('<span class="gchip">' + c.missingPhoto + ' need a photo</span>');
          if (c.missingPrice) chips.push('<span class="gchip">' + c.missingPrice + ' need a price</span>');
          if (c.missingCategory) chips.push('<span class="gchip">' + c.missingCategory + ' need a category</span>');
          const gapLine = chips.length
            ? '<div class="gap-chips">' + chips.join("") + '</div>'
            : '<div class="gap-chips"><span class="gchip ok">' + ICON_TICK + 'Every product is complete</span></div>';

          const products = (c.topProducts || []).map((p, i) => {
            const thumb = p.hasOwnPhoto && p.image
              ? '<img src="' + escapeHtml(p.image) + '" alt="" loading="lazy">'
              : '<span class="ptile-blank">' + ICON_IMAGE + '</span>';
            return '' +
              '<div class="ptile" data-home-action="go-catalog" style="--i:' + i + '" title="' + escapeHtml(p.name) + '">' +
                '<div class="ptile-img">' + thumb +
                  (p.sold ? '<span class="ptile-sold">' + p.sold + ' sold</span>' : '') +
                  '<span class="ptile-veil"></span>' +
                  '<span class="ptile-price">' + (p.price ? "N" + p.price.toLocaleString() : "No price") + '</span>' +
                '</div>' +
                '<div class="ptile-name">' + escapeHtml(p.name) + '</div>' +
              '</div>';
          }).join("");

          return '' +
            '<div class="home-card cat-card">' +
              '<div class="home-card-head">' +
                '<div><h3>Your catalogue</h3>' +
                  '<div class="home-card-sub">' + c.total + ' product' + (c.total === 1 ? "" : "s") + ' Amara can quote and sell.</div></div>' +
                // The ring moved into the header: it is a status, and a status
                // belongs beside the title, not in a block of its own.
                '<div class="ring-badge" title="' + pct + '% of product details filled in">' +
                  '<svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="' + R + '"></circle>' +
                  '<circle class="fill" cx="22" cy="22" r="' + R + '" stroke-dasharray="' + CIRC.toFixed(1) + '" stroke-dashoffset="' + (CIRC * (1 - pct / 100)).toFixed(1) + '"></circle></svg>' +
                  '<b>' + pct + '<i>%</i></b>' +
                '</div>' +
              '</div>' +
              (products ? '<div class="ptile-row">' + products + '</div>' : '') +
              gapLine +
              '<div class="setup-actions"><button class="btn-quiet" data-home-action="go-catalog">Open catalogue</button></div>' +
            '</div>';
        }

        // The 5s poll refreshes Home while it is open. Rebuilding the whole
        // view on every tick would flicker, restart the count-up, and -- much
        // worse -- destroy whatever the seller was halfway through typing in
        // the edit form. So: never re-render underneath an open form, and
        // otherwise only when something actually changed.
        let lastHomeSignature = null;
        function homeSignature(d) {
          return JSON.stringify([
            d.profile, d.waitingTotal, d.catalogue, d.connection, d.stats,
            d.waiting.map((w) => [w.phone, w.last_contact, w.paused, w.preview]),
          ]);
        }
        function renderHome(force) {
          const host = document.getElementById("homeView");
          if (!host || !homeData) return;
          const d = homeData;
          // A first paint, or a return to a tab that was empty, is worth
          // animating. A poll that happens to find changed data is not -- the
          // page would visibly re-deal itself every few seconds.
          const fresh = !host.querySelector(".home-inner");
          if (!force) {
            if (editingProfile && host.querySelector("#pfName")) return;
            const sig = homeSignature(d);
            if (sig === lastHomeSignature && host.querySelector(".home-inner")) return;
            lastHomeSignature = sig;
          } else {
            lastHomeSignature = homeSignature(d);
          }
          host.innerHTML = '' +
            '<div class="home-inner">' +
              homeAlerts(d) +
              (editingProfile ? homeProfileForm(d.profile) : homeBrandCard(d.profile, d)) +
              homeSetupCard(d) +
              '<div class="home-section-head">' +
                '<div class="home-section-label"><span class="pulse-dot"></span>Right now</div>' +
                '<div class="home-section-note">Updates on its own</div>' +
              '</div>' +
              '<div class="home-stats" id="homeStats"></div>' +
              '<div class="home-grid">' +
                homeWaitingCard(d) +
                '<div class="home-col">' + homeWeekCard(d) + homeCatalogueCard(d) + '</div>' +
              '</div>' +
              '<div class="catalog-msg" id="homeMsg" style="margin-top:14px;"></div>' +
            '</div>' +
            '<input type="file" id="brandPhotoInput" accept="image/*" hidden>';
          // The live numbers come from the same poll that drives everything
          // else, so if it has already run we paint them immediately rather
          // than leaving a gap until the next tick.
          renderHomeStats(d);
          syncBrandAvatar(d.profile.avatarUrl, d.profile.businessName);
          if (fresh) staggerHomeIn(host);
          const input = document.getElementById("brandPhotoInput");
          if (input) input.addEventListener("change", onBrandPhotoPicked);
        }

        // Home arrives in sequence rather than all at once: masthead, then the
        // numbers, then the two cards. Each is 40ms behind the last, which is
        // long enough to read as deliberate and short enough that the whole
        // thing is settled in under a third of a second. WAAPI on opacity and
        // transform only, so it stays on the compositor.
        function staggerHomeIn(host) {
          if (!host || !host.animate || prefersReducedMotion()) return;
          const rows = [
            host.querySelector(".brand-card"),
            host.querySelector(".home-alert"),
            host.querySelector(".setup-card"),
            host.querySelector(".home-section-head"),
            host.querySelector(".home-stats"),
            host.querySelector(".home-grid > *:first-child"),
            host.querySelector(".home-grid .home-col"),
          ].filter(Boolean);
          rows.forEach((el, i) => {
            if (!el.animate) return;
            el.animate(
              [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
              { duration: 300, delay: i * 40, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
            );
          });
          // The four numbers count up, and their tiles land one after another
          // rather than as a single block of four.
          host.querySelectorAll(".home-stats .htile").forEach((el, i) => {
            if (!el.animate) return;
            el.animate(
              [{ opacity: 0, transform: "translateY(8px) scale(0.985)" }, { opacity: 1, transform: "none" }],
              { duration: 320, delay: 160 + i * 45, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
            );
          });
          // Product tiles deal in from the left, in order.
          host.querySelectorAll(".ptile").forEach((el, i) => {
            if (!el.animate) return;
            el.animate(
              [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
              { duration: 300, delay: 320 + i * 55, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
            );
          });
          // The week bars grow from the baseline instead of appearing at full
          // height. transform on a bar anchored at its bottom edge, so this is
          // still a compositor property and not a layout animation.
          host.querySelectorAll(".wk-bar").forEach((el, i) => {
            if (!el.animate) return;
            el.style.transformOrigin = "bottom";
            el.animate(
              [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
              { duration: 520, delay: 300 + i * 50, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
            );
          });
        }

        // One delegated listener rather than inline onclick handlers: the
        // markup above is built by string concatenation, and quoting a phone
        // number into an inline handler is exactly how this file's page
        // script has been broken before.
        // Edit/Remove used to be inline onclick attributes with the product key
        // quoted into them -- the exact shape that broke this page's script
        // twice. Delegation keeps the key in a data attribute instead.
        document.addEventListener("click", (e) => {
          const el = e.target.closest && e.target.closest("[data-cat-action]");
          if (!el) return;
          const key = el.getAttribute("data-key");
          if (!key) return;
          if (el.getAttribute("data-cat-action") === "edit") editProduct(key);
          else deleteProduct(key);
        });

        let pendingPhotoKind = "avatar";
        document.addEventListener("click", (e) => {
          const el = e.target.closest("[data-home-action]");
          if (!el) return;
          const action = el.getAttribute("data-home-action");
          if (action === "pick-avatar" || action === "pick-cover") {
            pendingPhotoKind = action === "pick-cover" ? "cover" : "avatar";
            document.getElementById("brandPhotoInput")?.click();
          } else if (action === "edit-profile") {
            editingProfile = true;
            renderHome(true);
          } else if (action === "cancel-profile") {
            editingProfile = false;
            renderHome(true);
          } else if (action === "save-profile") {
            saveProfile();
          } else if (action === "dismiss-setup") {
            setSetupDismissed(true);
          } else if (action === "go-catalog") {
            switchTab("catalog");
          } else if (action === "go-conversations") {
            switchTab("conversations");
          } else if (action === "open-thread") {
            const phone = el.getAttribute("data-phone");
            if (phone) {
              switchTab("conversations");
              loadConversation(phone, true);
            }
          }
        });

        async function saveProfile() {
          const status = document.getElementById("profileStatus");
          const body = {
            businessName: document.getElementById("pfName").value,
            tagline: document.getElementById("pfTagline").value,
            location: document.getElementById("pfLocation").value,
            about: document.getElementById("pfAbout").value,
          };
          if (status) { status.className = "catalog-msg"; status.textContent = "Saving..."; }
          try {
            const res = await fetch("/api/profile?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Could not save.");
            homeData.profile = data.profile;
            editingProfile = false;
            renderHome(true);
            // The business name appears in three places outside this card.
            syncBusinessName(data.profile.businessName);
            toast("Profile saved");
          } catch (err) {
            if (status) { flash(status, err.message, "bad", "Couldn't save your profile"); }
          }
        }

        // Home is the only place that knows whether a profile picture exists,
        // so it is what pushes it out to the sidebar and topbar.
        function syncBrandAvatar(url, name) {
          const initial = (name || "S").trim().charAt(0).toUpperCase();
          [document.querySelector(".sidebar-profile-avatar"), document.querySelector(".topbar-avatar")].forEach((el) => {
            if (!el) return;
            if (url) {
              if (el.querySelector("img")) {
                el.querySelector("img").src = url;
              } else {
                const img = document.createElement("img");
                img.alt = "";
                img.src = url;
                el.textContent = "";
                el.appendChild(img);
              }
              el.classList.add("has-photo");
            } else {
              el.classList.remove("has-photo");
              el.textContent = initial;
            }
          });
        }

        function syncBusinessName(name) {
          if (!name) return;
          const el = document.querySelector(".sidebar-profile-name");
          if (el) el.textContent = name;
          const chip = document.querySelector(".topbar-biz span");
          if (chip) chip.textContent = name;
          const av = document.querySelector(".topbar-avatar");
          if (av && !av.classList.contains("has-photo")) av.textContent = name.trim().charAt(0).toUpperCase();
        }

        function homeSetupHidden() {
          return !!(homeData && homeData.profile && homeData.profile.setupDismissed);
        }
        async function setSetupDismissed(dismissed) {
          try {
            await fetch("/api/profile/setup-dismissed?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dismissed: dismissed }),
            });
            if (homeData) homeData.profile.setupDismissed = dismissed;
            renderHome(true);
            syncSettingsControls();
          } catch (err) {
            console.error("setSetupDismissed failed:", err);
          }
        }

        async function onBrandPhotoPicked(e) {
          const file = e.target.files && e.target.files[0];
          e.target.value = ""; // so picking the same file twice still fires
          if (!file) return;
          const kind = pendingPhotoKind;
          const form = new FormData();
          form.append("photo", file);
          form.append("kind", kind);
          try {
            const res = await fetch("/api/profile/photo?" + ADMIN_QS, { method: "POST", body: form });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Upload failed.");
            if (homeData) {
              if (kind === "cover") homeData.profile.coverUrl = data.url;
              else homeData.profile.avatarUrl = data.url;
              renderHome(true);
              const msg = document.getElementById("homeMsg");
              if (msg) { flash(msg, "", "ok", kind === "cover" ? "Cover photo updated" : "Profile picture updated"); }
            }
          } catch (err) {
            // A modal alert would block the whole page; this says the same
            // thing in the card the seller is already looking at.
            const msg = document.getElementById("homeMsg");
            if (msg) { flash(msg, err.message, "bad", "Upload failed"); }
          }
        }

        async function loadCatalog() {
          try {
            const res = await fetch("/api/catalog?" + ADMIN_QS);
            const data = await res.json();
            if (data.error) return;
            window.nigeriaStates = data.nigeriaStates || [];
            productSales = data.sales || {};
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

        // Sales per product key, so the grid can show what is actually moving.
        // Absent simply means nothing recorded yet -- never a zero invented to
        // fill the space.
        let productSales = {};

        // The grid is rebuilt from the cache on every search keystroke, sort
        // change and category switch, so all three compose instead of each one
        // resetting the others.
        function renderProductGrid() {
          const products = window.catalogCache || {};
          const grid = document.getElementById("productGrid");
          if (!grid) return;
          const q = (document.getElementById("productSearch")?.value || "").trim().toLowerCase();
          const sort = document.getElementById("productSort")?.value || "name";
          const keys = Object.keys(products);

          const incompleteCount = (k) => {
            const p = products[k];
            let n = 0;
            if (!p.hasOwnPhoto) n++;
            if (!Number(p.price)) n++;
            if (!(p.category || "").trim()) n++;
            return n;
          };

          let visible = keys.filter((k) => {
            const p = products[k];
            if (currentCategory !== "all" && (p.category || "") !== currentCategory) return false;
            if (!q) return true;
            return (p.name || "").toLowerCase().includes(q) ||
              k.toLowerCase().includes(q) ||
              (p.category || "").toLowerCase().includes(q) ||
              (p.description || "").toLowerCase().includes(q);
          });

          visible.sort((a, b) => {
            const pa = products[a], pb = products[b];
            if (sort === "price-desc") return Number(pb.price) - Number(pa.price);
            if (sort === "price-asc") return Number(pa.price) - Number(pb.price);
            if (sort === "sold") return (productSales[b] || 0) - (productSales[a] || 0);
            if (sort === "incomplete") return incompleteCount(b) - incompleteCount(a);
            return String(pa.name || a).localeCompare(String(pb.name || b));
          });

          if (keys.length === 0) {
            grid.innerHTML = '<div class="empty"><div class="empty-icon">' + ICON_BOX + '</div><div class="empty-title">No products yet</div><div class="empty-sub">Add your first product and Amara can start quoting and selling it straight away.</div></div>';
          } else if (visible.length === 0) {
            grid.innerHTML = '<div class="empty"><div class="empty-icon">' + ICON_SEARCH + '</div><div class="empty-title">Nothing matches</div><div class="empty-sub">' +
              (q ? 'No product matches "' + escapeHtml(q) + '".' : "Nothing in this category.") + '</div></div>';
          } else {
            grid.innerHTML = visible.map((k) => {
              const p = products[k];
              const sold = productSales[k] || 0;
              const missing = [];
              if (!p.hasOwnPhoto) missing.push("photo");
              if (!Number(p.price)) missing.push("price");
              if (!(p.category || "").trim()) missing.push("category");
              return '<div class="product-card' + (missing.length ? " needs-work" : "") + '" data-key="' + escapeHtml(k) + '">' +
                '<div class="product-thumb">' +
                  '<img src="' + escapeHtml(p.imageUrl || "") + '" alt="" loading="lazy">' +
                  (p.category ? '<span class="thumb-cat">' + escapeHtml(p.category) + '</span>' : '') +
                  (sold ? '<span class="thumb-sold">' + sold + ' sold</span>' : '') +
                '</div>' +
                '<div class="product-body">' +
                  '<div class="product-name" title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</div>' +
                  '<div class="product-price">' + (Number(p.price) ? "N" + Number(p.price).toLocaleString() : '<span class="price-missing">No price set</span>') + '</div>' +
                  (missing.length
                    ? '<div class="product-flag">' + ICON_ALERT + 'Missing ' + missing.join(", ") + '</div>'
                    : '') +
                '</div>' +
                '<div class="product-actions">' +
                  '<button class="pact" data-cat-action="edit" data-key="' + escapeHtml(k) + '">' + ICON_PENCIL + 'Edit</button>' +
                  '<button class="pact danger" data-cat-action="delete" data-key="' + escapeHtml(k) + '" aria-label="Remove ' + escapeHtml(p.name) + '">' + ICON_TRASH + '</button>' +
                '</div>' +
              '</div>';
            }).join("");
          }

          // Broken or missing photos get a calm placeholder rather than the
          // browser's broken-image glyph. A listener, not an inline onerror --
          // nesting quotes inside an attribute inside a JS string inside a
          // template literal is exactly how the last escaping bug got in.
          grid.querySelectorAll(".product-thumb img").forEach((img) => {
            const flag = () => { const t = img.closest(".product-thumb"); if (t) t.classList.add("no-photo"); };
            if (!img.getAttribute("src")) flag();
            else if (img.complete && img.naturalWidth === 0) flag();
            img.addEventListener("error", flag);
          });

          const summary = document.getElementById("catalogSummary");
          if (summary) {
            if (keys.length === 0) {
              summary.innerHTML = "";
            } else {
              const totalValue = keys.reduce((sum, k) => sum + (Number(products[k].price) || 0), 0);
              const needing = keys.filter((k) => incompleteCount(k) > 0).length;
              summary.innerHTML =
                '<span>' + keys.length + ' product' + (keys.length === 1 ? "" : "s") + '</span>' +
                '<span>' + (visible.length === keys.length ? "all shown" : visible.length + " shown") + '</span>' +
                '<span>N' + totalValue.toLocaleString() + ' listed value</span>' +
                (needing
                  ? '<span class="sum-warn">' + needing + ' need' + (needing === 1 ? "s" : "") + ' attention</span>'
                  : '<span class="sum-ok">all complete</span>');
            }
          }
        }

        function renderCatalog(products, deliveryStates, deliveryDefaultFee, bankDetails, bankDetails2) {
          window.catalogCache = products;
          renderCategoryFilter(products);
          renderProductGrid();
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
              flash(msg, data.error || "Could not save the second account.", "bad");
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
          }
        }

        async function removeBankDetails2() {
          if (!confirm("Remove the second bank account? Amara will only offer the first one going forward.")) return;
          const msg = document.getElementById("bank2Msg");
          try {
            const res = await fetch("/api/catalog/bank-details-2?" + ADMIN_QS, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok || data.error) {
              flash(msg, data.error || "Could not remove the second account.", "bad");
              return;
            }
            document.getElementById("bank2Name").value = "";
            document.getElementById("bank2AccountNumber").value = "";
            document.getElementById("bank2AccountName").value = "";
            document.getElementById("bank2Form").style.display = "none";
            document.getElementById("bank2Toggle").style.display = "block";
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
          clearPhotoPick();
          const catEl2 = document.getElementById("pCategory");
          if (catEl2) catEl2.value = p.category || "";
          document.getElementById("productEditingName").textContent = p.name;
          document.getElementById("productEditingNote").style.display = "block";
          const title = document.getElementById("productPanelTitle");
          if (title) title.textContent = "Edit product";
          openProductForm(); // editing has to reveal the panel, not just fill it
          document.getElementById("pName").scrollIntoView({ behavior: "smooth", block: "center" });
        }

        function cancelEditProduct() {
          document.getElementById("pKey").value = "";
          document.getElementById("pName").value = "";
          document.getElementById("pPrice").value = "";
          document.getElementById("pDescription").value = "";
          document.getElementById("pImageUrl").value = "";
          const catEl = document.getElementById("pCategory");
          if (catEl) catEl.value = "";
          clearPhotoPick();
          document.getElementById("productEditingNote").style.display = "none";
          const title = document.getElementById("productPanelTitle");
          if (title) title.textContent = "New product";
        }

        // ---- Product photo picker -------------------------------------
        // Shows the seller the actual image before they save it. The file
        // still goes up through the same multipart POST as before -- this is
        // presentation over the existing upload, not a new pathway.
        const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
        function handlePhotoPick(files) {
          const file = files && files[0];
          const msg = document.getElementById("catalogMsg");
          if (!file) return clearPhotoPick();
          if (!/^image\\//.test(file.type)) {
            if (msg) { flash(msg, "That file isn't an image.", "bad"); }
            return clearPhotoPick();
          }
          if (file.size > MAX_PHOTO_BYTES) {
            if (msg) { flash(msg, "That photo is over 1.5MB. Try a smaller one.", "bad"); }
            return clearPhotoPick();
          }
          if (msg) { msg.textContent = ""; msg.className = "catalog-msg"; }
          const reader = new FileReader();
          reader.onload = (e) => {
            document.getElementById("dropPreviewImg").src = e.target.result;
            document.getElementById("dropFileName").textContent = file.name;
            document.getElementById("dropEmpty").style.display = "none";
            document.getElementById("dropPreview").style.display = "block";
          };
          reader.readAsDataURL(file);
        }
        function clearPhotoPick() {
          const input = document.getElementById("pPhotoFile");
          if (input) input.value = "";
          const empty = document.getElementById("dropEmpty");
          const prev = document.getElementById("dropPreview");
          if (empty) empty.style.display = "";
          if (prev) prev.style.display = "none";
        }
        function initDropzone() {
          const dz = document.getElementById("photoDrop");
          if (!dz || dz.dataset.wired) return;
          dz.dataset.wired = "1";
          ["dragenter", "dragover"].forEach((ev) =>
            dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragging"); }));
          ["dragleave", "drop"].forEach((ev) =>
            dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragging"); }));
          dz.addEventListener("drop", (e) => {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) {
              document.getElementById("pPhotoFile").files = files;
              handlePhotoPick(files);
            }
          });
        }

        // ---- Categories -----------------------------------------------
        // Not a fixed taxonomy: whatever the seller types becomes a category,
        // and the filter is built from the ones actually in use.
        let currentCategory = "all";
        function setCategory(cat) {
          currentCategory = cat;
          // Only the grid and the chips need redrawing. Re-running the whole of
          // renderCatalog also refilled the delivery and bank inputs from the
          // cache, which would quietly discard anything half-typed in them.
          renderCategoryFilter(window.catalogCache || {});
          renderProductGrid();
        }
        function renderCategoryFilter(products) {
          const wrap = document.getElementById("categoryFilter");
          if (!wrap) return;
          const cats = [];
          Object.values(products).forEach((p) => {
            const c = (p.category || "").trim();
            if (c && cats.indexOf(c) === -1) cats.push(c);
          });
          cats.sort((a, b) => a.localeCompare(b));
          // Fill the datalist so adding a product suggests categories the
          // seller already uses, instead of them retyping (and mistyping) one.
          const dl = document.getElementById("categorySuggestions");
          if (dl) dl.innerHTML = cats.map((c) => '<option value="' + escapeHtml(c) + '"></option>').join("");
          if (cats.length === 0) { wrap.innerHTML = ""; return; }
          if (currentCategory !== "all" && cats.indexOf(currentCategory) === -1) currentCategory = "all";
          const chip = (val, label, n) =>
            '<button class="cat-chip' + (currentCategory === val ? " cat-chip-active" : "") + '" onclick="setCategory(\\'' + String(val).replace(/'/g, "\\\\'") + '\\')">' +
              escapeHtml(label) + '<span class="cat-chip-count">' + n + '</span></button>';
          wrap.innerHTML =
            chip("all", "All", Object.keys(products).length) +
            cats.map((c) => chip(c, c, Object.values(products).filter((p) => (p.category || "") === c).length)).join("");
        }

        // The add/edit form is revealed on demand rather than sitting open
        // under the table -- it was the single biggest block of empty space
        // on this page when there was nothing to add.
        function openProductForm() {
          const panel = document.getElementById("productPanel");
          if (!panel) return;
          panel.style.display = "block";
          initDropzone();
          const name = document.getElementById("pName");
          if (name) name.focus();
        }
        function closeProductForm() {
          const panel = document.getElementById("productPanel");
          if (panel) panel.style.display = "none";
          cancelEditProduct();
          const msg = document.getElementById("catalogMsg");
          if (msg) { msg.textContent = ""; msg.className = "catalog-msg"; }
        }

        // Sellers never type or think about an internal "key" -- it's just
        // a plain-text slug of the name, generated here, with a numeric
        // suffix added only if that slug is already taken by a different
        // product. Editing an existing product always keeps reusing ITS
        // key (set into the hidden pKey field by editProduct above), so
        // renaming a product never breaks a photo, order, or reference
        // that was already saved under its original key.
        function slugFromName(name, existingKeys, keepKey) {
          let base = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          if (!base) base = "item";
          if (!existingKeys.includes(base) || base === keepKey) return base;
          let n = 2;
          while (existingKeys.includes(base + "-" + n) && base + "-" + n !== keepKey) n++;
          return base + "-" + n;
        }

        async function saveProduct() {
          const msg = document.getElementById("catalogMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";

          const nameValue = document.getElementById("pName").value.trim();
          if (!nameValue) {
            flash(msg, "Product name is required.", "bad");
            return;
          }

          // Editing an existing product (pKey was set by editProduct) keeps
          // its exact key no matter what the name is changed to. A brand
          // new product (pKey still blank) gets a key generated from the
          // name right here, so the seller never has to think about "the
          // key" as its own separate, easy-to-get-wrong field at all.
          const editingKey = document.getElementById("pKey").value.trim().toLowerCase();
          if (!editingKey) {
            const existingKeys = Object.keys(window.catalogCache || {});
            document.getElementById("pKey").value = slugFromName(nameValue, existingKeys, "");
          }

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
          formData.append("category", (document.getElementById("pCategory") || {}).value || "");
          if (photoFile) formData.append("photo", photoFile);
          try {
            const res = await fetch("/api/catalog/product?" + ADMIN_QS, {
              method: "POST",
              body: formData,
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              flash(msg, data.error || "Could not save product.", "bad");
              return;
            }
            // The confirmation goes to the status beside "Add product",
            // which lives OUTSIDE the panel -- otherwise closing the panel
            // would hide the very message confirming the save worked.
            cancelEditProduct(); // clears every field, the category and the photo preview
            closeProductForm();  // a saved product belongs in the grid, not behind an open form
            const status = document.getElementById("catalogStatus");
            if (status) {
              status.textContent = data.warning || "Product saved.";
              status.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
              setTimeout(() => { if (status.textContent === "Product saved.") status.textContent = ""; }, 4000);
            }
            loadCatalog();
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
              flash(msg, data.warning, "bad");
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
            : '<tr><td colspan="3" style="color:var(--muted-2);">No states added yet -- Amara won\\'t quote delivery to any state until you add at least one, or set a fallback fee below.</td></tr>';
        }

        async function addDeliveryState() {
          const msg = document.getElementById("stateMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const slug = document.getElementById("stateSelect").value;
          const fee = document.getElementById("stateFee").value;
          if (!slug) {
            flash(msg, "Pick a state first.", "bad");
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
              flash(msg, data.error || "Could not add that state.", "bad");
              return;
            }
            document.getElementById("stateFee").value = "";
            msg.textContent = data.warning || "Added.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadCatalog();
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
              flash(msg, data.error || "Could not save the fallback fee.", "bad");
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
              flash(msg, data.error || "Could not save bank details.", "bad");
              return;
            }
            msg.textContent = data.warning || "Saved.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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

        const DELIVERY_MODE_LABELS = {
          online: "Online only",
          in_person: "In-person only",
          either: "Either",
        };

        // Same reasoning as the bookings list: a service is a name, a price, a
        // duration and how it is delivered -- four facts that read better laid
        // out than lined up in a six-column table a phone can't show.
        function renderOfferings(offerings) {
          const host = document.getElementById("offeringsList");
          if (!host) return;
          const keys = Object.keys(offerings);
          if (keys.length === 0) {
            host.innerHTML = '<div class="home-empty"><div class="home-empty-icon">' + ICON_BOX + '</div>' +
              'No services yet. Add one and Amara can start quoting and booking it straight away.</div>';
            return;
          }
          host.innerHTML = keys.map((k) => {
            const o = offerings[k];
            const mode = DELIVERY_MODE_LABELS[o.deliveryMode];
            const hrs = Math.floor((o.durationMinutes || 0) / 60);
            const mins = (o.durationMinutes || 0) % 60;
            const dur = (hrs ? hrs + "h" : "") + (hrs && mins ? " " : "") + (mins ? mins + "m" : (hrs ? "" : "--"));
            const incomplete = !mode || !Number(o.price) || !Number(o.durationMinutes);
            return '<div class="svc-card' + (incomplete ? " needs-work" : "") + '">' +
              '<div class="svc-main">' +
                '<div class="svc-name">' + escapeHtml(o.name) + '</div>' +
                '<div class="svc-meta">' +
                  (Number(o.price)
                    ? '<span class="svc-price">N' + Number(o.price).toLocaleString() + '</span>'
                    : '<span class="svc-price warn">No price set</span>') +
                  '<span>' + escapeHtml(dur) + '</span>' +
                  (mode
                    ? '<span class="svc-mode">' + escapeHtml(mode) + '</span>'
                    : '<span class="svc-mode warn">Delivery not set</span>') +
                '</div>' +
                '<div class="svc-key">' + escapeHtml(k) + '</div>' +
              '</div>' +
              '<div class="svc-actions">' +
                '<button class="pact" data-svc-action="edit" data-key="' + escapeHtml(k) + '">' + ICON_PENCIL + 'Edit</button>' +
                '<button class="pact danger" data-svc-action="remove" data-key="' + escapeHtml(k) + '" aria-label="Remove ' + escapeHtml(o.name) + '">' + ICON_TRASH + '</button>' +
              '</div>' +
            '</div>';
          }).join("");
        }

        document.addEventListener("click", (e) => {
          const el = e.target.closest && e.target.closest("[data-svc-action]");
          if (!el) return;
          const key = el.getAttribute("data-key");
          if (el.getAttribute("data-svc-action") === "edit") editOffering(key);
          else removeOffering(key);
        });

        // The form used to sit open under the list with all six fields and the
        // save button visible at once, and "Save service" wedged between Price
        // and Duration. It is a panel now, opened deliberately, with the fields
        // in the order a person actually thinks about them: what it is, then
        // what it costs, then how it is delivered.
        function openOfferingForm() {
          const panel = document.getElementById("offeringPanel");
          if (!panel) return;
          panel.style.display = "block";
          const t = document.getElementById("offeringPanelTitle");
          if (t && !document.getElementById("oKey").value) t.textContent = "New service";
          syncDeliveryChoices();
          const name = document.getElementById("oName");
          if (name) name.focus();
          panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        function closeOfferingForm() {
          const panel = document.getElementById("offeringPanel");
          if (panel) panel.style.display = "none";
          cancelEditOffering();
          const msg = document.getElementById("offeringsMsg");
          if (msg) { msg.textContent = ""; msg.className = "catalog-msg"; }
        }

        // The delivery mode is one of four choices, so it is four buttons
        // rather than a dropdown you have to open to find out what is in it.
        // The <select> stays in the DOM as the single source of truth, which
        // means saveOffering() and every validation path are untouched.
        function setDeliveryChoice(value) {
          const sel = document.getElementById("oDeliveryMode");
          if (sel) sel.value = value;
          syncDeliveryChoices();
        }
        function syncDeliveryChoices() {
          const sel = document.getElementById("oDeliveryMode");
          const current = sel ? sel.value : "";
          document.querySelectorAll("#oDeliveryChoices .choice").forEach((b) => {
            b.classList.toggle("on", b.getAttribute("data-delivery") === current);
          });
        }
        document.addEventListener("click", (e) => {
          const b = e.target.closest && e.target.closest("#oDeliveryChoices .choice");
          if (b) setDeliveryChoice(b.getAttribute("data-delivery"));
        });

        function editOffering(key) {
          const o = (window.offeringsCache || {})[key];
          if (!o) return;
          document.getElementById("oKey").value = key;
          document.getElementById("oName").value = o.name;
          document.getElementById("oPrice").value = o.price;
          document.getElementById("oDuration").value = o.durationMinutes;
          document.getElementById("oDeliveryMode").value = o.deliveryMode || "";
          document.getElementById("oDescription").value = o.description || "";
          document.getElementById("offeringEditingName").textContent = o.name;
          document.getElementById("offeringEditingNote").style.display = "block";
          const t = document.getElementById("offeringPanelTitle");
          if (t) t.textContent = "Edit service";
          openOfferingForm();
        }

        function cancelEditOffering() {
          document.getElementById("oKey").value = "";
          document.getElementById("oName").value = "";
          document.getElementById("oPrice").value = "";
          document.getElementById("oDuration").value = "";
          document.getElementById("oDeliveryMode").value = "";
          document.getElementById("oDescription").value = "";
          document.getElementById("offeringEditingNote").style.display = "none";
          const t = document.getElementById("offeringPanelTitle");
          if (t) t.textContent = "New service";
          syncDeliveryChoices();
        }

        async function saveOffering() {
          const msg = document.getElementById("offeringsMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";

          const nameValue = document.getElementById("oName").value.trim();
          if (!nameValue) {
            flash(msg, "Service name is required.", "bad");
            return;
          }

          // Same idea as products: no manual "key" field for a seller to
          // fill in and possibly get crossed with the name. A new service
          // gets a key generated from its name right here; editing an
          // existing one (oKey set by editOffering above) always keeps
          // reusing ITS original key, so renaming never breaks a booking
          // or an in-progress WhatsApp conversation referencing it.
          const editingKey = document.getElementById("oKey").value.trim().toLowerCase();
          if (!editingKey) {
            const existingKeys = Object.keys(window.offeringsCache || {});
            document.getElementById("oKey").value = slugFromName(nameValue, existingKeys, "");
          }

          const body = {
            key: document.getElementById("oKey").value,
            name: document.getElementById("oName").value,
            price: document.getElementById("oPrice").value,
            durationMinutes: document.getElementById("oDuration").value,
            deliveryMode: document.getElementById("oDeliveryMode").value,
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
              flash(msg, data.error || "Could not save service.", "bad");
              return;
            }
            const savedName = body.name;
            cancelEditOffering();
            if (data.warning) {
              flash(msg, data.warning, "bad");
            } else {
              closeOfferingForm();
              toast("Service saved", { sub: savedName });
            }
            loadBookable();
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
            : '<tr><td colspan="3" style="color:var(--muted-2);">No weekly availability set yet.</td></tr>';
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
              flash(msg, data.error || "Could not add that window.", "bad");
              return;
            }
            msg.textContent = data.warning || "Added.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadBookable();
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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
            : '<tr><td colspan="2" style="color:var(--muted-2);">No blocked dates.</td></tr>';
        }

        async function addBlockedDate() {
          const msg = document.getElementById("blockedDatesMsg");
          msg.textContent = "";
          msg.className = "catalog-msg";
          const date = document.getElementById("blockDate").value;
          if (!date) {
            flash(msg, "Pick a date first.", "bad");
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
              flash(msg, data.error || "Could not block that date.", "bad");
              return;
            }
            document.getElementById("blockDate").value = "";
            msg.textContent = data.warning || "Blocked.";
            msg.className = data.warning ? "catalog-msg error" : "catalog-msg ok";
            loadBookable();
          } catch (err) {
            flash(msg, "Network error, please try again.", "bad");
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

        function formatBookingDateHeader(dateStr) {
          const d = new Date(dateStr + "T00:00:00");
          if (isNaN(d.getTime())) return dateStr;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const diffDays = Math.round((d - today) / 86400000);
          const label = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
          if (diffDays === 0) return "Today \u00b7 " + label;
          if (diffDays === 1) return "Tomorrow \u00b7 " + label;
          return label;
        }

        // A six-column table on a phone is unreadable, and these rows carry a
        // date, a time, a service, a person and a reference -- five things that
        // want to be laid out, not lined up. Cards grouped by day instead, with
        // the actions as real controls.
        function renderBookings(bookings) {
          const heading = document.getElementById("bookingsHeading");
          if (heading) heading.textContent = "Upcoming bookings (" + bookings.length + ")";
          const host = document.getElementById("bookingsList");
          if (!host) return;
          const offerings = window.offeringsCache || {};
          if (bookings.length === 0) {
            host.innerHTML = '<div class="home-empty"><div class="home-empty-icon">' + ICON_CAL + '</div>' +
              'No upcoming bookings. When Amara books someone in, they appear here.</div>';
            return;
          }
          let html = "";
          let lastDate = null;
          for (const b of bookings) {
            if (b.date !== lastDate) {
              html += '<div class="bk-daygroup">' + escapeHtml(formatBookingDateHeader(b.date)) + '</div>';
              lastDate = b.date;
            }
            const offering = offerings[b.offeringKey];
            const serviceName = offering ? offering.name : b.offeringKey;
            const mins = offering && offering.durationMinutes ? offering.durationMinutes : null;
            const who = b.customerName ? b.customerName : formatPhoneDisplay(b.phone);
            html +=
              '<div class="bk-card" id="booking-row-' + escapeHtml(b.id) + '">' +
                '<div class="bk-time"><b>' + escapeHtml(b.time) + '</b>' +
                  (mins ? '<span>' + mins + ' min</span>' : '') + '</div>' +
                '<div class="bk-main">' +
                  '<div class="bk-service">' + escapeHtml(serviceName) + '</div>' +
                  '<div class="bk-who">' + escapeHtml(who) +
                    (b.customerName ? ' <span class="bk-phone">' + escapeHtml(formatPhoneDisplay(b.phone)) + '</span>' : '') +
                  '</div>' +
                  '<div class="bk-ref">Ref ' + escapeHtml(b.reference || "--") + '</div>' +
                '</div>' +
                '<div class="bk-actions">' +
                  '<button class="pact" data-bk-action="reschedule" data-id="' + escapeHtml(b.id) + '" data-offering="' + escapeHtml(b.offeringKey) + '">Reschedule</button>' +
                  '<button class="pact danger" data-bk-action="cancel" data-id="' + escapeHtml(b.id) + '">Cancel</button>' +
                '</div>' +
              '</div>';
          }
          host.innerHTML = html;
        }

        document.addEventListener("click", (e) => {
          const el = e.target.closest && e.target.closest("[data-bk-action]");
          if (el) {
            const id = el.getAttribute("data-id");
            if (el.getAttribute("data-bk-action") === "cancel") cancelBooking(id);
            else toggleReschedule(id, el.getAttribute("data-offering"));
            return;
          }
          const el2 = e.target.closest && e.target.closest("[data-bk-action2]");
          if (el2) loadRescheduleSlots(el2.getAttribute("data-id"), el2.getAttribute("data-offering"));
        });

        async function cancelBooking(id) {
          if (!confirm("Cancel this booking? The slot will open back up for other customers.")) return;
          try {
            await fetch("/api/bookable/bookings/" + encodeURIComponent(id) + "/cancel?" + ADMIN_QS, { method: "POST" });
            loadBookable();
          } catch (err) {
            console.error("cancel booking failed", err);
          }
        }

        // Reschedule is deliberately pick-from-real-times, not a free time
        // input -- same "the code is the guarantee, never trust a typed
        // value" principle as everywhere else bookings are handled. Opens
        // an inline row right under the booking being moved rather than a
        // separate page/modal, so it's obvious which booking it belongs to.
        function toggleReschedule(id, offeringKey) {
          const already = document.getElementById("reschedule-" + id);
          document.querySelectorAll('[id^="reschedule-"]').forEach((el) => el.remove());
          if (already) return; // it was open, clicking again just closes it

          const row = document.getElementById("booking-row-" + id);
          if (!row) return;
          const tr = document.createElement("div");
          tr.id = "reschedule-" + id;
          tr.className = "bk-reschedule";
          tr.innerHTML =
            '<div class="bk-resched-row">' +
              '<div class="profile-field" style="flex:1;min-width:150px;"><label>New date</label><input type="date" id="rDate-' + id + '"></div>' +
              '<button class="catalog-btn" data-bk-action2="slots" data-id="' + id + '" data-offering="' + offeringKey + '">Check open times</button>' +
            '</div>' +
            '<div id="rSlots-' + id + '" class="bk-slots"></div>';
          row.parentNode.insertBefore(tr, row.nextSibling);
        }

        async function loadRescheduleSlots(id, offeringKey) {
          const date = document.getElementById("rDate-" + id).value;
          const slotsEl = document.getElementById("rSlots-" + id);
          if (!date) {
            slotsEl.textContent = "Pick a date first.";
            return;
          }
          slotsEl.textContent = "Checking...";
          try {
            const res = await fetch(
              "/api/bookable/availability?" + ADMIN_QS + "&offeringKey=" + encodeURIComponent(offeringKey) + "&date=" + encodeURIComponent(date)
            );
            const data = await res.json();
            const slots = data.slots || [];
            slotsEl.innerHTML = slots.length > 0
              ? "Open times: " + slots.map((t) =>
                  '<button class="catalog-btn small" style="margin:2px;" onclick="confirmReschedule(\\'' + id + '\\', \\'' + date + '\\', \\'' + t + '\\')">' + t + '</button>'
                ).join("")
              : '<span style="color:var(--muted-2);">Nothing open that day. Try another date.</span>';
          } catch (err) {
            slotsEl.textContent = "Network error, please try again.";
          }
        }

        async function confirmReschedule(id, date, time) {
          if (!confirm("Move this booking to " + date + " at " + time + "?")) return;
          try {
            const res = await fetch("/api/bookable/bookings/" + encodeURIComponent(id) + "/reschedule?" + ADMIN_QS, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ date: date, time: time }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
              alert(data.error || "Could not move this booking.");
              return;
            }
            loadBookable();
          } catch (err) {
            alert("Network error, please try again.");
          }
        }

        const topbarDateEl = document.getElementById("topbarDate");
        if (topbarDateEl) topbarDateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

        document.body.setAttribute("data-tab", "home"); // the tab the page opens on
        initDetailPane();
        applyAccent(currentAccent());
        applyDensity(currentDensity());
        syncSettingsControls();
        loadDashboard();
        loadHome();
        applyRefreshRate(currentRefreshRate()); // owner-controlled poll, default 5s
      </script>
    </body>
    </html>
  `;
}

// Lets a seller install the dashboard to their phone's home screen, where it
// opens without any browser chrome -- on iOS that's the only route to a real
// full-screen app, since Safari on iPhone has no Fullscreen API.
app.get("/manifest.webmanifest", (req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name: "Stafly.AI Dashboard",
    short_name: "Stafly.AI",
    description: "Watch and take over the conversations Amara is having with your customers.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0d1117",
    theme_color: "#0d1117",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  });
});

// The brand mark as a standalone icon, drawn rather than shipped as a binary
// so there's no build step or asset pipeline for one file.
app.get("/icon.svg", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      '<rect width="512" height="512" rx="112" fill="#4f46e5"/>' +
      '<text x="50%" y="52%" dominant-baseline="central" text-anchor="middle" ' +
      'font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="300" font-weight="700" fill="#ffffff">S</text>' +
    '</svg>'
  );
});

app.get("/dashboard", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) {
    return res.status(403).send("Not authorized. Add ?key=YOUR_ADMIN_KEY to the URL, or log in as a seller.");
  }
  res.send(dashboardHtml(req.query.key || "", req.query.sellerId || "", seller.businessName, seller.businessType, {
    phoneNumberId: seller.phoneNumberId,
    whatsappToken: seller.whatsappToken,
    ownerPhoneNumber: seller.ownerPhoneNumber,
  }));
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

// Wipes everything tied to ONE customer thread -- chat memory, the
// paused/notified flags, photo-already-sent tracking, and the customer
// record itself -- so a repeat test conversation can start completely
// fresh without needing a different phone number each time. Deliberately
// does NOT touch the seller-level suspend switch (see
// /api/admin/suspend-seller, an account-wide kill switch, a different
// concept entirely) and does NOT touch any bookings this customer made
// (cancel those individually from the Bookings tab if that's what's
// actually meant). This is a testing convenience, not an account action,
// so any logged-in seller (or the admin key) can do it for their own
// customers, same as everything else on this dashboard.
app.post("/api/conversation/clear", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = String(req.body?.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "phone is required." });
  try {
    // Cancel any message still sitting in the debounce buffer for this
    // customer first, so a stray reply can't land after the clear using
    // now-deleted history.
    const key = bufferKey(seller.sellerId, phone);
    const buffer = pendingBuffers.get(key);
    if (buffer?.timer) clearTimeout(buffer.timer);
    pendingBuffers.delete(key);

    await Promise.all([
      redisCommand(["DEL", nsKey(seller.sellerId, `conv:${phone}`)]),
      redisCommand(["DEL", nsKey(seller.sellerId, `paused:${phone}`)]),
      redisCommand(["DEL", nsKey(seller.sellerId, `paused_notified:${phone}`)]),
      redisCommand(["DEL", nsKey(seller.sellerId, `photos_sent:${phone}`)]),
      redisCommand(["DEL", nsKey(seller.sellerId, `customer:${phone}`)]),
      redisCommand(["SREM", nsKey(seller.sellerId, "all_customers"), phone]),
    ]);
    console.log(`Conversation and customer record cleared for ${phone} on ${seller.sellerId} (dashboard reset).`);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/conversation/clear failed:", err.message);
    res.status(500).json({ error: "Failed to clear conversation." });
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
      history.push({ role: "assistant", content: followUp, at: Date.now() });
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
    const summary = await getAnalyticsSummary(seller.sellerId, customers, seller.catalog, req.query.days);
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
    history.push({ role: "assistant", content: text, at: Date.now(), by: "owner" });
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

// Star/pin a conversation -- a real, owner-only flag (same customer hash as
// note/paused), so the "Starred" filter tab in the dashboard is genuine
// data, not decoration. Never read by Amara's prompt, never shown to the
// customer.
app.post("/api/star", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const phone = req.body?.phone;
  const starred = req.body?.starred ? "yes" : "no";
  if (!phone) return res.status(400).json({ error: "missing phone" });
  try {
    await upsertCustomer(seller.sellerId, phone, { starred });
    res.json({ ok: true, starred });
  } catch (err) {
    console.error("api/star failed:", err.message);
    res.status(500).json({ error: "failed to save" });
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
  const selfHosted = `${BASE_URL}/catalog-photo/${seller.sellerId}/`;
  for (const key of Object.keys(seller.catalog.PRODUCT_PRICES)) {
    const imageUrl = seller.catalog.PRODUCT_IMAGES[key];
    products[key] = {
      name: seller.catalog.PRODUCT_NAMES[key],
      price: seller.catalog.PRODUCT_PRICES[key],
      imageUrl,
      // Whether this is a photo the seller actually provided, rather than the
      // placeholder path a product gets by default. The dashboard needs the
      // difference to say honestly which products still have no picture.
      hasOwnPhoto: !!imageUrl && !String(imageUrl).startsWith(`${BASE_URL}/images/`),
      description: seller.catalog.PRODUCT_DESCRIPTIONS[key] || "",
      category: (seller.catalog.PRODUCT_CATEGORIES && seller.catalog.PRODUCT_CATEGORIES[key]) || "",
    };
  }
  // Units sold per product, so the grid can sort by what is actually moving.
  const sales = {};
  try {
    const soldKeys = (await redisCommand(["SMEMBERS", nsKey(seller.sellerId, "analytics:products_sold")])) || [];
    await Promise.all(soldKeys.map(async (k) => {
      const n = await redisCommand(["GET", nsKey(seller.sellerId, `analytics:product:${k}:sold`)]);
      if (Number(n)) sales[k] = Number(n);
    }));
  } catch (err) {
    console.error("api/catalog: sales lookup failed:", err.message);
  }
  res.json({
    products,
    sales,
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

// ---------- SELLER PROFILE (Home tab) ----------
// The shop's own identity: what it's called, how it describes itself, and
// its two pictures. Everything here is the seller's own text -- nothing is
// generated, guessed or filled in on their behalf.

const PROFILE_LIMITS = { businessName: 60, tagline: 90, about: 400, location: 60 };

function publicProfile(seller) {
  return {
    businessName: seller.businessName || "",
    tagline: seller.tagline || "",
    about: seller.about || "",
    location: seller.location || "",
    avatarUrl: seller.avatarVersion ? `/brand-photo/${seller.sellerId}/avatar?v=${seller.avatarVersion}` : "",
    coverUrl: seller.coverVersion ? `/brand-photo/${seller.sellerId}/cover?v=${seller.coverVersion}` : "",
    businessType: seller.businessType || "goods",
    createdAt: seller.createdAt || "",
    setupDismissed: seller.setupDismissed === true || seller.setupDismissed === "1",
  };
}

app.get("/api/profile", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  res.json(publicProfile(seller));
});

app.post("/api/profile", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const body = req.body || {};
  const fields = {};

  // Business name is the one field that can't be emptied -- it's what the
  // customer sees Amara speaking for, and it's already on every page.
  if (body.businessName !== undefined) {
    const name = String(body.businessName).trim().slice(0, PROFILE_LIMITS.businessName);
    if (!name) return res.status(400).json({ error: "Business name can't be empty." });
    fields.businessName = name;
  }
  for (const key of ["tagline", "about", "location"]) {
    if (body[key] !== undefined) fields[key] = String(body[key]).trim().slice(0, PROFILE_LIMITS[key]);
  }
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: "Nothing to update." });

  try {
    await updateSellerRecord(seller.sellerId, fields);
  } catch (err) {
    console.error("profile save failed:", err.message);
    return res.status(500).json({ error: "Could not save. Please try again." });
  }
  // The seller context is cached, and it carries businessName -- without
  // this the sidebar and topbar would keep showing the old name until the
  // process restarted.
  invalidateSellerContextCache(seller.sellerId);
  const fresh = await getSellerContext(seller.sellerId);
  res.json({ ok: true, profile: publicProfile(fresh || { ...seller, ...fields }) });
});

// Dismissing the setup card is a real preference, stored on the seller
// rather than in one browser's localStorage -- otherwise it would come
// back every time they signed in on a different phone.
app.post("/api/profile/setup-dismissed", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  // Takes a value rather than being one-way. Dismissing a checklist is the
  // kind of thing that gets tapped by accident, and a setting you can only
  // ever turn off once is a trap, not a preference.
  const dismissed = req.body && req.body.dismissed === false ? "0" : "1";
  try {
    await updateSellerRecord(seller.sellerId, { setupDismissed: dismissed });
    invalidateSellerContextCache(seller.sellerId);
  } catch (err) {
    console.error("setup dismiss failed:", err.message);
    return res.status(500).json({ error: "Could not save that." });
  }
  res.json({ ok: true, dismissed: dismissed === "1" });
});

app.post("/api/profile/photo", (req, res, next) => {
  uploadBrand.single("photo")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? "That image is too large. Profile pictures can be up to 1.5MB and covers up to 2.5MB."
        : "Could not process that image.";
      return res.status(400).json({ error: message });
    }
    next();
  });
}, async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const kind = req.body?.kind === "cover" ? "cover" : "avatar";
  if (!req.file) return res.status(400).json({ error: "No image was uploaded." });
  // multer's limit is the larger of the two, so the avatar ceiling is
  // enforced here rather than silently accepting a 2.5MB profile picture.
  if (req.file.size > BRAND_PHOTO_LIMITS[kind]) {
    return res.status(400).json({
      error: kind === "avatar"
        ? "Profile pictures can be up to 1.5MB. Please use a smaller image."
        : "Covers can be up to 2.5MB. Please use a smaller image.",
    });
  }

  const mime = req.file.mimetype;
  const version = Date.now();
  brandPhotoCache[`${seller.sellerId}:${kind}`] = { mime, buffer: req.file.buffer };
  try {
    await redisCommand([
      "SET", nsKey(seller.sellerId, `brand:photo:${kind}`),
      JSON.stringify({ mime, data: req.file.buffer.toString("base64") }),
    ]);
    await updateSellerRecord(seller.sellerId, { [kind + "Version"]: String(version) });
    invalidateSellerContextCache(seller.sellerId);
  } catch (err) {
    console.error("brand photo save failed:", err.message);
    // It is being served from the in-memory cache already, but saying it
    // saved when it didn't would mean losing it silently on the next deploy.
    return res.status(500).json({ error: "The image uploaded but could not be saved. Please try again." });
  }
  res.json({ ok: true, kind, url: `/brand-photo/${seller.sellerId}/${kind}?v=${version}` });
});

app.delete("/api/profile/photo", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const kind = req.query.kind === "cover" ? "cover" : "avatar";
  try {
    await redisCommand(["DEL", nsKey(seller.sellerId, `brand:photo:${kind}`)]);
    await redisCommand(["HDEL", `seller:${seller.sellerId}`, kind + "Version"]);
    invalidateSellerContextCache(seller.sellerId);
  } catch (err) {
    console.error("brand photo delete failed:", err.message);
    return res.status(500).json({ error: "Could not remove that image." });
  }
  delete brandPhotoCache[`${seller.sellerId}:${kind}`];
  res.json({ ok: true, kind });
});

// Everything the Home tab shows, in one request. Every number below is
// counted from stored records -- there is nothing projected, estimated or
// benchmarked here, and a section with nothing to report says so rather
// than inventing filler.
app.get("/api/home", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  try {
    const customers = await listAllCustomers(seller.sellerId);
    const stats = await getDashboardStats(customers);

    // "Waiting on you" is a real, checkable condition: the last message in
    // the thread came from the customer, so nobody has answered it yet.
    // Paused threads come first -- those are ones the seller explicitly
    // took over, so the customer is waiting on a person, not on Amara.
    const waiting = customers
      .filter((c) => c.last_message_role === "user")
      .sort((a, b) => {
        const ap = a.paused === "yes" ? 0 : 1;
        const bp = b.paused === "yes" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return new Date(b.last_contact || 0) - new Date(a.last_contact || 0);
      })
      .slice(0, 5)
      .map((c) => ({
        phone: c.phone,
        wa_name: c.wa_name || "",
        preview: c.last_message_preview || "",
        last_contact: c.last_contact || "",
        paused: c.paused === "yes",
      }));

    // Catalogue gaps, so a seller can see what would make Amara answer
    // badly before a customer runs into it.
    const catalog = seller.catalog || {};
    const keys = Object.keys(catalog.PRODUCT_NAMES || {});
    const selfHosted = `${BASE_URL}/catalog-photo/${seller.sellerId}/`;
    const missingPhoto = keys.filter((k) => {
      const url = (catalog.PRODUCT_IMAGES || {})[k];
      // The default placeholder path is what a product gets when nobody has
      // uploaded anything, so it counts as missing rather than as a photo.
      return !url || (!url.startsWith(selfHosted) && url.startsWith(`${BASE_URL}/images/`));
    });
    const missingPrice = keys.filter((k) => !Number((catalog.PRODUCT_PRICES || {})[k]));
    const missingCategory = keys.filter((k) => !((catalog.PRODUCT_CATEGORIES || {})[k] || "").trim());

    // ---- Last 7 days ----
    // New customers per day is counted from each customer's own first_contact,
    // so it is a real count of first-time conversations, not a stored metric
    // that could drift. Revenue and orders come from the same daily keys the
    // Analytics tab reads. Nothing here is projected or smoothed.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const newByDay = Object.fromEntries(days.map((d) => [d, 0]));
    for (const c of customers) {
      const day = (c.first_contact || "").slice(0, 10);
      if (day in newByDay) newByDay[day] += 1;
    }
    const dailyRevenue = await Promise.all(
      days.map((d) => redisCommand(["GET", nsKey(seller.sellerId, `analytics:day:${d}:revenue`)]).catch(() => null))
    );
    const dailyOrders = await Promise.all(
      days.map((d) => redisCommand(["GET", nsKey(seller.sellerId, `analytics:day:${d}:orders`)]).catch(() => null))
    );
    const week = days.map((d, i) => ({
      date: d,
      newCustomers: newByDay[d],
      revenue: Number(dailyRevenue[i]) || 0,
      orders: Number(dailyOrders[i]) || 0,
    }));

    // The products the seller most needs to see: best sellers where there are
    // sales, otherwise simply the most recently priced items so the card is
    // never empty for a shop that hasn't sold yet.
    const soldKeys = (await redisCommand(["SMEMBERS", nsKey(seller.sellerId, "analytics:products_sold")]).catch(() => [])) || [];
    const soldCounts = {};
    await Promise.all(
      soldKeys.map(async (k) => {
        const n = await redisCommand(["GET", nsKey(seller.sellerId, `analytics:product:${k}:sold`)]).catch(() => null);
        soldCounts[k] = Number(n) || 0;
      })
    );
    const topProducts = keys
      .map((k) => ({
        key: k,
        name: (catalog.PRODUCT_NAMES || {})[k] || k,
        price: Number((catalog.PRODUCT_PRICES || {})[k]) || 0,
        image: (catalog.PRODUCT_IMAGES || {})[k] || "",
        hasOwnPhoto: String((catalog.PRODUCT_IMAGES || {})[k] || "").startsWith(selfHosted),
        sold: soldCounts[k] || 0,
      }))
      .sort((a, b) => b.sold - a.sold)
      .slice(0, 4);

    res.json({
      profile: publicProfile(seller),
      stats,
      week,
      newThisWeek: week.reduce((sum, d) => sum + d.newCustomers, 0),
      waiting,
      waitingTotal: customers.filter((c) => c.last_message_role === "user").length,
      catalogue: {
        total: keys.length,
        missingPhoto: missingPhoto.length,
        missingPrice: missingPrice.length,
        missingCategory: missingCategory.length,
        topProducts,
      },
      connection: {
        // Amara genuinely cannot send or receive without both of these, so
        // this is a fact about the account, not a reassuring badge.
        connected: !!(seller.phoneNumberId && seller.whatsappToken),
        alertsTo: seller.ownerPhoneNumber || "",
        suspended: !!seller.suspended,
      },
    });
  } catch (err) {
    console.error("api/home failed:", err.message);
    res.status(500).json({ error: "Could not load your dashboard." });
  }
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
  const { key, name, price, imageUrl, description, category } = req.body || {};

  // Same "code is the guarantee" rule as everywhere else money-adjacent
  // in this file: validate for real here, don't just trust whatever the
  // dashboard's own JS happened to send.
  const cleanKey = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanName = String(name || "").trim();
  const cleanPrice = Number(price);
  const cleanImageUrl = imageUrl ? String(imageUrl).trim() : "";
  const cleanDescription = String(description || "").trim().slice(0, 600);
  const cleanCategory = String(category || "").trim().slice(0, 60);

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
  if (!seller.catalog.PRODUCT_CATEGORIES) seller.catalog.PRODUCT_CATEGORIES = {};
  seller.catalog.PRODUCT_CATEGORIES[cleanKey] = cleanCategory;

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
  if (seller.catalog.PRODUCT_CATEGORIES) delete seller.catalog.PRODUCT_CATEGORIES[key];
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
  const { key, name, price, durationMinutes, description, deliveryMode } = req.body || {};

  const cleanKey = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanName = String(name || "").trim();
  const cleanPrice = Number(price);
  const cleanDuration = Number(durationMinutes);
  const cleanDescription = String(description || "").trim().slice(0, 600);
  // Whether this specific service is online, in-person, or either -- kept
  // as its own real field (like price and duration) rather than something
  // a seller has to remember to mention in the free-text description,
  // because "is this online?" turned out to be a genuinely common customer
  // question that Amara had no reliable way to answer without escalating
  // to the owner every single time. Blank means "not set yet", the only
  // case Amara should still ask the owner about.
  const ALLOWED_DELIVERY_MODES = ["", "online", "in_person", "either"];
  const cleanDeliveryMode = ALLOWED_DELIVERY_MODES.includes(deliveryMode) ? deliveryMode : "";

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

  seller.catalog.OFFERINGS[cleanKey] = {
    name: cleanName,
    price: cleanPrice,
    durationMinutes: cleanDuration,
    description: cleanDescription,
    deliveryMode: cleanDeliveryMode,
  };
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

// Moves an existing booking to a different date/time instead of forcing a
// cancel + a brand new booking (which used to be the only option, and
// loses the original reference number and creation date in the process).
// Re-checks the new slot against real availability first, exactly like a
// fresh booking would, so this can never double-book a slot -- the
// booking being moved is temporarily set aside during that check so it
// doesn't collide with its OWN old slot when the new time happens to be
// close to it.
app.post("/api/bookable/bookings/:id/reschedule", async (req, res) => {
  const seller = await resolveActingSeller(req);
  if (!seller) return res.status(403).json({ error: "unauthorized" });
  const id = String(req.params.id || "");
  const newDate = String(req.body?.date || "");
  const newTime = String(req.body?.time || "");
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || !timeRe.test(newTime)) {
    return res.status(400).json({ error: "A valid date and time are required." });
  }

  const booking = seller.catalog.BOOKINGS.find((b) => b.id === id && b.status !== "cancelled");
  if (!booking) return res.status(404).json({ error: "Booking not found." });

  const originalDate = booking.date;
  const originalTime = booking.time;
  booking.date = "0000-01-01"; // parked out of the way so it can't collide with its own old slot below
  booking.time = "00:00";
  const openSlots = getAvailableSlots(seller, booking.offeringKey, newDate);
  if (!openSlots.includes(newTime)) {
    booking.date = originalDate; // put it back, nothing actually changed
    booking.time = originalTime;
    return res.status(409).json({ error: "That time isn't actually open anymore. Pick one of the currently available times." });
  }

  booking.date = newDate;
  booking.time = newTime;
  console.log(`Bookable: booking ${id} rescheduled from ${originalDate} ${originalTime} to ${newDate} ${newTime} for ${seller.sellerId}.`);

  try {
    await saveBookingsToRedis(seller.sellerId);
    res.json({ ok: true });
  } catch (err) {
    console.error("api/bookable/bookings reschedule: live update succeeded but Redis persistence failed:", err.message);
    res.json({ ok: true, warning: "Moved and live now, but couldn't persist to storage -- it may revert if the server restarts before you try again." });
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
    history.push({ role: "assistant", content: confirmationText, at: Date.now() });
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
// Which build is actually live. Render deploys on a push, so "I changed
// that" and "that change is running" are two different facts, and there was
// no way to tell them apart from the outside -- a missing customer name
// looks identical whether the code is wrong or simply not deployed yet.
// The hash is taken from this file's own bytes at boot, so it can't drift
// out of date the way a hand-maintained version string does.
const BUILD_ROUND = "Round 28";
let BUILD_HASH = "unknown";
try {
  BUILD_HASH = crypto.createHash("sha256").update(require("fs").readFileSync(__filename)).digest("hex").slice(0, 12);
} catch (err) {
  console.error("Could not hash own source for build id:", err.message);
}
const BOOTED_AT = new Date().toISOString();

app.get("/", (req, res) => {
  res.send(`Stafly.AI engine is running ✓ (${BUILD_ROUND}, build ${BUILD_HASH})`);
});

app.get("/version", (req, res) => {
  res.json({
    round: BUILD_ROUND,
    build: BUILD_HASH,
    bootedAt: BOOTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
  });
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
