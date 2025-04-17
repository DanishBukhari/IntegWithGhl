const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');

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
const processedJobs = new Set();

// Endpoint for GHL to create a job in ServiceM8 (Workflow 1)
app.post('/ghl-create-job', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, jobDescription, ghlContactId } = req.body;

    // Validate request
    if (!firstName || !lastName || !email || !jobDescription || !ghlContactId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Step 1: Fetch all companies from ServiceM8
    const companiesResponse = await axios.get('https://api.servicem8.com/api_1.0/company.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      }
    });

    const companies = companiesResponse.data;
    console.log(`Fetched ${companies.length} companies from ServiceM8`);

    // Step 2: Search for a company with the matching email
    let companyUuid;
    const matchingCompany = companies.find(company => company.email && company.email.toLowerCase() === email.toLowerCase());

    if (matchingCompany) {
      // Client exists, reuse it and create a new job
      companyUuid = matchingCompany.uuid;
      console.log(`Client found: ${companyUuid} for email ${email}, phone: ${matchingCompany.mobile}`);
    } else {
      // Step 3: Create a new client in ServiceM8 with email and phone
      console.log(`Creating new client with name ${firstName} ${lastName}, email ${email}, phone ${phone}`);
      const newCompanyResponse = await axios.post(
        'https://api.servicem8.com/api_1.0/company.json',
        {
          name: `${firstName} ${lastName}`,
          first_name: firstName,
          last_name: lastName,
          email: email,
          phone: phone || '',
          
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
    }

    // Step 4: Create a job in ServiceM8
    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      {
        company_uuid: companyUuid,
        description: jobDescription ? `${jobDescription} (GHL Contact ID: ${ghlContactId})` : `(GHL Contact ID: ${ghlContactId})`,
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

// Function to check payment status and trigger GHL webhook
const checkPaymentStatus = async () => {
  try {
    // Fetch all jobs with status 'Completed'
    const jobsResponse = await axios.get('https://api.servicem8.com/api_1.0/job.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      },
      params: {
        '$filter': "status eq 'Completed'"
      }
    });

    const jobs = jobsResponse.data;

    for (const job of jobs) {
      const jobUuid = job.uuid;
      console.log(`Checking payments for job UUID: ${jobUuid}`);

      if (processedJobs.has(jobUuid)) {
        console.log(`Job ${jobUuid} already processed, skipping.`);
        continue;
      }

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
        const paymentDate = payment.date_paid || payment.payment_date || 'not available';
        console.log(`Payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${paymentDate}`);

        // Fetch the company details to get the email
        const companyResponse = await axios.get(`https://api.servicem8.com/api_1.0/company/${job.company_uuid}.json`, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          }
        });

        const company = companyResponse.data;
        const clientEmail = (company.email || company.company_email || '').trim().toLowerCase();
        console.log(`Fetched company email for job ${jobUuid}: ${clientEmail}`);

        // Extract GHL Contact ID from job description, with fallback
        let ghlContactId = '';
        if (job.description) {
          const ghlContactIdMatch = job.description.match(/GHL Contact ID: (\S+)/);
          ghlContactId = ghlContactIdMatch ? ghlContactIdMatch[1] : '';
        } else {
          console.log(`Job description is undefined for job ${jobUuid}, GHL Contact ID not found`);
        }

        // Trigger GHL webhook (Workflow 2)
        console.log(`Triggering GHL webhook for job ${jobUuid} with clientEmail: ${clientEmail} and ghlContactId: ${ghlContactId}`);
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
        processedJobs.add(jobUuid); // Mark as processed
      }
    }
  } catch (error) {
    console.error('Error checking payment status:', error.response ? error.response.data : error.message);
  }
};

// Temporary endpoint to manually trigger payment polling
app.get('/test-payment-check', async (req, res) => {
  await checkPaymentStatus();
  res.send('Payment check triggered');
});

// Schedule polling every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Polling ServiceM8 for completed jobs and paid payments...');
  checkPaymentStatus();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});