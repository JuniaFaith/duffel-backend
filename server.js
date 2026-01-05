// server.js (CommonJS) — paste this whole file

const express = require("express");
const cors = require("cors");

// Duffel SDK
const { Duffel } = require("@duffel/api");

const app = express();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DUFFEL_ACCESS_TOKEN = process.env.DUFFEL_ACCESS_TOKEN;

// Create Duffel client (only if token exists)
const duffel = DUFFEL_ACCESS_TOKEN
  ? new Duffel({ token: DUFFEL_ACCESS_TOKEN })
  : null;

// Helper: consistent error response with Duffel details
function sendDuffelError(res, err, fallbackMessage = "Request failed") {
  const duffelData = err?.response?.data;
  console.error("=== ERROR ===");
  console.error(duffelData || err);

  return res.status(500).json({
    ok: false,
    error: fallbackMessage,
    duffel: duffelData || err?.message || String(err),
  });
}

// Helper: basic required-field check
function requireFields(body, fields) {
  const missing = fields.filter((f) => !body?.[f]);
  return missing.length ? missing : null;
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Duffel backend is running" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    has_duffel_token: Boolean(DUFFEL_ACCESS_TOKEN),
    timestamp: new Date().toISOString(),
  });
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
 *
 * Returns cheapest offer (amount/currency + offer_id)
 */
app.post("/quote", async (req, res) => {
  try {
    if (!duffel) {
      return res.status(500).json({
        ok: false,
        error: "DUFFEL_ACCESS_TOKEN is missing on the server",
      });
    }

    const missing = requireFields(req.body, ["name", "origin", "destination", "date"]);
    if (missing) {
      return res.status(400).json({
        ok: false,
        error: `Missing: ${missing.join(", ")}`,
      });
    }

    const { name, origin, destination, date, cabin_class } = req.body;

    // Duffel requires passengers array + slices array
    const offerRequest = await duffel.offerRequests.create({
      slices: [
        {
          origin,
          destination,
          departure_date: date,
        },
      ],
      passengers: [
        {
          type: "adult",
          // name isn't required for quote, but we keep it for your flow consistency
        },
      ],
      cabin_class: cabin_class || "economy",
    });

    const offers = offerRequest.data?.offers || [];

    if (!offers.length) {
      return res.status(500).json({
        ok: false,
        error: "No offers returned from Duffel",
        duffel: offerRequest.data || null,
      });
    }

    // Pick cheapest by total_amount (string -> float)
    const cheapest = offers
      .slice()
      .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0];

    return res.json({
      ok: true,
      quote: {
        name,
        origin,
        destination,
        date,
        offer_id: cheapest.id,
        total_amount: cheapest.total_amount,
        total_currency: cheapest.total_currency,
      },
    });
  } catch (err) {
    return sendDuffelError(res, err, "Quote failed");
  }
});

/**
 * POST /hold
 * Body:
 * {
 *   "offer_id": "off_.....",
 *   "given_name": "Test",
 *   "family_name": "User",
 *   "email": "test@example.com"
 * }
 *
 * Creates a HOLD order (no payment).
 */
app.post("/hold", async (req, res) => {
  try {
    if (!duffel) {
      return res.status(500).json({
        ok: false,
        error: "DUFFEL_ACCESS_TOKEN is missing on the server",
      });
    }

    const missing = requireFields(req.body, ["offer_id", "given_name", "family_name", "email"]);
    if (missing) {
      return res.status(400).json({
        ok: false,
        error: `Missing: ${missing.join(", ")}`,
      });
    }

    const { offer_id, given_name, family_name, email } = req.body;

    // Create a HOLD order (Duffel supports type: "hold")
    const order = await duffel.orders.create({
      type: "hold",
      selected_offers: [offer_id],
      passengers: [
        {
          given_name,
          family_name,
          email,
        },
      ],
    });

    return res.json({
      ok: true,
      hold: {
        order_id: order.data?.id,
        status: order.data?.status,
        expires_at: order.data?.expires_at || null,
      },
      raw: order.data,
    });
  } catch (err) {
    return sendDuffelError(res, err, "Hold failed");
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
