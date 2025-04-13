const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Webhook: Job Status Updated
app.post('/servicem8-job-updated', async (req, res) => {
  const { job_uuid, invoice_status } = req.body;
  console.log('Job Status Updated:', job_uuid, invoice_status);

  if (invoice_status === 'Paid') {
    await triggerGHLReviewRequest('GHL_CONTACT_ID');
  }

  res.sendStatus(200);
});

// Webhook: Job Paid
app.post('/servicem8-job-paid', async (req, res) => {
  const { job_uuid } = req.body;
  console.log('Job Paid:', job_uuid);

  await triggerGHLReviewRequest('GHL_CONTACT_ID');
  res.sendStatus(200);
});

// Trigger GHL Workflow
async function triggerGHLReviewRequest(contactId) {
  try {
    const response = await axios.post('https://api.gohighlevel.com/v1/contacts/actions/startWorkflow', {
      contactId,
      workflowId: 'YOUR_GHL_REPUTATION_WORKFLOW_ID',
    }, {
      headers: {
        Authorization: `YOUR_GHL_API_KEY`,
        'Content-Type': 'application/json',
      },
    });
    console.log('Triggered GHL Workflow:', response.data);
  } catch (error) {
    console.error('Error triggering GHL workflow:', error);
  }
}

// Addon Activation Page
app.get('/activate-addon', (req, res) => {
  const redirectUrl = `https://go.servicem8.com/api_oauth/authorize?client_id=747959&redirect_uri=https://integwithghl-0125ea6b2dc5.herokuapp.com/oauth/callback&response_type=code&scope=staff%20job%client`;
  res.redirect(redirectUrl);
});

// OAuth Callback URL
app.get('/oauth/callback', (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
