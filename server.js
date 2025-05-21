const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const moment = require('moment-timezone');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');

dotenv.config();

const app = express();
app.use(express.json());

// Configure multer for file uploads (for GHL form file attachments)
const upload = multer({ dest: 'uploads/' });

const SERVICE_M8_CLIENT_ID = process.env.SERVICE_M8_CLIENT_ID;
const SERVICE_M8_CLIENT_SECRET = process.env.SERVICE_M8_CLIENT_SECRET;
const SERVICE_M8_REDIRECT_URI = process.env.SERVICE_M8_REDIRECT_URI;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const REVIEW_BADGE_UUID = process.env.REVIEW_BADGE_UUID;
const PORT = process.env.PORT || 3000;

// Token storage
const TOKEN_FILE = 'tokens.json';
let accessToken = null;
let refreshToken = null;

// Load tokens
async function loadTokens() {
  try {
    const data = await fs.readFile(TOKEN_FILE, 'utf8');
    const tokens = JSON.parse(data);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
  } catch (error) {
    console.log('No saved tokens found');
  }
}

// Save tokens
async function saveTokens(tokens) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens));
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
}

// Refresh OAuth token
async function refreshAccessToken() {
  try {
    const response = await axios.post('https://api.servicem8.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: SERVICE_M8_CLIENT_ID,
      client_secret: SERVICE_M8_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    await saveTokens(response.data);
    console.log('Access token refreshed');
    return response.data.access_token;
  } catch (error) {
    console.error('Error refreshing token:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Axios instance with OAuth
const serviceM8Api = axios.create({
  baseURL: 'https://api.servicem8.com/api_1.0',
  headers: { Accept: 'application/json' },
});

serviceM8Api.interceptors.request.use(async (config) => {
  if (!accessToken) {
    await loadTokens();
  }
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
}, (error) => Promise.reject(error));

serviceM8Api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response && error.response.status === 401 && refreshToken) {
      try {
        const newAccessToken = await refreshAccessToken();
        error.config.headers.Authorization = `Bearer ${newAccessToken}`;
        return serviceM8Api(error.config);
      } catch (refreshError) {
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  }
);

// Store processed UUIDs and queue UUID
let processedJobs = new Set();
let processedContacts = new Set();
let quotesNewQueueUuid = null;
const STATE_FILE = 'state.json';

// Load polling state
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    processedJobs = new Set(state.processedJobs || []);
    processedContacts = new Set(state.processedContacts || []);
    return state.lastPollTimestamp || 0;
  } catch (error) {
    return 0;
  }
}

// Save polling state
async function saveState(lastPollTimestamp) {
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({
      lastPollTimestamp,
      processedJobs: Array.from(processedJobs),
      processedContacts: Array.from(processedContacts),
    })
  );
}

// Fetch ServiceM8 "Quotes - New" queue UUID
async function getQuotesNewQueueUuid() {
  if (quotesNewQueueUuid) {
    return quotesNewQueueUuid;
  }

  try {
    const response = await serviceM8Api.get('/jobqueues.json');
    const queues = response.data || [];
    console.log(`Fetched ${queues.length} queues from ServiceM8`);

    const queue = queues.find((q) => (q.name || '').toLowerCase().trim() === 'quotes - new');
    if (queue) {
      quotesNewQueueUuid = queue.uuid;
      console.log(`Found "Quotes - New" queue UUID: ${quotesNewQueueUuid}`);
      return quotesNewQueueUuid;
    }

    console.error('No "Quotes - New" queue found');
    return null;
  } catch (error) {
    console.error('Error fetching ServiceM8 queues:', error.response ? error.response.data : error.message);
    return null;
  }
}

