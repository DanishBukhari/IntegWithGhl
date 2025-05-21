require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  REVIEW_BADGE_UUID,
  GHL_API_KEY,
  GHL_WEBHOOK_URL
} = process.env;

// OAuth token store
let tokenStore = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0
};

// Helper to refresh the ServiceM8 access token
async function refreshAccessToken() {
  if (!tokenStore.refreshToken) {
    throw new Error('No refresh token available');
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('refresh_token', tokenStore.refreshToken);
  try {
    const response = await axios.post('https://go.servicem8.com/oauth/access_token', params);
    const data = response.data;
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt = Date.now() + data.expires_in * 1000;
  } catch (err) {
    console.error('Failed to refresh access token:', err.response ? err.response.data : err.message);
    throw err;
  }
}

// Get a valid ServiceM8 access token, refreshing if necessary
async function getAccessToken() {
  if (!tokenStore.accessToken || Date.now() > tokenStore.expiresAt - 60000) {
    // Token missing or expired
    if (tokenStore.refreshToken) {
      await refreshAccessToken();
    } else {
      throw new Error('No access token available. Please authorize the app.');
    }
  }
  return tokenStore.accessToken;
}

// Endpoint for ServiceM8 OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
    const response = await axios.post('https://go.servicem8.com/oauth/access_token', params);
    const data = response.data;
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt = Date.now() + data.expires_in * 1000;
    res.send('OAuth2 authorization successful. You can now use the integration.');
  } catch (err) {
    console.error('OAuth token exchange failed:', err.response ? err.response.data : err.message);
    res.status(500).send('OAuth token exchange failed');
  }
});

