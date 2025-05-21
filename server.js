// server.js
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const app = express();
const port = process.env.PORT || 3000;

const CLIENT_ID = '267187';
const CLIENT_SECRET = 'bf88439531934d3984b522ca2b9d0f9b';
const REDIRECT_URI = 'https://integwithservicem8-b0957504c647.herokuapp.com/oauth/callback';

// Step 1: Activation URL - start the OAuth flow
app.get('/activate-addon', (req, res) => {
  const authorizationUrl = `https://go.servicem8.com/oauth/authorize?` + qs.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'company staff job customer',
  });
  return res.redirect(authorizationUrl);
});

// Step 2: Handle OAuth callback and exchange code for access token
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const response = await axios.post('https://go.servicem8.com/oauth/access_token', qs.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const tokenData = response.data;

    // You should securely store tokenData for future use
    console.log('Access Token Response:', tokenData);

    res.send('ServiceM8 add-on installed successfully! You can close this window.');
  } catch (error) {
    console.error('Error exchanging code for token:', error.response?.data || error.message);
    res.status(500).send('OAuth flow failed.');
  }
});

// Optional: serve manifest file (you can also host it separately)
app.get('/addon.manifest.json', (req, res) => {
  res.json({
    name: "IntegWithServiceM8",
    version: "1.0.0",
    iconURL: "https://integwithservicem8-b0957504c647.herokuapp.com/icon.png", // update this
    supportEmail: "your-email@example.com",
    supportURL: "https://your-support-site.com", // update this
    activationURL: "https://integwithservicem8-b0957504c647.herokuapp.com/activate-addon",
    oauth: {
      scope: "company staff job customer"
    }
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
