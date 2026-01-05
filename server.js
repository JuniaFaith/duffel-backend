// server.js
// Duffel backend (Render) — /health, /airlines, /quote, /hold

import express from "express";

const app = express();
app.use(express.json());

// ====== Config ======
const PORT = process.env.PORT || 3000;
const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;

// Duffel API base
const DUFFEL_BASE_URL = "https://api.duffel.com";

// Duffel API version header (this is the one that was causing "unsupported version" before)
const DUFFEL_VERSION = "v2";

// A small list of "nearby / common onward" destinations to test against.
// You can edit this list later.
const DEFAULT_DESTINATIONS = [
  "PNH", // Phnom Penh
  "KUL", // Kuala Lumpur
  "SIN", // Singapore
  "SGN", // Ho Chi Minh City
  "HAN", // Hanoi
  "DPS", // Bali
  "HKT", // Phuket
  "CNX"  // Chiang Mai
];

// ====== Helpers ======
function requireDuffelKey(res) {
  if (!DUFFEL_API_KEY) {
    res.status(500).json({
      ok: false,
      error: "Missing DUFFEL_API_KEY in environment variables (Render → Environment)."
    });
    return false;
  }
  return true;
}

async function duffelFetch(path, options = {}) {
  const url = `${DUFFEL_BASE_URL}${path}`;
  const headers = {
    "Authorization": `Bearer ${DUFFEL_API_KEY}`,
    "Duffel-Version": DUFFEL_VERSION,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });

  // Try to parse JSON always (Duffel responds JSON on errors too)
  const data = await response.json().catch(() => null);

  return { response, data };
}

function splitName(fullName = "") {
  const trimmed = String(fullName).trim();
  if (!trimmed) return { given_name: "Test", family_name: "User" };

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0], family_name: "User" };

  return {
    given_name: parts.slice(0, -1).join(" "),
    family_name: parts.slice(-1).join("")
  };
}

function pickCheapestOffer(offers = []) {
  // Duffel offers typically have total_amount + total_currency
  // total_amount is a string number like "97.32"
  if (!Array.isArray(offers) || offers.length === 0) return null;

  let cheapest = null;

  for (const offer of offers) {
    const amt = Number(offer?.total_amount);
    if (!Number.isFinite(amt)) continue;
    if (!cheapest) {
      cheapest = offer;
      continue;
    }
    const cheapestAmt = Number(cheapest?.total_amount);
    if (amt < cheapestAmt) cheapest = offer;
  }

  return cheapest;
}

async function getOfferById(offer_id) {
  const { response, data } = await duffelFetch(`/air/offers/${offer_id}`, {
    method: "GET"
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data
    };
  }

  return {
    ok: true,
    offer: data?.data
  };
}

