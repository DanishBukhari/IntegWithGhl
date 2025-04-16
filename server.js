const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Configuration
const SERVICE_M8_CLIENT_ID = '114073';
const SERVICE_M8_CLIENT_SECRET = '8de499e43092434dbd1122a46d07ca8b';
const GHL_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6InBscTVQM1lrbzFOOURESzUwMVUyIiwidmVyc2lvbiI6MSwiaWF0IjoxNzIyNDE0NTkyNTI5LCJzdWIiOiIzRml4Mmt2UVVtUURrUTlhclEzSiJ9.w_6KY5758i_sTtWBNyygkgKRIFBGcbpAfKlFSD7-57w';
const GHL_WEBHOOK_URL = 'YOUR_GHL_WEBHOOK_URL'; // Replace after creating Workflow 2
let SERVICE_M8_ACCESS_TOKEN = null;

// Add-on Activation
app.get('/activate-addon', (req, res) => {
  const redirectUri = encodeURIComponent('https://integwithghl-0125ea6b2dc5.herokuapp.com/oauth/callback');
  const scope = encodeURIComponent('read_staff read_jobs create_jobs manage_jobs read_customers manage_customers read_invoices');
  const redirectUrl = `https://go.servicem8.com/api_oauth/authorize?client_id=${SERVICE_M8_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(redirectUrl);
});

// OAuth Callback
app.get('/oauth/callback', async (req, res) => {
  console.log('OAuth callback query:', req.query);
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const response = await axios.post('https://api.servicem8.com/api_oauth/token', null, {
      params: {
        code,
        client_id: SERVICE_M8_CLIENT_ID,
        client_secret: SERVICE_M8_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: 'https://integwithghl-0125ea6b2dc5.herokuapp.com/oauth/callback',
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    SERVICE_M8_ACCESS_TOKEN = response.data.access_token;
    console.log('ServiceM8 OAuth token:', SERVICE_M8_ACCESS_TOKEN);
    res.send('OAuth successful! Integration active.');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth failed');
  }
});

// GHL to ServiceM8: Create Job
app.post('/ghl-create-job', async (req, res) => {
  const { contactId, firstName, lastName, email, phone, jobDescription } = req.body;

  if (!SERVICE_M8_ACCESS_TOKEN) return res.status(401).send('ServiceM8 not authenticated');

  try {
    // Check for existing client
    let clientUuid = null;
    const clientResponse = await axios.get('https://api.servicem8.com/api_1.0/client.json', {
      headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}` },
      params: { '$filter': `email eq '${email}'` },
    });

    if (clientResponse.data.length > 0) {
      clientUuid = clientResponse.data[0].uuid;
      console.log('Found client:', clientUuid);
    } else {
      const newClient = await axios.post(
        'https://api.servicem8.com/api_1.0/client.json',
        { first_name: firstName, last_name: lastName, email, mobile: phone, active: 1 },
        { headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      clientUuid = newClient.data.uuid;
      console.log('Created client:', clientUuid);
    }

    // Create job
    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      { company_uuid: clientUuid, job_description: jobDescription || 'Job from GHL', status: 'Quote', active: 1 },
      { headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('Created job:', jobResponse.data.uuid);
    res.status(200).json({ jobUuid: jobResponse.data.uuid });
  } catch (error) {
    console.error('Error creating job:', error.response?.data || error.message);
    res.status(500).send('Failed to create job');
  }
});

// ServiceM8 Webhook: Job Updated
app.post('/servicem8-job-updated', async (req, res) => {
  const { uuid, status } = req.body;
  console.log('Job Updated:', uuid, status);

  if (status === 'Completed') {
    try {
      await checkInvoiceStatus(uuid);
    } catch (error) {
      console.error('Error processing job updated:', error.response?.data || error.message);
    }
  }
  res.sendStatus(200);
});

// Check Invoice Status for Paid Jobs
async function checkInvoiceStatus(jobUuid) {
  try {
    // Get invoices for the job
    const invoiceResponse = await axios.get('https://api.servicem8.com/api_1.0/invoice.json', {
      headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}` },
      params: { '$filter': `job_uuid eq '${jobUuid}'` },
    });

    const invoices = invoiceResponse.data;
    for (const invoice of invoices) {
      if (invoice.status === 'Paid') {
        console.log('Found paid invoice for job:', jobUuid);
        // Get client email to find GHL contact
        const jobResponse = await axios.get(`https://api.servicem8.com/api_1.0/job/${jobUuid}.json`, {
          headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}` },
        });
        const clientUuid = jobResponse.data.company_uuid;
        const clientResponse = await axios.get(`https://api.servicem8.com/api_1.0/client/${clientUuid}.json`, {
          headers: { Authorization: `Bearer ${SERVICE_M8_ACCESS_TOKEN}` },
        });
        const email = clientResponse.data.email;

        // Find GHL contact
        const ghlContactResponse = await axios.get('https://rest.gohighlevel.com/v1/contacts/', {
          headers: { Authorization: `Bearer ${GHL_API_KEY}` },
          params: { query: email },
        });

        const contact = ghlContactResponse.data.contacts[0];
        if (contact) {
          await triggerGHLReviewRequest(contact.id);
        } else {
          console.log('No GHL contact found for email:', email);
        }
      }
    }
  } catch (error) {
    console.error('Error checking invoice status:', error.response?.data || error.message);
  }
}

// Trigger GHL Review Request
async function triggerGHLReviewRequest(contactId) {
  try {
    const response = await axios.post(
      GHL_WEBHOOK_URL,
      { contactId },
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log('Triggered GHL Webhook:', response.data);
  } catch (error) {
    console.error('Error triggering GHL webhook:', error.response?.data || error.message);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});