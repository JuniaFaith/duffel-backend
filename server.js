// server.js (CommonJS) — Render + Duffel v2
// Endpoints:
//   GET  /health
//   POST /quote  -> creates an offer_request, returns offer_id + passenger_id + price
//   POST /hold   -> creates a HOLD order using offer_id + passenger details

const express = require("express");

const app = express();
app.use(express.json());

// ---- CORS (fix Hoppscotch browser "Network Error") ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Duffel-Version"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- ENV ----
const DUFFEL_API_TOKEN = process.env.DUFFEL_API_TOKEN;
const DUFFEL_BASE_URL = process.env.DUFFEL_BASE_URL || "https://api.duffel.com";
const DUFFEL_VERSION = "v2"; // IMPORTANT: Duffel docs now show v2 :contentReference[oaicite:4]{index=4}

if (!DUFFEL_API_TOKEN) {
  console.warn("⚠️ Missing DUFFEL_API_TOKEN env var");
}

// ---- Helpers ----
async function duffelFetch(path, { method = "GET", body } = {}) {
  const url = `${DUFFEL_BASE_URL}${path}`;

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Duffel-Version": DUFFEL_VERSION,
    Authorization: `Bearer ${DUFFEL_API_TOKEN}`,
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error("Duffel request failed");
    err.status = resp.status;
    err.details = json;
    throw err;
  }

  return json;
}

function missingFields(obj, fields) {
  return fields.filter((f) => !obj || obj[f] === undefined || obj[f] === null || obj[f] === "");
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/quote", async (req, res) => {
  try {
    const required = ["name", "origin", "destination", "date"];
    const missing = missingFields(req.body, required);
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Missing ${missing.join(", ")}`,
        example: {
          name: "Test User",
          origin: "BKK",
          destination: "PNH",
          date: "2026-02-02",
        },
      });
    }

    const { name, origin, destination, date } = req.body;

    // Create offer request
    const offerReq = await duffelFetch("/air/offer_requests", {
      method: "POST",
      body: {
        data: {
          cabin_class: "economy",
          slices: [
            {
              origin,
              destination,
              departure_date: date,
            },
          ],
          passengers: [{ type: "adult" }],
        },
      },
    });

    const data = offerReq.data || {};
    const offers = data.offers || [];
    const passengers = data.passengers || [];

    if (!offers.length) {
      return res.status(400).json({
        ok: false,
        error: "No offers returned from Duffel for that route/date.",
        duffel: offerReq,
      });
    }

    const offer = offers[0];
    const passenger = passengers[0];

    return res.json({
      ok: true,
      quote: {
        name,
        origin,
        destination,
        date,
        offer_id: offer.id,
        passenger_id: passenger ? passenger.id : null,
        total_amount: offer.total_amount,
        total_currency: offer.total_currency,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Quote failed",
      duffel_status: e.status,
      duffel_error: e.details,
    });
  }
});

app.post("/hold", async (req, res) => {
  try {
    // Duffel hold order needs a passenger object with required fields (docs example) :contentReference[oaicite:5]{index=5}
    const required = [
      "offer_id",
      "passenger_id",
      "given_name",
      "family_name",
      "email",
      "phone_number",
      "born_on",
      "gender",
      "title",
    ];
    const missing = missingFields(req.body, required);
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Missing ${missing.join(", ")}`,
        example: {
          offer_id: "off_xxx_from_/quote",
          passenger_id: "pas_xxx_from_/quote",
          given_name: "Test",
          family_name: "User",
          email: "test@example.com",
          phone_number: "+61400111222",
          born_on: "1987-07-24",
          gender: "f",
          title: "mrs",
        },
      });
    }

    const {
      offer_id,
      passenger_id,
      given_name,
      family_name,
      email,
      phone_number,
      born_on,
      gender,
      title,
    } = req.body;

    const order = await duffelFetch("/air/orders", {
      method: "POST",
      body: {
        data: {
          type: "hold",
          selected_offers: [offer_id],
          passengers: [
            {
              id: passenger_id,
              given_name,
              family_name,
              email,
              phone_number,
              born_on,
              gender,
              title,
              type: "adult",
            },
          ],
        },
      },
    });

    return res.json({
      ok: true,
      order: order.data,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Hold failed",
      duffel_status: e.status,
      duffel_error: e.details,
    });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
