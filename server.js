const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const moment = require('moment-timezone');
const multer = require('multer');
const FormData = require('form-data');

dotenv.config();

const app = express();
app.use(express.json());

// Configure multer for file uploads (fallback if GHL sends files directly)
const upload = multer({ dest: 'uploads/' });

const SERVICE_M8_USERNAME = process.env.SERVICE_M8_USERNAME;
const SERVICE_M8_PASSWORD = process.env.SERVICE_M8_PASSWORD;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Base64 encode credentials for HTTP Basic Auth
const authHeader = 'Basic ' + Buffer.from(`${SERVICE_M8_USERNAME}:${SERVICE_M8_PASSWORD}`).toString('base64');

// Store processed UUIDs
let processedJobs = new Set();
let processedContacts = new Set();
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

      // Check if the job has the "Review Request" badge
      if (payments.length > 0 && Array.isArray(job.badges) && job.badges.includes('Review Request')) {
        const payment = payments[0];
        const companyUuid = job.company_uuid;
        const paymentDate = payment.date_paid || payment.payment_date || 'not available';
        console.log(`Payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${paymentDate}`);

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

        console.log(
          `Triggering GHL webhook for job ${jobUuid} with clientEmail: ${clientEmail} and ghlContactId: ${ghlContactId}`
        );
        await axios.post(
          GHL_WEBHOOK_URL,
          {
            jobUuid: jobUuid,
            clientEmail: clientEmail || '',
            ghlContactId: ghlContactId,
            status: 'Invoice Paid',
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        console.log(`Triggered GHL webhook for job ${jobUuid}`);
        processedJobs.add(jobUuid);
      }
    }
  } catch (error) {
    console.error(
      'Error checking payment status:',
      error.response ? error.response.data : error.message
    );
  }
};

// Sync new ServiceM8 jobs to GHL
const syncNewJobs = async () => {
  try {
    console.log('Syncing new jobs from ServiceM8 to GHL...');
    const lastPollTimestamp = await loadState();
    const currentTimestamp = Date.now();

    const twentyMinutesAgo = moment().tz('Australia/Perth').subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
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
      if (processedJobs.has(jobUuid)) {
        continue;
      }

      let ghlContactId = '';
      if (job.job_description) {
        const ghlContactIdMatch = job.job_description.match(/GHL Contact ID: ([a-zA-Z0-9]+)/);
        ghlContactId = ghlContactIdMatch ? ghlContactIdMatch[1] : '';
      }

      if (!ghlContactId) {
        console.log(`No GHL Contact ID found for job ${jobUuid}, skipping.`);
        continue;
      }

      try {
        const opportunityResponse = await axios.post(
          'https://rest.gohighlevel.com/v1/pipelines/opportunities/',
          {
            contactId: ghlContactId,
            name: job.job_description || 'New Job',
            status: 'open',
            pipelineId: 'your_pipeline_id', // Replace with your GHL pipeline ID
            pipelineStageId: 'your_pipeline_stage_id' // Replace with your GHL pipeline stage ID
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          }
        );

        const opportunityId = opportunityResponse.data.id;
        console.log(`Created GHL opportunity: ${opportunityId} for job ${jobUuid}`);

        // Add "new quotes" tag
        await axios.post(
          `https://rest.gohighlevel.com/v1/contacts/${ghlContactId}/tags`,
          {
            tags: ['new quotes'],
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          }
        );
      } catch (error) {
        console.error(
          `Error creating GHL opportunity for job ${jobUuid}:`,
          error.response ? error.response.data : error.message
        );
      }

      processedJobs.add(jobUuid);
    }

    await saveState(currentTimestamp);
  } catch (error) {
    console.error(
      'Error syncing new jobs:',
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
      badges: ['Review Request'],
      job_description: `GHL Contact ID: ${ghlContactId}\n${jobDescription || ''}`,
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
    console.log(`Job created: ${jobUuid}`);

    // Handle photo uploads from GHL form (URLs)
    if (photos) {
      let photoUrls = [];
      try {
        photoUrls = Array.isArray(photos) ? photos : JSON.parse(photos);
      } catch (error) {
        console.error('Error parsing photos field:', error.message);
      }

      for (const photoUrl of photoUrls) {
        try {
          const photoResponse = await axios.get(photoUrl, { responseType: 'stream' });
          const form = new FormData();
          form.append('job_uuid', jobUuid);
          form.append('photo', photoResponse.data);

          await axios.post('https://api.servicem8.com/api_1.0/jobphoto.json', form, {
            headers: {
              ...form.getHeaders(),
              Authorization: authHeader,
            },
          });
          console.log(`Photo added to job ${jobUuid} from URL ${photoUrl}`);
        } catch (photoError) {
          console.error(
            'Error adding photo:',
            photoError.response ? photoError.response.data : photoError.message
          );
        }
      }
    }

    // Handle direct file uploads (fallback)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const form = new FormData();
        form.append('job_uuid', jobUuid);
        form.append('photo', fs.createReadStream(file.path));

        try {
          await axios.post('https://api.servicem8.com/api_1.0/jobphoto.json', form, {
            headers: {
              ...form.getHeaders(),
              Authorization: authHeader,
            },
          });
          console.log(`Photo added to job ${jobUuid}`);
        } catch (photoError) {
          console.error(
            'Error adding photo:',
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

app.get('/test-sync-jobs', async (req, res) => {
  await syncNewJobs();
  res.send('Job sync triggered');
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

cron.schedule('*/20 * * * *', () => {
  console.log('Syncing new jobs from ServiceM8 to GHL...');
  syncNewJobs();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});