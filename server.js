const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// NimbusPost API configuration
const NIMBUS_EMAIL = process.env.NIMBUS_EMAIL;
const NIMBUS_PASSWORD = process.env.NIMBUS_PASSWORD;
const NIMBUS_BASE_URL = process.env.NIMBUS_BASE_URL || 'https://api.nimbuspost.com/v1';

// Token cache
let authToken = null;
let tokenExpiry = null;

// ✅ Middleware - Allow CORS for ALL ORIGINS
app.use(cors({
  origin: '*', // ✅ Allow requests from any domain
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // No cookies/session sharing
}));
app.use(express.json());

// Validate credentials
if (!NIMBUS_EMAIL || !NIMBUS_PASSWORD) {
  console.error('Error: NIMBUS_EMAIL or NIMBUS_PASSWORD is not defined in .env file');
  process.exit(1);
}

// Function to get or refresh auth token
const getAuthToken = async () => {
  if (authToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('Using cached token:', authToken.substring(0, 20) + '...');
    return authToken;
  }

  try {
    console.log('Requesting new token from NimbusPost');
    const loginResponse = await axios.post(`${NIMBUS_BASE_URL}/users/login`, {
      email: NIMBUS_EMAIL,
      password: NIMBUS_PASSWORD,
    }, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('Login response:', JSON.stringify(loginResponse.data, null, 2));

    if (!loginResponse.data || !loginResponse.data.status || !loginResponse.data.data) {
      throw new Error(`Login failed: ${JSON.stringify(loginResponse.data || {})}`);
    }

    authToken = loginResponse.data.data;
    tokenExpiry = Date.now() + 60 * 60 * 1000; // 1-hour expiry
    console.log('New token acquired:', authToken.substring(0, 20) + '...');
    return authToken;
  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    throw new Error('Failed to authenticate with NimbusPost');
  }
};

// Track endpoint
app.get('/api/track/:awb', async (req, res) => {
  const { awb } = req.params;

  if (!awb || awb.length < 5) {
    console.error(`Invalid AWB number: ${awb}`);
    return res.status(400).json({ success: false, message: 'Invalid AWB number (too short)' });
  }

  try {
    const token = await getAuthToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const requestUrl = `${NIMBUS_BASE_URL}/shipments/track/${awb}`;
    console.log(`Sending request to: ${requestUrl}`);
    console.log('Request headers:', { 'Authorization': 'Bearer ...' + token.slice(-4) });

    const trackResponse = await axios.get(requestUrl, { headers });

    console.log('Track response:', JSON.stringify(trackResponse.data, null, 2));

    if (trackResponse.data.status && trackResponse.data.data) {
      const orderId = trackResponse.data.data.order_id;
      let orderData = {};
      try {
        const orderResponse = await axios.get(`${NIMBUS_BASE_URL}/orders/${orderId}`, {
          headers,
        });
        console.log('Order response:', JSON.stringify(orderResponse.data, null, 2));
        if (orderResponse.data.status && orderResponse.data.data) {
          orderData = orderResponse.data.data;
        }
      } catch (orderError) {
        console.error('Order details error:', orderError.response?.data || orderError.message);
      }

      const fullData = {
        ...trackResponse.data.data,
        customer_name: orderData.customer_name || 'N/A',
        customer_address: orderData.customer_address || 'N/A',
        product_name: orderData.product_name || 'N/A',
        product_details: orderData.product_details || [],
      };

      res.json({ success: true, data: fullData });
    } else {
      console.error('No tracking data in response:', trackResponse.data);
      res.status(404).json({ success: false, message: 'No tracking data found for this AWB number' });
    }
  } catch (error) {
    console.error('Tracking API Error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      awb,
      headers_sent: { 'Authorization': 'Bearer ...' + (authToken ? authToken.slice(-4) : 'null') },
    });

    if (error.response) {
      const { status, data } = error.response;
      if (status === 400 && data.message?.includes('Missing required request parameters: [Authorization]')) {
        authToken = null;
        res.status(400).json({ success: false, message: 'Authorization header missing or invalid. Please check credentials.' });
      } else if (status === 400) {
        res.status(400).json({ success: false, message: data.message || 'Bad request: Invalid AWB or parameters' });
      } else if (status === 401) {
        authToken = null;
        try {
          const newToken = await getAuthToken();
          const headers = {
            'Authorization': `Bearer ${newToken}`,
            'Content-Type': 'application/json',
          };
          const retryResponse = await axios.get(requestUrl, { headers });
          console.log('Retry response:', JSON.stringify(retryResponse.data, null, 2));
          if (retryResponse.data.status && retryResponse.data.data) {
            return res.json({ success: true, data: retryResponse.data.data });
          } else {
            console.error('No tracking data in retry response:', retryResponse.data);
            return res.status(404).json({ success: false, message: 'No tracking data found for this AWB number' });
          }
        } catch (retryError) {
          console.error('Retry failed:', retryError.message);
          res.status(401).json({ success: false, message: 'Authentication failed. Invalid token or credentials.' });
        }
      } else if (status === 403) {
        res.status(403).json({ success: false, message: 'Access forbidden. Invalid token or AWB number.' });
      } else if (status === 404) {
        res.status(404).json({ success: false, message: 'AWB number not found.' });
      } else {
        res.status(status || 500).json({
          success: false,
          message: data.message || 'Failed to fetch tracking information',
        });
      }
    } else {
      res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Backend is running' });
});

// Start server
app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/api/health`);
});
