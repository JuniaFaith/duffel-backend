require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Environment
 */
const PORT = process.env.PORT || 3000;
const DUFFEL_BASE_URL = process.env.DUFFEL_BASE_URL || "https://api.duffel.com";
const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;

/**
 * Basic health checks
 */
app.get("/", (req, res) => {
  res.json({ status: "Duffel backend running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Test Duffel connection
 * Confirms API key + connectivity
 */
app.get("/test-duffel", async (req, res) => {
  try {
    if (!DUFFEL_API_KEY) {
      return res.status(500).json({ error: "DUFFEL_API_KEY missing" });
    }

    const response = await fetch(
      DUFFEL_BASE_URL + "/air/airlines?limit=5",
      {
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v1"
        }
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Quote endpoint
 * Finds cheapest eligible onward flight
 */
app.post("/quote", async (req, res) => {
  try {
    const { name, origin, date } = req.body;

    if (!name || !origin || !date) {
      return res.status(400).json({
        error: "Missing name, origin, or date"
      });
    }

    if (!DUFFEL_API_KEY) {
      return res.status(500).json({
        error: "DUFFEL_API_KEY missing"
      });
    }

    const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
      return res.status(400).json({
        error: "Origin not allowed"
      });
    }

    const destinationPool = (process.env.DESTINATION_POOL || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!destinationPool.length) {
      return res.status(500).json({
        error: "DESTINATION_POOL not configured"
      });
    }

    const maxPriceUsd = Number(process.env.MAX_PRICE_USD || 200);

    const headers = {
      Authorization: `Bearer ${DUFFEL_API_KEY}`,
      "Duffel-Version": "v1",
      "Content-Type": "application/json"
    };

    const results = [];
    const errors = [];

    for (const destination of destinationPool) {
      if (destination === origin) continue;

      try {
        // 1. Create offer request
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

        const offerReqResp = await fetch(
          DUFFEL_BASE_URL + "/air/offer_requests",
          {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          }
        );

        if (!offerReqResp.ok) {
          const body = await offerReqResp.text();
          errors.push({
            step: "offer_request",
            destination,
            status: offerReqResp.status,
            body: body.slice(0, 300)
          });
          continue;
        }

        const offerReqJson = await offerReqResp.json();
        const offerRequestId = offerReqJson?.data?.id;
        if (!offerRequestId) continue;

        // 2. Fetch offers
        const offersResp = await fetch(
          DUFFEL_BASE_URL +
            "/air/offers?offer_request_id=" +
            offerRequestId,
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
        if (!offers.length) continue;

        const cheapest = offers.reduce((min, o) => {
          if (!min) return o;
          return Number(o.total_amount) < Number(min.total_amount)
            ? o
            : min;
        }, null);

        if (!cheapest) continue;

        if (
          cheapest.total_currency === "USD" &&
          Number(cheapest.total_amount) > maxPriceUsd
        ) {
          continue;
        }

        results.push({
          destination,
          offer_id: cheapest.id,
          total_amount: cheapest.total_amount,
          total_currency: cheapest.total_currency
        });
      } catch (innerErr) {
        errors.push({
          step: "exception",
          destination,
          message: innerErr.message
        });
      }
    }

    if (!results.length) {
      return res.status(502).json({
        error: "No eligible offers found",
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
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err)
    });
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on port ${PORT}`);
});
