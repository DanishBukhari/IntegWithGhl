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

const SERVICE_M8_USERNAME = process.env.SERVICE_M8_USERNAME;
const SERVICE_M8_PASSWORD = process.env.SERVICE_M8_PASSWORD;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const REVIEW_BADGE_UUID = "ed0b1d72-46cd-4ca4-bf06-22ca254463fb"
const PORT = process.env.PORT || 3000;

// Base64 encode credentials for HTTP Basic Auth
const authHeader = 'Basic ' + Buffer.from(`${SERVICE_M8_USERNAME}:${SERVICE_M8_PASSWORD}`).toString('base64');

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
    const response = await axios.get('https://api.servicem8.com/api_1.0/jobqueues.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

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
    console.error(
      'Error fetching ServiceM8 queues:',
      error.response ? error.response.data : error.message
    );
    return null;
  }
}

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

    const contactsResponse = await axios.get(
      `https://api.servicem8.com/api_1.0/companycontact.json?${filter}`,
      {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      }
    );

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
          const searchResponse = await axios.get(`https://rest.gohighlevel.com/v1/contacts/`, {
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
        const companyResponse = await axios.get(`https://api.servicem8.com/api_1.0/company.json`, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
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
            source: 'ServiceM8'
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
    console.error(
      'Error polling contacts:',
      error.response ? error.response.data : error.message
    );
  }
};

// Check payment status and trigger GHL webhook
const checkPaymentStatus = async () => {
  try {
    const accountTimezone = 'Australia/Perth';
    const now = moment().tz(accountTimezone);
    const twentyMinutesAgo = now.clone().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    const filter = `$filter=edit_date gt '${twentyMinutesAgo}'`;

    const jobsResponse = await axios.get(`https://api.servicem8.com/api_1.0/job.json?${filter}`, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    const jobs = jobsResponse.data;
    console.log(`Fetched ${jobs.length} new or updated jobs from ServiceM8`);

    for (const job of jobs) {
      const jobUuid = job.uuid;
      console.log(`Checking payments for job UUID: ${jobUuid}`);

      if (processedJobs.has(jobUuid)) {
        console.log(`Job ${jobUuid} already processed, skipping.`);
        continue;
      }

      const paymentsResponse = await axios.get('https://api.servicem8.com/api_1.0/jobpayment.json', {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
        params: {
          '$filter': `job_uuid eq '${jobUuid}'`
        },
      });

      const payments = paymentsResponse.data;
      console.log(`Found ${payments.length} payment records for job ${jobUuid}`);
      console.log(`Payments for job ${jobUuid}: ${JSON.stringify(payments)}`);

      // Filter for paid payments
      const paidPayments = payments.filter(
        p => p.active === 1 && p.amount > 0 && p.timestamp && p.timestamp !== '0000-00-00 00:00:00'
      );
      if (paidPayments.length === 0) {
        console.log(`No paid payments found for job ${jobUuid}, skipping.`);
        if (payments.length > 0) {
          console.log(`Reasons for unpaid status: ${JSON.stringify(payments.map(p => ({
            uuid: p.uuid,
            active: p.active,
            amount: p.amount,
            timestamp: p.timestamp
          })))}`);
        }
        continue;
      }

      // Log badge status for debugging
      const hasReviewBadge = Array.isArray(job.badges) && job.badges.includes(REVIEW_BADGE_UUID);
      console.log(`Job ${jobUuid} has Review Request badge (${REVIEW_BADGE_UUID}): ${hasReviewBadge}`);

      // Check if the job has the "Review Request" badge
      if (hasReviewBadge) {
        const payment = paidPayments[0];
        const companyUuid = job.company_uuid;
        const paymentDate = payment.timestamp || 'not available';
        console.log(`Paid payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${paymentDate}`);

        const companyResponse = await axios.get(
          `https://api.servicem8.com/api_1.0/companycontact.json`,
          {
            headers: {
              Authorization: authHeader,
              Accept: 'application/json',
            },
            params: {
              '$filter': `company_uuid eq '${companyUuid}'`
            },
          }
        );

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
          status: 'Invoice Paid'
        };
        console.log(
          `Triggering GHL webhook for job ${jobUuid} with payload: ${JSON.stringify(webhookPayload)}`
        );

        try {
          const webhookResponse = await axios.post(
            GHL_WEBHOOK_URL,
            webhookPayload,
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );
          console.log(`GHL webhook response for job ${jobUuid}: ${webhookResponse.status} ${JSON.stringify(webhookResponse.data)}`);
          processedJobs.add(jobUuid);
        } catch (webhookError) {
          console.error(
            `Failed to trigger GHL webhook for job ${jobUuid}:`,
            webhookError.response ? `${webhookError.response.status} ${JSON.stringify(webhookError.response.data)}` : webhookError.message
          );
        }
      } else {
        console.log(`Job ${jobUuid} skipped: Missing Review Request badge`);
      }
    }
  } catch (error) {
    console.error(
      'Error checking payment status:',
      error.response ? error.response.data : error.message
    );
  }
};

// Endpoint for GHL to create a job in ServiceM8
app.post('/ghl-create-job', upload.array('photos'), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, jobDescription, ghlContactId, photos } = req.body;

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

    const companiesResponse = await axios.get('https://api.servicem8.com/api_1.0/company.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

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
      const newCompanyResponse = await axios.post(
        'https://api.servicem8.com/api_1.0/company.json',
        { name: fullName },
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        }
      );

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
            source: 'ServiceM8'
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

      await axios.post(
        `https://api.servicem8.com/api_1.0/companycontact.json`,
        {
          company_uuid: companyUuid,
          first: firstName,
          last: lastName,
          email: email,
          phone: phone,
        },
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        }
      );

      console.log(`Contact added for client: ${companyUuid}`);
    }

    // Create a new job in ServiceM8
    const jobData = {
      company_uuid: companyUuid,
      status: 'Quote',
      queue_uuid: queueUuid,
      badges: JSON.stringify([REVIEW_BADGE_UUID]),
      job_description: `GHL Contact ID: ${ghlContactId}`
    };

    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      jobData,
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    const jobUuid = jobResponse.headers['x-record-uuid'];
    console.log(`Job created: ${jobUuid} in queue ${queueUuid}`);

    // Handle photo uploads from GHL form (URLs)
    if (photos) {
      let photoUrls = [];
      try {
        if (typeof photos === 'string') {
          if (photos.startsWith('[') && photos.endsWith(']')) {
            photoUrls = JSON.parse(photos);
          } else {
            photoUrls = [photos];
          }
        } else if (Array.isArray(photos)) {
          photoUrls = photos;
        }
        console.log(`Parsed photo URLs: ${photoUrls}`);
      } catch (error) {
        console.error('Error parsing photos field:', error.message);
      }

      for (const photoUrl of photoUrls) {
        const filename = photoUrl.split('/').pop() || `photo-${Date.now()}.jpg`;
        const ext = path.extname(filename).toLowerCase() || '.jpg';
        const fileType = ext === '.png' ? 'image/png' : 'image/jpeg';
        try {
          const photoResponse = await axios.get(photoUrl, { responseType: 'stream' });
          // Upload to job
          const jobForm = new FormData();
          jobForm.append('related_object', 'job');
          jobForm.append('related_object_uuid', jobUuid);
          jobForm.append('attachment_name', filename);
          jobForm.append('file_type', fileType);
          jobForm.append('attachment', photoResponse.data, { filename });

          const jobAttachmentResponse = await axios.post('https://api.servicem8.com/api_1.0/Attachment.json', jobForm, {
            headers: {
              ...jobForm.getHeaders(),
              Authorization: authHeader,
            },
          });

          console.log(`Photo added to job ${jobUuid} from URL ${photoUrl}, attachment UUID: ${jobAttachmentResponse.headers['x-record-uuid']}`);

          // Upload to company
          const companyForm = new FormData();
          companyForm.append('related_object', 'company');
          companyForm.append('related_object_uuid', companyUuid);
          companyForm.append('attachment_name', filename);
          companyForm.append('file_type', fileType);
          companyForm.append('attachment', photoResponse.data, { filename });

          const companyAttachmentResponse = await axios.post('https://api.servicem8.com/api_1.0/Attachment.json', companyForm, {
            headers: {
              ...companyForm.getHeaders(),
              Authorization: authHeader,
            },
          });

          console.log(`Photo added to company ${companyUuid} from URL ${photoUrl}, attachment UUID: ${companyAttachmentResponse.headers['x-record-uuid']}`);
        } catch (photoError) {
          console.error(
            'Error adding photo from URL:',
            photoError.response ? photoError.response.data : photoError.message
          );
        }
      }
    }

    // Handle direct file uploads from GHL form
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const filename = file.originalname || `photo-${Date.now()}.jpg`;
        const ext = path.extname(filename).toLowerCase() || '.jpg';
        const fileType = ext === '.png' ? 'image/png' : 'image/jpeg';
        const jobForm = new FormData();
        jobForm.append('related_object', 'job');
        jobForm.append('related_object_uuid', jobUuid);
        jobForm.append('attachment_name', filename);
        jobForm.append('file_type', fileType);
        jobForm.append('attachment', fs.createReadStream(file.path), { filename });

        try {
          const jobAttachmentResponse = await axios.post('https://api.servicem8.com/api_1.0/Attachment.json', jobForm, {
            headers: {
              ...jobForm.getHeaders(),
              Authorization: authHeader,
            },
          });
          console.log(`Photo added to job ${jobUuid} from file upload, attachment UUID: ${jobAttachmentResponse.headers['x-record-uuid']}`);

          // Upload to company
          const companyForm = new FormData();
          companyForm.append('related_object', 'company');
          companyForm.append('related_object_uuid', companyUuid);
          companyForm.append('attachment_name', filename);
          companyForm.append('file_type', fileType);
          jobForm.append('attachment', fs.createReadStream(file.path), { filename });

          const companyAttachmentResponse = await axios.post('https://api.servicem8.com/api_1.0/Attachment.json', companyForm, {
            headers: {
              ...companyForm.getHeaders(),
              Authorization: authHeader,
            },
          });
          console.log(`Photo added to company ${companyUuid} from file upload, attachment UUID: ${companyAttachmentResponse.headers['x-record-uuid']}`);
        } catch (photoError) {
          console.error(
            'Error adding photo from file:',
            photoError.response ? photoError.response.data : photoError.message
          );
        } finally {
          await fs.unlink(file.path);
        }
      }
    }

    res.status(200).json({ message: 'Job created successfully', jobUuid });
  } catch (error) {
    console.error(
      'Error creating job:',
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Temporary endpoints
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