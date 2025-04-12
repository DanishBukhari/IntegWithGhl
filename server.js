const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');

// Create an Express app
const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.json()); // to parse JSON payloads

// ServiceM8 Webhook: Job Status Updated
app.post('/servicem8-job-updated', async (req, res) => {
  const { job_uuid, invoice_status } = req.body;

  console.log('Job Status Updated:', job_uuid, invoice_status);

  if (invoice_status === 'Paid') {
    // Trigger GHL workflow to send review request
    await triggerGHLReviewRequest('GHL_CONTACT_ID');
  }

  res.sendStatus(200);
});

// ServiceM8 Webhook: Job Invoiced
app.post('/servicem8-job-paid', async (req, res) => {
  const { job_uuid } = req.body;

  console.log('Job Paid:', job_uuid);

  // Trigger review request in GHL after payment
  await triggerGHLReviewRequest('GHL_CONTACT_ID');
  res.sendStatus(200);
});

// GHL Workflow Trigger Function
async function triggerGHLReviewRequest(contactId) {
  try {
    const response = await axios.post('https://api.gohighlevel.com/v1/contacts/actions/startWorkflow', {
      contactId,
      workflowId: 'YOUR_GHL_REPUTATION_WORKFLOW_ID', // Replace with your GHL workflow ID
    }, {
      headers: {
        Authorization: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6InBscTVQM1lrbzFOOURESzUwMVUyIiwidmVyc2lvbiI6MSwiaWF0IjoxNzIyNDE0NTkyNTI5LCJzdWIiOiIzRml4Mmt2UVVtUURrUTlhclEzSiJ9.w_6KY5758i_sTtWBNyygkgKRIFBGcbpAfKlFSD7-57w`, // Replace with your GHL API key
        'Content-Type': 'application/json',
      },
    });
    console.log('Triggered GHL Workflow:', response.data);
  } catch (error) {
    console.error('Error triggering GHL workflow:', error);
  }
}

// Start Server and Set up ngrok
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Create ngrok tunnel to expose localhost
  const url = await ngrok.connect(PORT);
  console.log(`ngrok tunnel open at ${url}`);

  // Here you can now use the ngrok URL to update ServiceM8 webhook and manifest
});
// Addon Activation Page
app.get('/activate-addon', (req, res) => {
    const redirectUrl = `https://go.servicem8.com/api_oauth/authorize?client_id=747959&redirect_uri=https://7b8c-2404-3100-1887-89fe-3190-9cd6-1bf1-2488.ngrok-free.app/oauth/callback&response_type=code&scope=staff%20job%client`;
    res.redirect(redirectUrl);
  });
  
  // OAuth Callback URL (after ServiceM8 auth)
  app.get('/oauth/callback', (req, res) => {
    const { code } = req.query;
  
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
  
    // Exchange the code for an access token
    axios.post('https://api.servicem8.com/api_oauth/token', null, {
      params: {
        code,
        client_id: '747959',
        client_secret: '975ab97c9e1c49569b8722a3fe3728fb',
        grant_type: 'authorization_code',
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })
    .then(response => {
      console.log('ServiceM8 OAuth token:', response.data);
      res.send('OAuth successful! You can now use the integration.');
    })
    .catch(err => {
      console.error('OAuth error:', err.response?.data || err.message);
      res.status(500).send('OAuth failed');
    });
  });
  