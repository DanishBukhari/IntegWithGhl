const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs').promises;

dotenv.config();

const app = express();
app.use(express.json());

const SERVICE_M8_USERNAME = process.env.SERVICE_M8_USERNAME;
const SERVICE_M8_PASSWORD = process.env.SERVICE_M8_PASSWORD;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Base64 encode credentials for HTTP Basic Auth
const authHeader = 'Basic ' + Buffer.from(`${SERVICE_M8_USERNAME}:${SERVICE_M8_PASSWORD}`).toString('base64');

// Store processed job UUIDs to avoid duplicate triggers
let processedJobs = new Set();

// Store processed contact UUIDs to avoid duplicate processing
let processedContacts = new Set();

// File to store polling state
const STATE_FILE = 'state.json';

// Load polling state from file
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    processedJobs = new Set(state.processedJobs || []);
    processedContacts = new Set(state.processedContacts || []);
    return state.lastPollTimestamp || 0;
  } catch (error) {
    return 0; // If file doesn’t exist, start from epoch
  }
}

// Save polling state to file
async function saveState(lastPollTimestamp) {
  await fs.writeFile(STATE_FILE, JSON.stringify({
    lastPollTimestamp,
    processedJobs: Array.from(processedJobs),
    processedContacts: Array.from(processedContacts)
  }));
}

// Function to check for new ServiceM8 contacts and sync to GHL
const checkNewContacts = async () => {
  try {
    console.log('Polling ServiceM8 for new contacts...');
    const lastPollTimestamp = await loadState();
    const currentTimestamp = Date.now();
    const lastPollDate = new Date(lastPollTimestamp).toISOString().split('.')[0]; // Format as YYYY-MM-DDTHH:mm:ss

    // Fetch contacts edited since last poll
    const contactsResponse = await axios.get('https://api.servicem8.com/api_1.0/companycontact.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      },
      params: {
        '$filter': `edit_date  '${lastPollDate}'`
      }
    });

    const contacts = contactsResponse.data;
    console.log(`Fetched ${contacts.length} new or updated contacts from ServiceM8`);

    for (const contact of contacts) {
      const contactUuid = contact.uuid;

      // Skip if already processed
      if (processedContacts.has(contactUuid)) {
        continue;
      }

      // Extract contact details
      const { first, last, email, phone, mobile, company_uuid } = contact;
      const contactName = `${first || ''} ${last || ''}`.trim();

      // Log received contact details
      console.log(`New contact - UUID: ${contactUuid}, Name: ${contactName}, Email: ${email}, Phone: ${phone || mobile}, Company UUID: ${company_uuid}`);

      // Skip if no email or name
      if (!email && !contactName) {
        console.log(`No email or name for contact ${contactUuid}, skipping GHL creation.`);
        processedContacts.add(contactUuid);
        continue;
      }

      // Check if contact exists in GHL by email
      let ghlContactId = null;
      try {
        if (email) {
          const searchResponse = await axios.get(`https://rest.gohighlevel.com/v1/contacts/`, {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              Accept: 'application/json'
            },
            params: {
              query: email
            }
          });

          const existingContact = searchResponse.data.contacts.find(c => (c.email || '').toLowerCase().trim() === (email || '').toLowerCase().trim());
          if (existingContact) {
            ghlContactId = existingContact.id;
            console.log(`Contact already exists in GHL: ${ghlContactId} for email ${email}`);
            processedContacts.add(contactUuid);
            continue;
          }
        }
      } catch (error) {
        console.error(`Error checking GHL contact for email ${email}:`, error.response ? error.response.data : error.message);
      }

      // Fetch company details for address
      let addressDetails = {};
      try {
        const companyResponse = await axios.get(`https://api.servicem8.com/api_1.0/company.json`, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          },
          params: {
            '$filter': `uuid eq '${company_uuid}'`
          }
        });

        const company = companyResponse.data[0] || {};
        addressDetails = {
          address1: company.billing_address || '',
          city: company.billing_city || '',
          state: company.billing_state || '',
          postalCode: company.billing_postcode || ''
        };
        console.log(`Fetched company address for ${company_uuid}:`, addressDetails);
      } catch (error) {
        console.error(`Error fetching company details for ${company_uuid}:`, error.response ? error.response.data : error.message);
      }

      // Create contact in GHL
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
            postalCode: addressDetails.postalCode
          },
          {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            }
          }
        );

        ghlContactId = ghlContactResponse.data.contact.id;
        console.log(`Created GHL contact: ${ghlContactId} for email ${email}`);
        processedContacts.add(contactUuid);
      } catch (error) {
        console.error('Error creating GHL contact:', error.response ? error.response.data : error.message);
      }
    }

    // Update polling state
    await saveState(currentTimestamp);
  } catch (error) {
    console.error('Error polling contacts:', error.response ? error.response.data : error.message);
  }
};