// OAuth routes
app.get('/install', (req, res) => {
  const authUrl = `https://api.servicem8.com/oauth/authorize?client_id=${SERVICE_M8_CLIENT_ID}&redirect_uri=${encodeURIComponent(SERVICE_M8_REDIRECT_URI)}&response_type=code&scope=read_companies write_companies read_companycontacts write_companycontacts read_jobs write_jobs read_jobqueues read_jobpayments read_notes write_notes read_attachments write_attachments read_badges`;
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code missing');
  }

  try {
    const response = await axios.post('https://api.servicem8.com/oauth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: SERVICE_M8_CLIENT_ID,
      client_secret: SERVICE_M8_CLIENT_SECRET,
      redirect_uri: SERVICE_M8_REDIRECT_URI,
    });

    await saveTokens(response.data);
    res.send('Authorization successful! You can close this window.');
  } catch (error) {
    console.error('Error exchanging code for token:', error.response ? error.response.data : error.message);
    res.status(500).send('Authorization failed');
  }
});

// Serve manifest.json
app.get('/manifest.json', async (req, res) => {
  try {
    const manifest = await fs.readFile('manifest.json', 'utf8');
    res.json(JSON.parse(manifest));
  } catch (error) {
    res.status(500).send('Error serving manifest');
  }
});

// Check new ServiceM8 contacts and sync to GHL
const checkNewContacts = async () => {
  try {
    console.log('Polling ServiceM8 for new contacts...');
    const lastPollTimestamp = await loadState();
    const currentTimestamp = Date.now();

    const accountTimezone = 'Australia/Perth';
    const now = moment().tz(accountTimezone);
    const twentyMinutesAgo = now.clone().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    const filter = `$filter=edit_date gt '${twentyMinutesAgo}'`;

    const contactsResponse = await serviceM8Api.get(`/companycontact.json?${filter}`);
    const contacts = contactsResponse.data;
    console.log(`Fetched ${contacts.length} new or updated contacts from ServiceM8`);

    for (const contact of contacts) {
      const contactUuid = contact.uuid;
      if (processedContacts.has(contactUuid)) {
        continue;
      }

      const { first, last, email, phone, mobile, company_uuid } = contact;
      const contactName = `${first || ''} ${last || ''}`.trim();
      console.log(
        `New contact found - UUID: ${contactUuid}, Name: ${contactName}, Email: ${email}, Phone: ${
          phone || mobile
        }, Company UUID: ${company_uuid}`
      );

      if (!email && !contactName) {
        console.log(`No email or name for contact ${contactUuid}, skipping GHL creation.`);
        processedContacts.add(contactUuid);
        continue;
      }

      let ghlContactId = null;
      try {
        if (email) {
          const searchResponse = await axios.get('https://rest.gohighlevel.com/v1/contacts/', {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              Accept: 'application/json',
            },
            params: { query: email },
          });

          const existingContact = searchResponse.data.contacts.find(
            (c) => (c.email || '').toLowerCase().trim() === (email || '').toLowerCase().trim()
          );
          if (existingContact) {
            ghlContactId = existingContact.id;
            console.log(`Contact already exists in GHL: ${ghlContactId} for email ${email}`);
            processedContacts.add(contactUuid);
            continue;
          }
        }
      } catch (error) {
        console.error(
          `Error checking GHL contact for email ${email}:`,
          error.response ? error.response.data : error.message
        );
      }

      let addressDetails = {};
      try {
        const companyResponse = await serviceM8Api.get('/company.json', {
          params: { '$filter': `uuid eq '${company_uuid}'` },
        });

        const company = companyResponse.data[0] || {};
        addressDetails = {
          address1: company.billing_address || '',
          city: company.billing_city || '',
          state: company.billing_state || '',
          postalCode: company.billing_postcode || '',
        };
        console.log(`Fetched company address for ${company_uuid}:`, addressDetails);
      } catch (error) {
        console.error(
          `Error fetching company details for ${company_uuid}:`,
          error.response ? error.response.data : error.message
        );
      }

      try {
        const ghlContactResponse = await axios.post(
          'https://rest.gohighlevel.com/v1/contacts/',
          {
            firstName: first || '',
            lastName: last || '',
            name: contactName,
            email: email || '',
            phone: phone || mobile || '',
            address1: addressDetails.address1,
            city: addressDetails.city,
            state: addressDetails.state,
            postalCode: addressDetails.postalCode,
            source: 'ServiceM8',
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          }
        );

        ghlContactId = ghlContactResponse.data.contact.id;
        console.log(`Created GHL contact: ${ghlContactId} for email ${email}`);
        processedContacts.add(contactUuid);
      } catch (error) {
        console.error(
          'Error creating GHL contact:',
          error.response ? error.response.data : error.message
        );
      }
    }

    await saveState(currentTimestamp);
  } catch (error) {
    console.error('Error polling contacts:', error.response ? error.response.data : error.message);
  }
};

