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
 * Root + health checks
 */
app.get("/", (req, res) => {
  res.json({ status: "Duffel backend running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Test Duffel connection
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
          "Duffel-Version": "v2"
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
 * Finds the cheapest valid onward flight
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