// Function to check for new ServiceM8 jobs and their payment status
const checkNewJobs = async () => {
  try {
    console.log('Polling ServiceM8 for new jobs...');
    const lastPollTimestamp = await loadState();
    const currentTimestamp = Date.now();
    const lastPollDate = new Date(lastPollTimestamp).toISOString().split('.')[0];

    // Fetch jobs created or edited since last poll
    const jobsResponse = await axios.get('https://api.servicem8.com/api_1.0/job.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      },
      params: {
        '$filter': `edit_date '${lastPollDate}'`
      }
    });

    const jobs = jobsResponse.data;
    console.log(`Fetched ${jobs.length} new or updated jobs from ServiceM8`);

    for (const job of jobs) {
      const jobUuid = job.uuid;

      // Skip if already processed
      if (processedJobs.has(jobUuid)) {
        continue;
      }

      console.log(`Checking payments for new job UUID: ${jobUuid}`);

      // Fetch payments for the job
      const paymentsResponse = await axios.get('https://api.servicem8.com/api_1.0/jobpayment.json', {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        params: {
          '$filter': `job_uuid eq '${jobUuid}'`
        }
      });

      const payments = paymentsResponse.data;
      console.log(`Found ${payments.length} payment records for job ${jobUuid}`);

      if (payments.length > 0) {
        // Payment exists, assume the job is paid
        const payment = payments[0];
        const companyUuid = job.company_uuid;
        const paymentDate = payment.date_paid || payment.payment_date || 'not available';
        console.log(`Payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${paymentDate}`);

        // Fetch the company details to get the email
        const companyResponse = await axios.get(`https://api.servicem8.com/api_1.0/companycontact.json`, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          },
          params: {
            '$filter': `company_uuid eq '${companyUuid}'`
          }
        });

        const company = companyResponse.data;
        console.log('Company contacts response:', company);
        const primaryContact = company.find(c => c.email) || {};
        const clientEmail = (primaryContact.email || '').trim().toLowerCase();
        console.log(`Extracted client email: ${clientEmail}`);

        // Extract GHL Contact ID from job description
        let ghlContactId = '';
        if (job.job_description) {
          const ghlContactIdMatch = job.job_description.match(/GHL Contact ID: ([a-zA-Z0-9]+)/);
          ghlContactId = ghlContactIdMatch ? ghlContactIdMatch[1] : '';
        } else {
          console.log(`Job description is undefined for job ${jobUuid}, GHL Contact ID not found`);
        }

        // Trigger GHL webhook for review request
        console.log(`Triggering GHL webhook for job ${jobUuid} with clientEmail: ${clientEmail} and ghlContactId: ${ghlContactId}`);
        try {
          await axios.post(
            GHL_WEBHOOK_URL,
            {
              jobUuid: jobUuid,
              clientEmail: clientEmail || '',
              ghlContactId: ghlContactId,
              status: 'Invoice Paid'
            },
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`Triggered GHL webhook for job ${jobUuid}`);
        } catch (error) {
          console.error(`Error triggering GHL webhook for job ${jobUuid}:`, error.response ? error.response.data : error.message);
        }

        processedJobs.add(jobUuid); // Mark as processed
      }
    }

    // Update polling state
    await saveState(currentTimestamp);
  } catch (error) {
    console.error('Error polling jobs:', error.response ? error.response.data : error.message);
  }
};

// Endpoint for GHL to create a job in ServiceM8
app.post('/ghl-create-job', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, jobDescription, ghlContactId } = req.body;

    // Validate request
    if (!firstName || !lastName || !email || !jobDescription || !ghlContactId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch all companies from ServiceM8
    const companiesResponse = await axios.get('https://api.servicem8.com/api_1.0/company.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      }
    });

    const companies = companiesResponse.data;
    console.log(`Fetched ${companies.length} companies from ServiceM8`);

    // Search for a company with matching email or name (case-insensitive)
    let companyUuid;
    const fullName = `${firstName} ${lastName}`.toLowerCase().trim();

    const matchingCompany = companies.find(company => {
      const companyEmail = (company.email || '').toLowerCase().trim();
      const companyName = (company.name || '').toLowerCase().trim();
      const inputEmail = (email || '').toLowerCase().trim();
      const inputName = fullName;
      console.log(`Comparing email: ${companyEmail} vs ${inputEmail}, name: ${companyName} vs ${inputName}`);
      return companyEmail === inputEmail || companyName === inputName;
    });

    if (matchingCompany) {
      companyUuid = matchingCompany.uuid;
      console.log(`Client already exists: ${companyUuid} for email ${email}, phone: ${matchingCompany.phone}`);
    } else {
      // Create a new client in ServiceM8
      console.log(`Creating new client with name ${fullName}, email ${email}, phone ${phone}`);
      const newCompanyResponse = await axios.post(
        'https://api.servicem8.com/api_1.0/company.json',
        {
          name: fullName,
        },
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        }
      );

      companyUuid = newCompanyResponse.headers['x-record-uuid'];
      console.log(`Client created: ${companyUuid} for email ${email} with phone ${phone}`);

      // Add contact to the company
      await axios.post(
        `https://api.servicem8.com/api_1.0/companycontact.json`,
        {
          company_uuid: companyUuid,
          first: firstName,
          last: lastName,
          email: email,
          phone: phone
        },
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        }
      );

      console.log(`Contact added for client: ${companyUuid}`);
    }

    // Create a job in ServiceM8
    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      {
        company_uuid: companyUuid,
        job_description: jobDescription ? `${jobDescription} (GHL Contact ID: ${ghlContactId})` : `(GHL Contact ID: ${ghlContactId})`,
        status: 'Quote'
      },
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    const jobUuid = jobResponse.headers['x-record-uuid'];
    console.log(`Job created: ${jobUuid}`);

    res.status(200).json({ message: 'Job created successfully', jobUuid });

  } catch (error) {
    console.error('Error creating job:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Temporary endpoint to manually trigger contact polling
app.get('/test-contact-check', async (req, res) => {
  await checkNewContacts();
  res.send('Contact check triggered');
});

// Temporary endpoint to manually trigger job polling
app.get('/test-job-check', async (req, res) => {
  await checkNewJobs();
  res.send('Job check triggered');
});

// Schedule polling for contacts every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('Polling ServiceM8 for new contacts...');
  checkNewContacts();
});

// Schedule polling for jobs every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('Polling ServiceM8 for new jobs...');
  checkNewJobs();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});