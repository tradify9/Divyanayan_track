const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// NimbusPost API Config
const NIMBUS_EMAIL = process.env.NIMBUS_EMAIL;
const NIMBUS_PASSWORD = process.env.NIMBUS_PASSWORD;
const NIMBUS_BASE_URL =
  process.env.NIMBUS_BASE_URL || "https://api.nimbuspost.com/v1";

// Token cache
let authToken = null;
let tokenExpiry = null;

// ✅ Global Middlewares
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.use(express.json());

// ✅ Validate env vars at startup
if (!NIMBUS_EMAIL || !NIMBUS_PASSWORD) {
  console.error(
    "❌ Missing NIMBUS_EMAIL or NIMBUS_PASSWORD in .env — server cannot start"
  );
  process.exit(1);
}

// 🔑 Function to get or refresh auth token
const getAuthToken = async () => {
  if (authToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log("✅ Using cached NimbusPost token");
    return authToken;
  }

  console.log("🔑 Requesting new NimbusPost token...");
  try {
    const loginResponse = await axios.post(
      `${NIMBUS_BASE_URL}/users/login`,
      {
        email: NIMBUS_EMAIL,
        password: NIMBUS_PASSWORD,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    if (!loginResponse.data?.status || !loginResponse.data?.data) {
      throw new Error(
        `NimbusPost login failed: ${JSON.stringify(loginResponse.data)}`
      );
    }

    authToken = loginResponse.data.data;
    tokenExpiry = Date.now() + 60 * 60 * 1000; // 1 hour cache
    console.log("✅ NimbusPost token acquired successfully");
    return authToken;
  } catch (error) {
    console.error("❌ NimbusPost Login Error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    throw new Error("Failed to authenticate with NimbusPost");
  }
};

// 📦 Track Endpoint
app.get("/api/track/:awb", async (req, res) => {
  const { awb } = req.params;

  if (!awb || awb.length < 5) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid AWB number (too short)" });
  }

  try {
    const token = await getAuthToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const trackUrl = `${NIMBUS_BASE_URL}/shipments/track/${awb}`;
    console.log(`📡 Requesting tracking: ${trackUrl}`);

    const trackResponse = await axios.get(trackUrl, { headers });

    if (trackResponse.data?.status && trackResponse.data?.data) {
      const orderId = trackResponse.data.data.order_id;
      let orderData = {};

      try {
        const orderResponse = await axios.get(
          `${NIMBUS_BASE_URL}/orders/${orderId}`,
          { headers }
        );
        if (orderResponse.data?.status && orderResponse.data?.data) {
          orderData = orderResponse.data.data;
        }
      } catch (orderError) {
        console.warn("⚠️ Could not fetch order details:", orderError.message);
      }

      const fullData = {
        ...trackResponse.data.data,
        customer_name: orderData.customer_name || "N/A",
        customer_address: orderData.customer_address || "N/A",
        product_name: orderData.product_name || "N/A",
        product_details: orderData.product_details || [],
      };

      return res.json({ success: true, data: fullData });
    } else {
      return res.status(404).json({
        success: false,
        message: "No tracking data found for this AWB number",
      });
    }
  } catch (error) {
    console.error("❌ Tracking API Error:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    if (error.response) {
      const { status, data } = error.response;
      if (status === 401) {
        authToken = null; // Force refresh token
        return res
          .status(401)
          .json({ success: false, message: "Authentication failed. Token reset." });
      }
      return res.status(status).json({
        success: false,
        message: data?.message || "Failed to fetch tracking information",
      });
    }

    return res
      .status(500)
      .json({ success: false, message: `Internal server error: ${error.message}` });
  }
});

// 🏥 Health Check
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Backend is running" });
});

// 🔗 Root Route for Render
app.get("/", (req, res) => {
  res.send("✅ NimbusPost Tracking API Backend is LIVE");
});

// 🚀 Start Server
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
  console.log(`🔍 Health check: http://localhost:${port}/api/health`);
});