// Check payment status and trigger GHL webhook
const checkPaymentStatus = async () => {
  try {
    const accountTimezone = 'Australia/Perth';
    const now = moment().tz(accountTimezone);
    const twentyMinutesAgo = now.clone().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    const filter = `$filter=edit_date gt '${twentyMinutesAgo}'`;

    const jobsResponse = await serviceM8Api.get(`/job.json?${filter}`);
    const jobs = jobsResponse.data;
    console.log(`Fetched ${jobs.length} new or updated jobs from ServiceM8`);

    for (const job of jobs) {
      const jobUuid = job.uuid;
      console.log(`Checking payments for job UUID: ${jobUuid}`);

      if (processedJobs.has(jobUuid)) {
        console.log(`Job ${jobUuid} already processed, skipping.`);
        continue;
      }

      const paymentsResponse = await serviceM8Api.get('/jobpayment.json', {
        params: { '$filter': `job_uuid eq '${jobUuid}'` },
      });

      const payments = paymentsResponse.data;
      console.log(`Found ${payments.length} payment records for job ${jobUuid}`);
      console.log(`Payments for job ${jobUuid}: ${JSON.stringify(payments)}`);

      // Filter for paid payments
      const paidPayments = payments.filter(
        (p) => p.active === 1 && p.amount > 0 && p.timestamp && p.timestamp !== '0000-00-00 00:00:00'
      );
      if (paidPayments.length === 0) {
        console.log(`No paid payments found for job ${jobUuid}, skipping.`);
        if (payments.length > 0) {
          console.log(
            `Reasons for unpaid status: ${JSON.stringify(
              payments.map((p) => ({
                uuid: p.uuid,
                active: p.active,
                amount: p.amount,
                timestamp: p.timestamp,
              }))
            )}`
          );
        }
        continue;
      }

      // Log badge status for debugging
      console.log(`Raw badges for job ${jobUuid}: ${JSON.stringify(job.badges)}`);
      let badges = job.badges;
      if (typeof job.badges === 'string') {
        try {
          badges = JSON.parse(job.badges);
        } catch (error) {
          console.error(`Error parsing badges for job ${jobUuid}: ${error.message}`);
          badges = [];
        }
      }
      const hasReviewBadge = Array.isArray(badges) && badges.includes(REVIEW_BADGE_UUID);
      console.log(`Job ${jobUuid} has Review Request badge (${REVIEW_BADGE_UUID}): ${hasReviewBadge}`);

      // Check if the job has the "Review Request" badge
      if (hasReviewBadge) {
        const payment = paidPayments[0];
        const companyUuid = job.company_uuid;
        const paymentDate = payment.timestamp || 'not available';
        console.log(`Paid payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${paymentDate}`);

        const companyResponse = await serviceM8Api.get('/companycontact.json', {
          params: { '$filter': `company_uuid eq '${companyUuid}'` },
        });

        const company = companyResponse.data;
        const primaryContact = company.find((c) => c.email) || {};
        const clientEmail = (primaryContact.email || '').trim().toLowerCase();
        console.log(`Extracted client email: ${clientEmail}`);

        // Extract GHL Contact ID from job description
        let ghlContactId = '';
        if (job.job_description) {
          const ghlContactIdMatch = job.job_description.match(/GHL Contact ID: ([a-zA-Z0-9]+)/);
          ghlContactId = ghlContactIdMatch ? ghlContactIdMatch[1] : '';
        }

        const webhookPayload = {
          jobUuid: jobUuid,
          clientEmail: clientEmail || '',
          ghlContactId: ghlContactId,
          status: 'Invoice Paid',
        };
        console.log(
          `Triggering GHL webhook for job ${jobUuid} with payload: ${JSON.stringify(webhookPayload)}`
        );

        try {
          const webhookResponse = await axios.post(GHL_WEBHOOK_URL, webhookPayload, {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
            },
          });
          console.log(
            `GHL webhook response for job ${jobUuid}: ${webhookResponse.status} ${JSON.stringify(
              webhookResponse.data
            )}`
          );
          processedJobs.add(jobUuid);
        } catch (webhookError) {
          console.error(
            `Failed to trigger GHL webhook for job ${jobUuid}:`,
            webhookError.response
              ? `${webhookError.response.status} ${JSON.stringify(webhookError.response.data)}`
              : webhookError.message
          );
        }
      } else {
        console.log(`Job ${jobUuid} skipped: Missing Review Request badge`);
      }
    }
  } catch (error) {
    console.error('Error checking payment status:', error.response ? error.response.data : error.message);
  }
};