// Poll ServiceM8 for new or updated contacts and sync to GoHighLevel
async function syncContacts() {
  try {
    const accessToken = await getAccessToken();
    const sm8Url = 'https://api.servicem8.com/api_1.0/companycontact.json';
    const response = await axios.get(sm8Url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const contacts = response.data;
    for (const contact of contacts) {
      // Prepare contact data for GHL
      const firstName = contact.first_name || '';
      const lastName = contact.last_name || '';
      const email = contact.email_address || contact.email || '';
      const phone = contact.phone_number || contact.mobile_phone || '';
      // Build payload
      const contactPayload = {
        firstName: firstName,
        lastName: lastName,
        email: email,
        phone: phone
      };
      // Create or update in GHL
      try {
        // Attempt to find existing contact by email
        let ghlContactId = null;
        if (email) {
          try {
            const lookupRes = await axios.get(`https://rest.gohighlevel.com/v1/contacts/lookup?email=${encodeURIComponent(email)}`, {
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}` }
            });
            const existing = lookupRes.data;
            if (existing && existing.contact && existing.contact.id) {
              ghlContactId = existing.contact.id;
            }
          } catch (_) {
            // ignore lookup errors
          }
        }
        if (ghlContactId) {
          // Update contact
          await axios.put(`https://rest.gohighlevel.com/v1/contacts/${ghlContactId}`, contactPayload, {
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' }
          });
        } else {
          // Create new contact
          await axios.post('https://rest.gohighlevel.com/v1/contacts/', contactPayload, {
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' }
          });
        }
      } catch (err) {
        console.error('Error syncing contact to GoHighLevel:', err.response ? err.response.data : err.message);
      }
    }
  } catch (err) {
    console.error('Contact sync failed:', err.message);
  }
}

// Endpoint for GHL to create a ServiceM8 job
app.post('/ghl-create-job', async (req, res) => {
  try {
    const body = req.body;
    // Extract contact and job details from request
    const firstName = body.firstName || body.first_name || '';
    const lastName = body.lastName || body.last_name || '';
    const email = body.email || '';
    const phone = body.phone || '';
    const address = body.address || '';
    const city = body.city || '';
    const state = body.state || '';
    const postalCode = body.postalCode || '';
    const jobDescription = body.jobDescription || body.description || '';
    // Handle OAuth token for ServiceM8
    const accessToken = await getAccessToken();
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    // Step 1: Create or find Company (client) in ServiceM8
    const companyName = `${firstName} ${lastName}`.trim() || null;
    let companyUuid = null;
    if (companyName) {
      // Create a new company
      await axios.post('https://api.servicem8.com/api_1.0/company.json', { name: companyName }, { headers });
      // Retrieve all companies and find the one just created
      const companiesRes = await axios.get('https://api.servicem8.com/api_1.0/company.json', { headers });
      const companies = companiesRes.data;
      const match = companies.find(c => c.name === companyName);
      if (match) {
        companyUuid = match.uuid;
      }
    }
    // Step 2: Create Company Contact if email or phone provided
    if (companyUuid && (email || phone)) {
      const contactData = {
        company_uuid: companyUuid,
        first_name: firstName,
        last_name: lastName,
        email_address: email || undefined,
        phone_number: phone || undefined,
        active: true
      };
      await axios.post('https://api.servicem8.com/api_1.0/companycontact.json', contactData, { headers });
    }
    // Step 3: Create the Job
    const jobData = {
      company_uuid: companyUuid,
      status: 'Quote',
      job_address: [address, city, state, postalCode].filter(Boolean).join(', '),
      job_description: jobDescription
    };
    const jobRes = await axios.post('https://api.servicem8.com/api_1.0/job.json', jobData, { headers });
    // Get Job UUID from response headers
    const jobUuid = jobRes.headers['x-record-uuid'] || null;
    if (!jobUuid) {
      throw new Error('Failed to retrieve created job UUID');
    }
    // Step 4: Handle image URLs from GHL custom field 'Attach Photos (Optional)'
    const photoField = body['Attach Photos (Optional)'] || (body.customFields && body.customFields['Attach Photos (Optional)']);
    const photoUrls = [];
    if (typeof photoField === 'string') {
      // Assume comma-separated URLs
      photoUrls.push(...photoField.split(',').map(u => u.trim()).filter(u => u));
    } else if (Array.isArray(photoField)) {
      photoUrls.push(...photoField);
    }
    for (const imageUrl of photoUrls) {
      try {
        // Download the image
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const contentType = imageResponse.headers['content-type'] || '';
        const buffer = imageResponse.data;
        // Derive filename and extension
        const urlParts = imageUrl.split('?')[0].split('/');
        const rawName = urlParts[urlParts.length - 1] || 'attachment';
        const extension = rawName.includes('.') ? rawName.substring(rawName.lastIndexOf('.')) : '';
        const attachmentName = rawName;
        // Create attachment record for the job
        const attachJobData = {
          related_object: 'job',
          related_object_uuid: jobUuid,
          attachment_name: attachmentName,
          file_type: extension,
          active: true
        };
        const attachJobRes = await axios.post('https://api.servicem8.com/api_1.0/attachment.json', attachJobData, { headers });
        const attachJobUuid = attachJobRes.headers['x-record-uuid'];
        // Upload the file data to the job attachment
        const formJob = new FormData();
        formJob.append('file', buffer, { filename: attachmentName, contentType });
        await axios.post(`https://api.servicem8.com/api_1.0/attachment/${attachJobUuid}.file`, formJob, {
          headers: { ...formJob.getHeaders(), 'Authorization': `Bearer ${accessToken}` }
        });
        // Create attachment record for the company (client) if exists
        if (companyUuid) {
          const attachCompData = {
            related_object: 'company',
            related_object_uuid: companyUuid,
            attachment_name: attachmentName,
            file_type: extension,
            active: true
          };
          const attachCompRes = await axios.post('https://api.servicem8.com/api_1.0/attachment.json', attachCompData, { headers });
          const attachCompUuid = attachCompRes.headers['x-record-uuid'];
          // Upload the file to the company attachment
          const formComp = new FormData();
          formComp.append('file', buffer, { filename: attachmentName, contentType });
          await axios.post(`https://api.servicem8.com/api_1.0/attachment/${attachCompUuid}.file`, formComp, {
            headers: { ...formComp.getHeaders(), 'Authorization': `Bearer ${accessToken}` }
          });
        }
      } catch (imgErr) {
        console.error('Failed to attach image:', imgErr.message);
      }
    }
    res.status(200).send('Job created successfully in ServiceM8');
  } catch (err) {
    console.error('Error in /ghl-create-job:', err.response ? err.response.data : err.message);
    res.status(500).send('Failed to create job in ServiceM8');
  }
});

// Poll ServiceM8 for updated jobs to trigger GHL webhook when conditions met
async function checkJobsForReview() {
  try {
    const accessToken = await getAccessToken();
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    // Get all completed jobs (assuming we only care about completed status)
    const jobsRes = await axios.get(`https://api.servicem8.com/api_1.0/job.json?%24filter=status%20eq%20'Completed'`, { headers });
    const jobs = jobsRes.data;
    for (const job of jobs) {
      // Check if the specific badge is applied to the job
      if (job.badges && job.badges.includes(REVIEW_BADGE_UUID)) {
        // Check for job payments
        const paymentsRes = await axios.get(`https://api.servicem8.com/api_1.0/jobpayment.json?%24filter=job_uuid%20eq%20'${job.uuid}'`, { headers });
        const payments = paymentsRes.data;
        if (payments && payments.length > 0) {
          // Prepare payload for GHL webhook
          // Fetch company contact info if needed
          let contactInfo = {};
          if (job.company_uuid) {
            try {
              const compRes = await axios.get(`https://api.servicem8.com/api_1.0/company/${job.company_uuid}.json`, { headers });
              contactInfo.company = compRes.data;
            } catch (_) {
              // ignore company fetch errors
            }
          }
          // Summarize payment info
          const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
          const payload = {
            job: job,
            contact: contactInfo,
            payment: { totalPaid, count: payments.length }
          };
          // Trigger GHL webhook
          if (GHL_WEBHOOK_URL) {
            try {
              await axios.post(GHL_WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (ghlErr) {
              console.error('Error triggering GHL webhook:', ghlErr.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error checking jobs for review:', err.message);
  }
}

// Initial synchronization and polling setup
syncContacts();
checkJobsForReview();
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(syncContacts, POLL_INTERVAL);
setInterval(checkJobsForReview, POLL_INTERVAL);

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