// ====== Routes ======
app.get("/", (req, res) => {
  res.json({ ok: true, service: "duffel-backend" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Simple passthrough test: list airlines
app.get("/airlines", async (req, res) => {
  try {
    if (!requireDuffelKey(res)) return;

    const limit = req.query.limit || 5;
    const { response, data } = await duffelFetch(`/air/airlines?limit=${limit}`, {
      method: "GET"
    });

    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /quote
 * Finds the cheapest valid onward flight from an origin to a "best" destination
 * using a small destination shortlist.
 *
 * Body:
 * {
 *   "name": "Test User",
 *   "origin": "BKK",
 *   "date": "2026-02-02"
 * }
 */
app.post("/quote", async (req, res) => {
  try {
    if (!requireDuffelKey(res)) return;

    const { name, origin, date, destinations } = req.body || {};

    if (!name || !origin || !date) {
      return res.status(400).json({
        ok: false,
        error: "Missing name, origin, or date"
      });
    }

    const destinationList = Array.isArray(destinations) && destinations.length > 0
      ? destinations
      : DEFAULT_DESTINATIONS;

    // Create offers for each destination and choose the cheapest
    const offersFound = [];

    for (const destination of destinationList) {
      // Skip if destination equals origin
      if (String(destination).toUpperCase() === String(origin).toUpperCase()) continue;

      // 1) Create offer request
      const offerRequestPayload = {
        data: {
          slices: [
            {
              origin: String(origin).toUpperCase(),
              destination: String(destination).toUpperCase(),
              departure_date: String(date)
            }
          ],
          passengers: [{ type: "adult" }],
          cabin_class: "economy"
        }
      };

      const { response: orResp, data: orData } = await duffelFetch("/air/offer_requests", {
        method: "POST",
        body: JSON.stringify(offerRequestPayload)
      });

      if (!orResp.ok) {
        // just skip this destination
        continue;
      }

      // 2) Get offers
      // Duffel sometimes returns offers inside "offers" or requires a follow-up list call.
      let offers = [];

      // Common patterns:
      // - orData.data.offers (some SDKs/versions)
      // - orData.included contains offers
      if (Array.isArray(orData?.data?.offers)) {
        offers = orData.data.offers;
      } else if (Array.isArray(orData?.included)) {
        offers = orData.included.filter((x) => x?.type === "offer");
      }

      // If none returned, do a list call using the offer_request id
      if (offers.length === 0 && orData?.data?.id) {
        const offerRequestId = orData.data.id;

        const { response: listResp, data: listData } = await duffelFetch(
          `/air/offers?offer_request_id=${offerRequestId}&limit=50`,
          { method: "GET" }
        );

        if (listResp.ok && Array.isArray(listData?.data)) {
          offers = listData.data;
        }
      }

      const cheapest = pickCheapestOffer(offers);
      if (cheapest) {
        offersFound.push({
          destination: String(destination).toUpperCase(),
          offer: cheapest
        });
      }
    }

    if (offersFound.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No offers found for the provided origin/date."
      });
    }

    // Pick cheapest across destinations
    let best = offersFound[0];
    for (const item of offersFound) {
      const amt = Number(item.offer?.total_amount);
      const bestAmt = Number(best.offer?.total_amount);
      if (Number.isFinite(amt) && Number.isFinite(bestAmt) && amt < bestAmt) {
        best = item;
      }
    }

    const { given_name, family_name } = splitName(name);

    return res.json({
      ok: true,
      quote: {
        name,
        origin: String(origin).toUpperCase(),
        destination: best.destination,
        date: String(date),
        offer_id: best.offer.id,
        total_amount: best.offer.total_amount,
        total_currency: best.offer.total_currency,
        passenger_name_parsed: { given_name, family_name }
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /hold  (Path 2: hold-first flow)
 *
 * Body:
 * {
 *   "offer_id": "off_xxx",
 *   "name": "Test User"
 * }
 *
 * Creates a Duffel Order with payment_required=false (a hold).
 * Returns order_id, pnr (booking reference), and expiry if provided by Duffel.
 */
app.post("/hold", async (req, res) => {
  try {
    if (!requireDuffelKey(res)) return;

    const { offer_id, name, born_on, title } = req.body || {};

    if (!offer_id || !name) {
      return res.status(400).json({
        ok: false,
        error: "Missing offer_id or name"
      });
    }

    // Fetch offer to get passenger IDs (Duffel requires passenger objects on order creation)
    const offerResult = await getOfferById(offer_id);
    if (!offerResult.ok) {
      return res.status(offerResult.status || 400).json({
        ok: false,
        error: "Failed to fetch offer details",
        details: offerResult.data
      });
    }

    const offer = offerResult.offer;

    const { given_name, family_name } = splitName(name);

    // Duffel typically requires passenger details on Order creation.
    // We'll map offer passengers and provide minimal safe defaults.
    const passengers = (offer?.passengers || []).map((p) => ({
      id: p.id,
      title: title || "mr",
      given_name,
      family_name,
      // born_on is often required by airlines; use provided or a placeholder.
      born_on: born_on || "1990-01-01"
    }));

    const orderPayload = {
      data: {
        selected_offers: [offer_id],
        payment_required: false,
        passengers
      }
    };

    const { response, data } = await duffelFetch("/air/orders", {
      method: "POST",
      body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "Duffel order (hold) failed",
        details: data
      });
    }

    const order = data?.data;

    return res.json({
      ok: true,
      hold: {
        order_id: order?.id || null,
        pnr: order?.booking_reference || null,
        // Duffel may provide one of these fields depending on provider/airline
        expires_at: order?.expires_at || order?.payment_due_at || null,
        total_amount: order?.total_amount || offer?.total_amount || null,
        total_currency: order?.total_currency || offer?.total_currency || null
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== Start server ======
app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on port ${PORT}`);
});