// Endpoint for GHL to create a job in ServiceM8
app.post('/ghl-create-job', upload.array('photos'), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, jobDescription, ghlContactId, photos, } = req.body;

    if (!firstName || !lastName || !email || !ghlContactId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!REVIEW_BADGE_UUID) {
      return res.status(500).json({ error: 'Review Request badge UUID not configured' });
    }

    const queueUuid = await getQuotesNewQueueUuid();
    if (!queueUuid) {
      return res.status(500).json({ error: 'Failed to fetch "Quotes - New" queue UUID' });
    }

    const companiesResponse = await serviceM8Api.get('/company.json');
    const companies = companiesResponse.data;
    console.log(`Fetched ${companies.length} companies from ServiceM8`);

    let companyUuid;
    const fullName = `${firstName} ${lastName}`.toLowerCase().trim();
    const matchingCompany = companies.find((company) => {
      const companyEmail = (company.email || '').toLowerCase().trim();
      const companyName = (company.name || '').toLowerCase().trim();
      const inputEmail = (email || '').toLowerCase().trim();
      const inputName = fullName;
      console.log(
        `Comparing email: ${companyEmail} vs ${inputEmail}, name: ${companyName} vs ${inputName}`
      );
      return companyEmail === inputEmail || companyName === inputName;
    });

    if (matchingCompany) {
      companyUuid = matchingCompany.uuid;
      console.log(
        `Client already exists: ${companyUuid} for email ${email}, phone: ${matchingCompany.phone}`
      );
    } else {
      console.log(`Creating new client with name ${fullName}, email ${email}, phone ${phone}`);
      const newCompanyResponse = await serviceM8Api.post('/company.json', { name: fullName });
      companyUuid = newCompanyResponse.headers['x-record-uuid'];
      console.log(`Client created: ${companyUuid} for email ${email} with phone ${phone}`);

      // Create GHL contact immediately
      try {
        const ghlContactResponse = await axios.post(
          'https://rest.gohighlevel.com/v1/contacts/',
          {
            firstName: firstName || '',
            lastName: lastName || '',
            name: fullName,
            email: email || '',
            phone: phone || '',
            address1: address || '',
            source: 'ServiceM8',
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          }
        );
        console.log(`Created GHL contact for email ${email}`);
      } catch (error) {
        console.error(
          'Error creating GHL contact:',
          error.response ? error.response.data : error.message
        );
      }

      await serviceM8Api.post('/companycontact.json', {
        company_uuid: companyUuid,
        first: firstName,
        last: lastName,
        email: email,
        phone: phone,
      });

      console.log(`Contact added for client: ${companyUuid}`);
    }

    // Create a new job in ServiceM8
    const jobData = {
      company_uuid: companyUuid,
      status: 'Quote',
      queue_uuid: queueUuid,
      badges: JSON.stringify([REVIEW_BADGE_UUID]),
      job_description: `GHL Contact ID: ${ghlContactId}\n${jobDescription || ''}`,
    };

    const jobResponse = await serviceM8Api.post('/job.json', jobData);
    const jobUuid = jobResponse.headers['x-record-uuid'];
    console.log(`Job created: ${jobUuid} in queue ${queueUuid}`);

    // Fetch images from GHL /contacts/{id}
    let photoUrls = [];
    try {
      const contactResponse = await axios.get(`https://rest.gohighlevel.com/v1/contacts/${ghlContactId}`, {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Accept: 'application/json',
        },
      });

      const contact = contactResponse.data.contact;
      if (contact.customFields) {
        // Assuming images are stored in a custom field (adjust field name as needed)
        const imageField = contact.customFields.find((field) => field.name === 'Attach Photos (Optional)' || field.name === 'Images');
        if (imageField && imageField.value) {
          photoUrls = Array.isArray(imageField.value) ? imageField.value : [imageField.value];
        }
      }
      console.log(`Fetched ${photoUrls.length} photo URLs from GHL contact ${ghlContactId}: ${photoUrls}`);
    } catch (error) {
      console.error(
        'Error fetching GHL contact images:',
        error.response ? error.response.data : error.message
      );
    }

    // Download and upload images to ServiceM8 as job notes
    for (const photoUrl of photoUrls) {
      const filename = photoUrl.split('/').pop() || `photo-${Date.now()}.jpg`;
      const ext = path.extname(filename).toLowerCase() || '.jpg';
      const fileType = ext === '.png' ? 'image/png' : 'image/jpeg';
      const tempPath = path.join('uploads', filename);

      try {
        const photoResponse = await axios.get(photoUrl, { responseType: 'stream' });
        await fs.writeFile(tempPath, photoResponse.data);

        // Upload to job as note
        const noteForm = new FormData();
        noteForm.append('related_object', 'job');
        noteForm.append('related_object_uuid', jobUuid);
        noteForm.append('body', `Image attachment: ${filename}`);
        noteForm.append('attachment', fs.createReadStream(tempPath), { filename, contentType: fileType });

        const noteResponse = await serviceM8Api.post('/note.json', noteForm, {
          headers: noteForm.getHeaders(),
        });

        console.log(
          `Image added to job ${jobUuid} as note from URL ${photoUrl}, note UUID: ${
            noteResponse.headers['x-record-uuid']
          }`
        );

        // Optionally upload to company as attachment
        const companyForm = new FormData();
        companyForm.append('related_object', 'company');
        companyForm.append('related_object_uuid', companyUuid);
        companyForm.append('attachment_name', filename);
        companyForm.append('file_type', fileType);
        companyForm.append('attachment', fs.createReadStream(tempPath), { filename });

        const companyAttachmentResponse = await serviceM8Api.post('/Attachment.json', companyForm, {
          headers: companyForm.getHeaders(),
        });

        console.log(
          `Image added to company ${companyUuid} from URL ${photoUrl}, attachment UUID: ${
            companyAttachmentResponse.headers['x-record-uuid']
          }`
        );

        await fs.unlink(tempPath);
      } catch (photoError) {
        console.error(
          'Error processing photo from URL:',
          photoError.response ? photoError.response.data : photoError.message
        );
      }
    }

    res.status(200).json({ message: 'Job created successfully', jobUuid });
  } catch (error) {
    console.error('Error creating job:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Temporary endpoints for testing
app.get('/test-payment-check', async (req, res) => {
  await checkPaymentStatus();
  res.send('Payment check triggered');
});

app.get('/test-contact-check', async (req, res) => {
  await checkNewContacts();
  res.send('Contact check triggered');
});

// Schedule polling
cron.schedule('*/20 * * * *', () => {
  console.log('Polling ServiceM8 for new contacts...');
  checkNewContacts();
});

cron.schedule('*/20 * * * *', () => {
  console.log('Polling ServiceM8 for completed jobs and paid payments...');
  checkPaymentStatus();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});