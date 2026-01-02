require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Duffel backend running" });
});

// Test Duffel connection
app.get("/test-duffel", async (req, res) => {
  try {
    const response = await fetch(
      `${process.env.DUFFEL_BASE_URL}/airlines?limit=5`,
      {
       headers: {
  Authorization: `Bearer ${process.env.DUFFEL_ACCESS_TOKEN}`,
  "Duffel-Version": "v1",
},

      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Search flights (create an offer request)
app.post("/search", async (req, res) => {
  try {
    const response = await fetch(
      `${process.env.DUFFEL_BASE_URL}/offer_requests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.DUFFEL_ACCESS_TOKEN}`,
          "Duffel-Version": "v2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: req.body }),
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.post("/quote", async (req, res) => {
  try {
    const { name, origin, date } = req.body;

    if (!name || !origin || !date) {
      return res.status(400).json({ error: "Missing name, origin, or date" });
    }

    const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const destinationPool = (process.env.DESTINATION_POOL || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const maxPriceUsd = Number(process.env.MAX_PRICE_USD || 200);

    if (!allowedOrigins.includes(origin)) {
      return res.status(400).json({ error: "Origin not allowed" });
    }

    if (destinationPool.length === 0) {
      return res.status(500).json({ error: "DESTINATION_POOL not configured" });
    }

    const duffelBaseUrl = process.env.DUFFEL_BASE_URL || "https://api.duffel.com";
    const token = process.env.DUFFEL_ACCESS_TOKEN;

    if (!token) {
      return res.status(500).json({ error: "DUFFEL_ACCESS_TOKEN missing" });
    }

    const headers = {
      "Authorization": `Bearer ${token}`,
      "Duffel-Version": "beta",
      "Content-Type": "application/json"
    };

    const results = [];
const errors = [];

    for (const destination of destinationPool) {
      if (destination === origin) continue;

      const payload = {
        data: {
          slices: [
            {
              origin,
              destination,
              departure_date: date
            }
          ],
          passengers: [{ type: "adult" }],
          cabin_class: "economy"
        }
      };

    // 1. Create offer request
const reqResp = await fetch(`${duffelBaseUrl}/air/offer_requests`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload)
});

if (!reqResp.ok) {
  const body = await reqResp.text();
  errors.push({
    step: "offer_request",
    destination,
    status: reqResp.status,
    body: body.slice(0, 300)
  });
  continue;
}


const reqJson = await reqResp.json();
const offerRequestId = reqJson?.data?.id;
if (!offerRequestId) continue;

// 2. Fetch offers for that request
const offersResp = await fetch(
  `${duffelBaseUrl}/air/offers?offer_request_id=${offerRequestId}`,
  { headers }
);

if (!offersResp.ok) {
  const body = await offersResp.text();
  errors.push({
    step: "offers_fetch",
    destination,
    status: offersResp.status,
    body: body.slice(0, 300)
  });
  continue;
}


const offersJson = await offersResp.json();
const offers = offersJson?.data || [];
if (offers.length === 0) continue;
      const cheapest = offers.reduce((min, o) => {
        const price = Number(o.total_amount);
        if (!min) return o;
        return price < Number(min.total_amount) ? o : min;
      }, null);

      if (!cheapest) continue;

      if (cheapest.total_currency === "USD") {
        const price = Number(cheapest.total_amount);
        if (price > maxPriceUsd) continue;
      }

      results.push({
        destination,
        offer_id: cheapest.id,
        total_amount: cheapest.total_amount,
        total_currency: cheapest.total_currency
      });
    }

    if (results.length === 0) {
  return res.status(502).json({
    error: "No eligible offers found",
    hint: "Duffel calls were skipped or returned no offers. See errors_sample.",
    errors_sample: errors.slice(0, 5)
  });
}


    const winner = results.reduce((min, r) => {
      if (!min) return r;
      return Number(r.total_amount) < Number(min.total_amount) ? r : min;
    }, null);

    return res.status(200).json({
      ok: true,
      quote: {
        name,
        origin,
        destination: winner.destination,
        date,
        offer_id: winner.offer_id,
        total_amount: winner.total_amount,
        total_currency: winner.total_currency
      }
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on http://localhost:${PORT}`);
});
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});


