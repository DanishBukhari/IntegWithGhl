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

    // Step 1: Check if client exists in ServiceM8 by email
    const clientsResponse = await axios.get('https://api.servicem8.com/api_1.0/client.json', {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      },
      params: {
        '$filter': `email eq '${email}'`
      }
    });

    let clientUuid;
    const clients = clientsResponse.data;

    if (clients.length > 0) {
      // Client exists
      clientUuid = clients[0].uuid;
      console.log(`Client found: ${clientUuid}`);
    } else {
      // Step 2: Create a new client in ServiceM8
      const newClientResponse = await axios.post(
        'https://api.servicem8.com/api_1.0/client.json',
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

      clientUuid = newClientResponse.headers['x-record-uuid'];
      console.log(`Client created: ${clientUuid}`);
    }

    // Step 3: Create a job in ServiceM8
    const jobResponse = await axios.post(
      'https://api.servicem8.com/api_1.0/job.json',
      {
        company_uuid: clientUuid,
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

// Function to check invoice status and trigger GHL webhook
const checkInvoiceStatus = async () => {
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

      // Skip if already processed
      if (processedJobs.has(jobUuid)) {
        continue;
      }

      // Fetch invoices for the job
      const invoicesResponse = await axios.get('https://api.servicem8.com/api_1.0/invoice.json', {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        params: {
          '$filter': `job_uuid eq '${jobUuid}'`
        }
      });

      const invoices = invoicesResponse.data;

      if (invoices.length > 0) {
        const invoice = invoices[0];
        if (invoice.status === 'Paid') {
          // Invoice is paid, trigger GHL webhook (Workflow 2)
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
    }
  } catch (error) {
    console.error('Error checking invoice status:', error.response ? error.response.data : error.message);
  }
};

// Schedule polling every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Polling ServiceM8 for completed jobs and paid invoices...');
  checkInvoiceStatus();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});