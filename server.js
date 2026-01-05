const express = require("express");

const app = express();
app.use(express.json());

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;

// -------------------
// Health check
// -------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// -------------------
// Quote endpoint
// -------------------
app.post("/quote", async (req, res) => {
  try {
    const { name, origin, destination, date } = req.body;

    if (!name || !origin || !destination || !date) {
      return res.status(400).json({
        error: "Missing name, origin, destination, or date",
      });
    }

    // Create passenger
    const passengerRes = await fetch(
      "https://api.duffel.com/air/passengers",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "passenger",
            given_name: name.split(" ")[0],
            family_name: name.split(" ").slice(1).join(" ") || "User",
          },
        }),
      }
    );

    const passengerData = await passengerRes.json();
    const passengerId = passengerData.data.id;

    // Create offer request
    const offerReqRes = await fetch(
      "https://api.duffel.com/air/offer_requests",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            slices: [
              {
                origin,
                destination,
                departure_date: date,
              },
            ],
            passengers: [{ id: passengerId }],
            cabin_class: "economy",
          },
        }),
      }
    );

    const offerReqData = await offerReqRes.json();
    const offer = offerReqData.data.offers[0];

    res.json({
      ok: true,
      quote: {
        name,
        origin,
        destination,
        date,
        offer_id: offer.id,
        passenger_id: passengerId,
        total_amount: offer.total_amount,
        total_currency: offer.total_currency,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Quote failed" });
  }
});

// -------------------
// Hold endpoint
// -------------------
app.post("/hold", async (req, res) => {
  try {
    const {
      offer_id,
      passenger_id,
      given_name,
      family_name,
      email,
    } = req.body;

    if (!offer_id || !passenger_id) {
      return res.status(400).json({
        error: "Missing offer_id or passenger_id",
      });
    }

    const holdRes = await fetch(
      "https://api.duffel.com/air/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUFFEL_API_KEY}`,
          "Duffel-Version": "v1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "order",
            selected_offers: [offer_id],
            passengers: [
              {
                id: passenger_id,
                given_name,
                family_name,
                email,
              },
            ],
            payment: {
              type: "balance",
            },
          },
        }),
      }
    );

    const holdData = await holdRes.json();
    res.json({ ok: true, hold: holdData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Hold failed" });
  }
});

// -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Duffel backend running on port ${PORT}`);
});
