// server.js (CommonJS) — REPLACE THE WHOLE FILE WITH THIS

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DUFFEL_ACCESS_TOKEN = process.env.DUFFEL_ACCESS_TOKEN;

// ---- Helpers ----
function requireEnv() {
  if (!DUFFEL_ACCESS_TOKEN) {
    throw new Error("Missing DUFFEL_ACCESS_TOKEN in Render Environment variables.");
  }
}

async function duffelFetch(path, method = "GET", body) {
  requireEnv();

  const url = `https://api.duffel.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${DUFFEL_ACCESS_TOKEN}`,
      "Duffel-Version": "beta",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Duffel API error ${res.status}`);
    err.status = res.status;
    err.data = json;
    throw err;
  }

  return json;
}

function missingFields(obj, fields) {
  return fields.filter((f) => obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === "");
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "duffel-backend" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /quote
 * Body:
 * {
 *   "name": "Test User",
 *   "origin": "BKK",
 *   "destination": "PNH",
 *   "date": "2026-02-02",
 *   "cabin_class": "economy"   // optional
 * }
 */
app.post("/quote", async (req, res) => {
  try {
    const { name, origin, destination, date } = req.body;
    const cabin_class = req.body.cabin_class || "economy";

    const missing = missingFields(req.body, ["name", "origin", "destination", "date"]);
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Missing ${missing.join(", ")}`,
      });
    }

    // Create offer request and return offers immediately
    const offerReq = await duffelFetch(
      "/air/offer_requests?return_offers=true",
      "POST",
      {
        data: {
          slices: [
            {
              origin,
              destination,
              departure_date: date,
            },
          ],
          passengers: [{ type: "adult" }],
          cabin_class,
        },
      }
    );

    const offers = offerReq?.data?.offers || [];
    if (!offers.length) {
      return res.status(502).json({
        ok: false,
        error: "No offers returned from Duffel.",
        duffel: offerReq,
      });
    }

    // Pick cheapest
    offers.sort((a, b) => Number(a.total_amount) - Number(b.total_amount));
    const cheapest = offers[0];

    // Passenger ID comes from the offer object
    const passenger_id = cheapest?.passengers?.[0]?.id;

    return res.json({
      ok: true,
      quote: {
        name,
        origin,
        destination,
        date,
        offer_id: cheapest.id,
        passenger_id,
        total_amount: cheapest.total_amount,
        total_currency: cheapest.total_currency,
      },
    });
  } catch (err) {
    console.error("QUOTE ERROR:", err?.status, err?.data || err?.message);

    return res.status(err.status || 500).json({
      ok: false,
      error: "Quote failed",
      duffel_status: err.status || null,
      duffel_error: err.data || err.message,
    });
  }
});

/**
 * POST /hold
 * This creates an order WITHOUT payment (acts like a hold).
 *
 * Body:
 * {
 *   "offer_id": "off_...",
 *   "passenger_id": "pas_...",
 *   "given_name": "Test",
 *   "family_name": "User",
 *   "email": "test@example.com",
 *   "born_on": "1990-01-01",
 *   "gender": "m",             // "m" or "f" typically
 *   "title": "mr",             // often "mr", "ms", "mrs" etc (varies)
 *   "phone_number": "+61400000000"  // optional but useful
 * }
 */
app.post("/hold", async (req, res) => {
  try {
    const {
      offer_id,
      passenger_id,
      given_name,
      family_name,
      email,
      born_on,
      gender,
      title,
      phone_number,
    } = req.body;

    // These are the common “minimum” fields Duffel usually needs to create an order.
    // If Duffel requires fewer/more, we’ll see it clearly in the returned Duffel error now.
    const required = ["offer_id", "passenger_id", "given_name", "family_name", "email", "born_on", "gender", "title"];
    const missing = missingFields(req.body, required);

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Missing ${missing.join(", ")}`,
        example_body: {
          offer_id: "off_...",
          passenger_id: "pas_...",
          given_name: "Test",
          family_name: "User",
          email: "test@example.com",
          born_on: "1990-01-01",
          gender: "m",
          title: "mr",
          phone_number: "+61400000000",
        },
      });
    }

    const order = await duffelFetch("/air/orders", "POST", {
      data: {
        selected_offers: [offer_id],
        passengers: [
          {
            id: passenger_id,
            given_name,
            family_name,
            email,
            born_on,
            gender,
            title,
            phone_number: phone_number || undefined,
          },
        ],
        // IMPORTANT: no payments field = order created without payment (hold-style)
      },
    });

    const o = order?.data;

    return res.json({
      ok: true,
      hold: {
        order_id: o?.id,
        booking_reference: o?.booking_reference || null,
        payment_required_by: o?.payment_required_by || null,
        total_amount: o?.total_amount || null,
        total_currency: o?.total_currency || null,
      },
      duffel: order,
    });
  } catch (err) {
    console.error("HOLD ERROR:", err?.status, err?.data || err?.message);

    return res.status(err.status || 500).json({
      ok: false,
      error: "Hold failed",
      duffel_status: err.status || null,
      // This is the key change: show the real Duffel error payload
      duffel_error: err.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
