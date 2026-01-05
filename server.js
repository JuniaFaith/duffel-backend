/**
 * server.js — Duffel v2 backend (Render-friendly)
 *
 * Endpoints:
 *   GET  /health
 *   POST /quote  -> find cheapest offer (prefer hold-eligible)
 *   POST /hold   -> create Duffel order of type "hold" (no payment)
 *   POST /pay    -> (optional) pay for an order later using balance
 *
 * ENV required:
 *   DUFFEL_API_KEY=...
 *
 * Optional ENV:
 *   DUFFEL_BASE_URL=https://api.duffel.com
 *   DUFFEL_VERSION=v2
 *   PORT=3000 (Render sets this automatically)
 */

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE_URL = process.env.DUFFEL_BASE_URL || "https://api.duffel.com";
const DUFFEL_VERSION = process.env.DUFFEL_VERSION || "v2";

if (!DUFFEL_API_KEY) {
  console.warn("⚠️ Missing DUFFEL_API_KEY environment variable.");
}

function duffelHeaders() {
  return {
    Authorization: `Bearer ${DUFFEL_API_KEY}`,
    "Duffel-Version": DUFFEL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function duffelFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${DUFFEL_BASE_URL}${path}`, {
    method,
    headers: duffelHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.errors?.[0]?.message ||
      data?.message ||
      `Duffel error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

// --------------------
// Basics
// --------------------
app.get("/", (_req, res) => res.json({ ok: true, service: "duffel-backend" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Handy test endpoint (optional)
app.get("/air/airlines", async (_req, res) => {
  try {
    const data = await duffelFetch("/air/airlines?limit=5");
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.data });
  }
});

// --------------------
// POST /quote
// Body:
// {
//   "name": "Test User",
//   "origin": "BKK",
//   "date": "2026-02-02",
//   "destinations": ["PNH","KUL","SIN"]   // optional
// }
//
// Returns cheapest offer (prefers hold-eligible where possible) + offer_id + passenger_id
// --------------------
app.post("/quote", async (req, res) => {
  try {
    const { name, origin, date, destinations } = req.body || {};

    if (!name || !origin || !date) {
      return res.status(400).json({ error: "Missing name, origin, or date" });
    }

    // Reasonable default onward destinations (edit anytime)
    const destList =
      Array.isArray(destinations) && destinations.length > 0
        ? destinations
        : ["PNH", "KUL", "SIN", "SGN", "HAN", "CGK"];

    // 1) Create offer request
    // Duffel doc example uses offer_requests with v2 header :contentReference[oaicite:1]{index=1}
    const offerRequest = await duffelFetch("/air/offer_requests", {
      method: "POST",
      body: {
        data: {
          slices: destList.map((dest) => ({
            origin: origin.toUpperCase(),
            destination: dest.toUpperCase(),
            departure_date: date,
          })),
          passengers: [{ type: "adult" }],
          cabin_class: "economy",
        },
      },
    });

    const offerRequestId = offerRequest?.data?.id;
    const passengerId = offerRequest?.data?.passengers?.[0]?.id;

    if (!offerRequestId) {
      return res.status(500).json({ error: "No offer_request id returned" });
    }

    // 2) List offers for that request
    // (Duffel supports offers listing by offer_request_id)
    const offersResp = await duffelFetch(
      `/air/offers?offer_request_id=${encodeURIComponent(offerRequestId)}&limit=200`
    );

    const offers = offersResp?.data || [];
    if (!offers.length) {
      return res.status(404).json({ error: "No offers returned for these routes/date" });
    }

    // Prefer offers that can be held (requires_instant_payment === false)
    // Per Duffel guide :contentReference[oaicite:2]{index=2}
    const holdEligible = offers.filter(
      (o) => o?.payment_requirements?.requires_instant_payment === false
    );

    const pool = holdEligible.length ? holdEligible : offers;

    // Cheapest by total_amount (string -> number)
    const cheapest = pool.reduce((best, cur) => {
      const curAmt = Number(cur?.total_amount ?? Infinity);
      const bestAmt = Number(best?.total_amount ?? Infinity);
      return curAmt < bestAmt ? cur : best;
    }, pool[0]);

    const firstSlice = cheapest?.slices?.[0];
    const destination = firstSlice?.destination?.iata_code || firstSlice?.destination || null;

    return res.json({
      ok: true,
      quote: {
        name,
        origin: origin.toUpperCase(),
        destination,
        date,
        offer_id: cheapest?.id,
        total_amount: cheapest?.total_amount,
        total_currency: cheapest?.total_currency,
        // helpful for hold flow:
        passenger_id: passengerId,
        hold_eligible:
          cheapest?.payment_requirements?.requires_instant_payment === false,
        payment_required_by: cheapest?.payment_requirements?.payment_required_by || null,
        price_guarantee_expires_at:
          cheapest?.payment_requirements?.price_guarantee_expires_at || null,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.data });
  }
});

// --------------------
// POST /hold
// Body:
// {
//   "offer_id": "...",
//   "passenger_id": "...",          // recommended; if missing we'll try to fetch from offer
//   "given_name": "Test",           // optional
//   "family_name": "User",          // optional
//   "email": "test@example.com",    // optional
//   "phone_number": "+61400000000", // optional
//   "born_on": "1980-07-24",        // optional
//   "title": "mr",                  // optional
//   "gender": "m"                   // optional
// }
//
// Creates order with type "hold" and NO payments (Duffel guide) :contentReference[oaicite:3]{index=3}
// --------------------
app.post("/hold", async (req, res) => {
  try {
    const {
      offer_id,
      passenger_id,
      given_name,
      family_name,
      email,
      phone_number,
      born_on,
      title,
      gender,
    } = req.body || {};

    if (!offer_id) {
      return res.status(400).json({ error: "Missing offer_id" });
    }

    // If passenger_id not provided, try to fetch the offer and take first passenger id
    let passengerId = passenger_id;

    if (!passengerId) {
      try {
        const offer = await duffelFetch(`/air/offers/${encodeURIComponent(offer_id)}`);
        passengerId = offer?.data?.passengers?.[0]?.id || null;
      } catch (_e) {
        // ignore; we'll error below if still missing
      }
    }

    if (!passengerId) {
      return res.status(400).json({
        error:
          "Missing passenger_id. Use the passenger_id returned from /quote (recommended).",
      });
    }

    const orderResp = await duffelFetch("/air/orders", {
      method: "POST",
      body: {
        data: {
          type: "hold",
          selected_offers: [offer_id],
          passengers: [
            {
              id: passengerId,
              given_name: given_name || "Test",
              family_name: family_name || "User",
              email: email || "test@example.com",
              phone_number: phone_number || "+61400000000",
              born_on: born_on || "1980-07-24",
              title: title || "mr",
              gender: gender || "m",
            },
          ],
          // IMPORTANT: omit "payments" entirely for hold orders :contentReference[oaicite:4]{index=4}
        },
      },
    });

    const order = orderResp?.data;

    return res.json({
      ok: true,
      hold: {
        order_id: order?.id,
        type: order?.type,
        total_amount: order?.total_amount,
        total_currency: order?.total_currency,
        payment_status: order?.payment_status || null,
      },
      raw: orderResp,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.data });
  }
});

// --------------------
// POST /pay (optional)
// Body:
// {
//   "order_id": "...",
//   "amount": "97.32",
//   "currency": "AUD"
// }
// Uses Duffel "create payment" with type "balance" :contentReference[oaicite:5]{index=5}
// --------------------
app.post("/pay", async (req, res) => {
  try {
    const { order_id, amount, currency } = req.body || {};
    if (!order_id || !amount || !currency) {
      return res.status(400).json({ error: "Missing order_id, amount, or currency" });
    }

    const paymentResp = await duffelFetch("/air/payments", {
      method: "POST",
      body: {
        data: {
          order_id,
          payment: {
            type: "balance",
            amount,
            currency,
          },
        },
      },
    });

    res.json({ ok: true, payment: paymentResp?.data, raw: paymentResp });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.data });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on port ${PORT}`);
});
