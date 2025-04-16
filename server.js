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
    const { firstName, lastName, email, phone, address, jobDescription } = req.body;

    // Validate request
    if (!firstName || !lastName || !email || !phone || !address || !jobDescription) {
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
      // Client exists
      companyUuid = matchingCompany.uuid;
      console.log(`Client found: ${companyUuid} for email ${email}`);
    } else {
      // Step 3: Create a new client in ServiceM8
      const newCompanyResponse = await axios.post(
        'https://api.servicem8.com/api_1.0/company.json',
        {
          first_name: firstName,
          last_name: lastName,
          email: email,
          mobile: phone,
          billing_address: address
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
      console.log(`Client created: ${companyUuid} for email ${email}`);
    }

    // Step 4: Create a job in ServiceM8
    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      {
        company_uuid: companyUuid,
        description: jobDescription,
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
        console.log(`Payment found for job ${jobUuid}: Amount ${payment.amount}, Date ${payment.payment_date}`);

        // Trigger GHL webhook (Workflow 2)
        await axios.post(
          GHL_WEBHOOK_URL,
          {
            jobUuid: jobUuid,
            clientEmail: job.company_email,
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

// Schedule polling every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Polling ServiceM8 for completed jobs and paid payments...');
  checkPaymentStatus();
});

app.get('/test-webhook', async (req, res) => {
  try {
    await axios.post(
      GHL_WEBHOOK_URL,
      {
        jobUuid: 'test-job-uuid-123',
        clientEmail: 'test@example.com',
        status: 'Invoice Paid'
      },
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.send('Test webhook sent to GHL');
  } catch (error) {
    console.error('Error sending test webhook:', error.response ? error.response.data : error.message);
    res.status(500).send('Failed to send test webhook');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});