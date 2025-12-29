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
  "Duffel-Version": "v2",
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

app.listen(PORT, () => {
  console.log(`✅ Duffel backend running on http://localhost:${PORT}`);
});


