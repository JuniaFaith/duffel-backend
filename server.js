require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// Environment
// =====================
const PORT = process.env.PORT || 3000;
const DUFFEL_BASE_URL = process.env.DUFFEL_BASE_URL || "https://api.duffel.com";
const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;

// =====================
// Health checks
// =====================
app.get("/", (req, res) => {
  res.json({ status: "Duffel backend running" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// =====================
// Test Duffel connection
// =====================
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
          "Duffel-Version": "v2"
        }
      }
    );

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =====================
// Quote endpoint
// =====================
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

    const destinationPool = (process.env.DESTINATION_POOL || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!destinationPool.length) {
      return res.status(500).json({
        error: "DESTINATION_POOL not configured"
      });
    }

    const headers = {
      Authorization: `Bearer ${DUFFEL_API_KEY}`,
      "Duffel-Version": "v2",
      "Content-Type": "application/json"
    };

    let cheapest = null;

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

      const offerReqResp = await fetch(
        DUFFEL_BASE_URL + "/air/offer_requests",
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        }
      );

      if (!offerReqResp.ok) continue;

      const offerReqJson = await offerReqResp.json();
      const offerRequestId = offerReqJson?.data?.id;
      if (!offerRequestId) continue;

      const offersResp = await fetch(
        DUFFEL_BASE_URL +
          "/air/offers?offer_request_id=" +
          offerRequestId,
        { headers }
      );

      if (!offersResp.ok) continue;

      const offersJson = await offersResp.json();
      const offers = offersJson?.data || [];
      if (!offers.length) continue;

      const candidate = offers.reduce((min, o) => {
        if (!min) return o;
        return Number(o.total_amount) < Number(min.total_amount)
          ? o
          : min;
      }, null);

      if (!candidate) continue;

      if (
        !cheapest ||
        Number(candidate.total_amount) <
          Number(cheapest.total_amount)
      ) {
        cheapest = {
          destination,
          offer_id: candidate.id,
          total_amount: candidate.total_amount,
          total_currency: candidate.total_currency
        };
      }
    }

    if (!cheapest) {
      return res.status(502).json({
        error: "No eligible offers found"
      });
    }

    return res.json({
      ok: true,
      quote: {
        name,
        origin,
        destination: cheapest.destination,
        date,
        offer_id: cheapest.offer_id,
        total_amount: cheapest.total_amount,
        total_currency: cheapest.total_currency
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
});

// =====================
// Start server
// =====================
app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on port ${PORT}`);
});
