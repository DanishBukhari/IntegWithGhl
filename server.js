const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs');
const fsPromises = require('fs').promises;
const moment = require('moment-timezone');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');

dotenv.config();

const app = express();
app.use(express.json());

// Configure multer for file uploads
const upload = multer({ dest: 'Uploads/' });

const SERVICE_M8_USERNAME = process.env.SERVICE_M8_USERNAME;
const SERVICE_M8_PASSWORD = process.env.SERVICE_M8_PASSWORD;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'Uploads');
fsPromises.mkdir(UPLOADS_DIR, { recursive: true }).catch((error) => {
  console.error('Error creating uploads directory:', error.message);
});

// Axios instance for ServiceM8
const serviceM8Api = axios.create({
  baseURL: 'https://api.servicem8.com/api_1.0',
  headers: { Accept: 'application/json' },
  auth: {
    username: SERVICE_M8_USERNAME,
    password: SERVICE_M8_PASSWORD,
  },
});

// Axios instance for GHL
const ghlApi = axios.create({
  baseURL: 'https://rest.gohighlevel.com/v1',
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Accept: 'application/json',
  },
});

// Store processed UUIDs and queue UUID
let processedJobs = new Set();
let processedContacts = new Set();
let quotesNewQueueUuid = null;
const STATE_FILE = 'state.json';
const processedGhlContactIds = new Map();

// Load polling state
async function loadState() {
  try {
    const data = await fsPromises.readFile(STATE_FILE, 'utf8');
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
  await fsPromises.writeFile(
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
    const response = await serviceM8Api.get('/queue.json');
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

// Check new ServiceM8 contacts and sync to GHL
const checkNewContacts = async () => {
  try {
    console.log('Polling ServiceM8 for new contacts...');
    const lastPollTimestamp = await loadState();
    const currentTimestamp = Date.now();

    const accountTimezone = 'Australia/Brisbane';
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
          const searchResponse = await ghlApi.get('/contacts/', {
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
        const ghlContactResponse = await ghlApi.post('/contacts/', {
          firstName: first || '',
          lastName: last || '',
          name: contactName,
          email: email || '',
          phone: phone || mobile || '',
          address1: addressDetails.address1,
          city: addressDetails.city,
          state: addressDetails.state,
          postalCode: addressDetails.postalCode,
          source: 'ServiceM8 Integration',
        });

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
    const accountTimezone = 'Australia/Brisbane';
    const now = moment().tz(accountTimezone);
    const twentyMinutesAgo = now.clone().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    const targetDate = moment('2025-05-24').tz(accountTimezone).startOf('day').format('YYYY-MM-DDTHH:mm:ss');
    console.log(`Checking payments edited after ${twentyMinutesAgo} for jobs completed on or after ${targetDate}`);

    // Step 1: Fetch payments edited in the last 20 minutes
    const paymentFilter = `$filter=edit_date gt '${twentyMinutesAgo}'`;
    const paymentsResponse = await serviceM8Api.get(`/jobpayment.json?${paymentFilter}`);
    const payments = paymentsResponse.data;
    console.log(`Fetched ${payments.length} payments edited in the last 20 minutes`);

    for (const payment of payments) {
      const paymentUuid = payment.uuid;
      const jobUuid = payment.job_uuid;

      // Step 2: Skip if payment already processed
      if (processedJobs.has(paymentUuid)) {
        console.log(`Payment ${paymentUuid} already processed, skipping.`);
        continue;
      }

      // Step 3: Fetch job activities to determine completion date
      let maxEndDate = null;
      try {
        const jobActivitiesResponse = await serviceM8Api.get(`/jobactivity.json?$filter=job_uuid eq '${jobUuid}'`);
        const jobActivities = jobActivitiesResponse.data;
        for (const activity of jobActivities) {
          if (activity.end_date && (!maxEndDate || moment(activity.end_date).tz(accountTimezone).isAfter(moment(maxEndDate).tz(accountTimezone)))) {
            maxEndDate = activity.end_date;
          }
        }
      } catch (error) {
        console.error(`Error fetching job activities for job ${jobUuid}:`, error.response ? error.response.data : error.message);
        continue;
      }

      // Step 4: Check if job was completed on or after May 24, 2025
      if (!maxEndDate || !moment(maxEndDate).tz(accountTimezone).isSameOrAfter(targetDate)) {
        console.log(`Payment ${paymentUuid} belongs to job ${jobUuid} not completed on or after May 24, 2025, skipping.`);
        continue;
      }

      // Step 5: Fetch job for GHL Contact ID and company_uuid
      let job;
      try {
        const jobResponse = await serviceM8Api.get(`/job.json?$filter=uuid eq '${jobUuid}'`);
        job = jobResponse.data[0];
      } catch (error) {
        console.error(`Error fetching job ${jobUuid}:`, error.response ? error.response.data : error.message);
        continue;
      }
      if (!job) {
        console.log(`No job found for job_uuid ${jobUuid}, skipping payment ${paymentUuid}`);
        continue;
      }
      let ghlContactId = '';
      if (job.job_description) {
        const ghlContactIdMatch = job.job_description.match(/GHL Contact ID: ([a-zA-Z0-9]+)/);
        ghlContactId = ghlContactIdMatch ? ghlContactIdMatch[1] : '';
      }
      const companyUuid = job.company_uuid;
      if (!companyUuid) {
        console.log(`No company_uuid for job ${jobUuid}, skipping payment ${paymentUuid}`);
        continue;
      }

      // Step 6: Fetch company contact
      let clientEmail = '';
      try {
        const companyResponse = await serviceM8Api.get('/companycontact.json', {
          params: { '$filter': `company_uuid eq '${companyUuid}'` },
        });
        const company = companyResponse.data;
        const primaryContact = company.find(c => c.email) || {};
        clientEmail = (primaryContact.email || '').trim().toLowerCase();
        console.log(`Extracted client email: ${clientEmail}`);
      } catch (error) {
        console.error(`Error fetching contact for company ${companyUuid}:`, error.response ? error.response.data : error.message);
      }

      // Step 7: Check if contact already triggered
      const contactKey = ghlContactId || clientEmail;
      if (contactKey && processedContacts.has(contactKey)) {
        console.log(`Contact ${contactKey} already triggered, skipping payment ${paymentUuid}`);
        continue;
      }

      // Step 8: Check if payment is paid and recent
      if (
        payment.active === 1 &&
        payment.amount > 0 &&
        moment(payment.edit_date).tz(accountTimezone).isAfter(twentyMinutesAgo)
      ) {
        console.log(`Recent paid payment found: UUID ${paymentUuid}, Amount ${payment.amount}, Job UUID ${jobUuid}, Edit Date ${payment.edit_date}`);
        const webhookPayload = {
          paymentUuid: paymentUuid,
          jobUuid: jobUuid,
          clientEmail: clientEmail || '',
          ghlContactId: ghlContactId,
          status: 'Invoice Paid',
        };
        try {
          const webhookResponse = await axios.post(GHL_WEBHOOK_URL, webhookPayload, {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
            },
          });
          console.log(
            `GHL webhook response for payment ${paymentUuid}: ${webhookResponse.status} ${JSON.stringify(webhookResponse.data)}`
          );
          processedJobs.add(paymentUuid);
          if (contactKey) processedContacts.add(contactKey);
        } catch (webhookError) {
          console.error(
            `Failed to trigger GHL webhook for payment ${paymentUuid}:`,
            webhookError.response ? webhookError.response.data : webhookError.message
          );
        }
      } else {
        console.log(`Payment ${paymentUuid} is not paid or not recent, skipping. Details:`, {
          active: payment.active,
          amount: payment.amount,
          edit_date: payment.edit_date,
        });
      }
    }

    // Step 9: Save state
    await saveState(Date.now());
  } catch (error) {
    console.error('Error checking payment status:', error.response ? error.response.data : error.message);
  }
};

// Endpoint for GHL to create a job in ServiceM8
app.post('/ghl-create-job', upload.array('photos'), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, jobDescription, ghlContactId } = req.body;

    if (!firstName || !lastName || !email || !ghlContactId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Deduplicate based on ghlContactId
    const now = Date.now();
    const lastProcessed = processedGhlContactIds.get(ghlContactId);
    if (lastProcessed && now - lastProcessed < 5000) {
      console.log(`Duplicate job creation attempt for ghlContactId ${ghlContactId}, skipping`);
      return res.status(200).json({ message: 'Job creation skipped (duplicate request)' });
    }
    processedGhlContactIds.set(ghlContactId, now);

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

      await serviceM8Api.post('/companycontact.json', {
        company_uuid: companyUuid,
        first: firstName,
        lastName: lastName,
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
      job_description: `GHL Contact ID: ${ghlContactId}\n${jobDescription || ''}`,
    };

    const jobResponse = await serviceM8Api.post('/job.json', jobData);
    const jobUuid = jobResponse.headers['x-record-uuid'];
    console.log(`Job created: ${jobUuid} in queue ${queueUuid}`);

    // Fetch images from GHL /contacts/{id} with fallbacks
    let photoData = [];
    try {
      const contactResponse = await ghlApi.get(`/contacts/${ghlContactId}`);
      const contact = contactResponse.data.contact;
      console.log(`GHL contact data: ${JSON.stringify(contact, null, 2)}`);

      if (contact.customField) {
        for (const field of contact.customField) {
          if (field.value && typeof field.value === 'object' && !Array.isArray(field.value)) {
            for (const [uuid, entry] of Object.entries(field.value)) {
              if (
                entry.url &&
                entry.meta &&
                entry.meta.mimetype &&
                entry.meta.mimetype.match(/image\/(png|jpeg|jpg)/i)
              ) {
                photoData.push({
                  url: entry.url,
                  documentId: entry.documentId,
                  filename: entry.meta.originalname || `photo-${uuid}-${Date.now()}`,
                  mimetype: entry.meta.mimetype,
                });
              }
            }
          }
        }
      } else {
        console.log(`No customField found in GHL contact ${ghlContactId}. Available properties: ${Object.keys(contact)}`);
      }

      if (photoData.length === 0) {
        try {
          const attachmentsResponse = await ghlApi.get(`/contacts/${ghlContactId}/attachments`);
          const attachments = attachmentsResponse.data.attachments || [];
          console.log(`Fetched ${attachments.length} attachments from GHL contact ${ghlContactId}`);

          for (const attachment of attachments) {
            if (
              attachment.url &&
              attachment.mimetype &&
              attachment.mimetype.match(/image\/(png|jpeg|jpg)/i)
            ) {
              photoData.push({
                url: attachment.url,
                documentId: attachment.documentId || attachment.url.split('/').pop(),
                filename: attachment.filename || `attachment-${Date.now()}.png`,
                mimetype: attachment.mimetype,
              });
            }
          }
        } catch (attachmentError) {
          console.log('Attachments endpoint not available or failed:', attachmentError.response ? attachmentError.response.data : attachmentError.message);
        }
      }

      console.log(`Fetched ${photoData.length} photos from GHL contact ${ghlContactId}:`, photoData.map(p => p.url));
    } catch (error) {
      console.error(
        'Error fetching GHL contact images:',
        error.response ? error.response.data : error.message
      );
    }

    // Download and upload images to ServiceM8 as notes
    for (const photo of photoData) {
      const { url: photoUrl, documentId, filename, mimetype } = photo;
      let tempPath;

      try {
        tempPath = path.join(UPLOADS_DIR, filename);
        let downloadResponse;

        try {
          downloadResponse = await axios.get(`https://services.leadconnectorhq.com/documents/download/${documentId}`, {
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
            },
            responseType: 'stream',
          });
        } catch (primaryError) {
          console.log(`Primary download failed for ${photoUrl}:`, primaryError.response ? primaryError.response.data : primaryError.message);
          try {
            downloadResponse = await axios.get(photoUrl, {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
              },
              responseType: 'stream',
            });
          } catch (fallbackError) {
            console.error(`Fallback download failed for ${photoUrl}:`, fallbackError.response ? fallbackError.response.data : fallbackError.message);
            continue;
          }
        }

        const contentType = downloadResponse.headers['content-type'] || '';
        if (!contentType.match(/image\/(png|jpeg|jpg)/i)) {
          console.log(`Skipping non-image URL ${photoUrl}: Content-Type ${contentType}`);
          continue;
        }

        const writer = fs.createWriteStream(tempPath);
        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        const stats = await fsPromises.stat(tempPath);
        console.log(`Downloaded image to ${tempPath}, size: ${stats.size} bytes`);
        if (stats.size === 0) {
          console.error(`Downloaded file ${tempPath} is empty`);
          continue;
        }

        try {
          await fsPromises.access(tempPath, fs.constants.R_OK);
        } catch (error) {
          console.error(`File ${tempPath} is not accessible:`, error.message);
          continue;
        }

        const uploadNote = async (attempt = 1) => {
          try {
            const noteForm = new FormData();
            noteForm.append('related_object', 'job');
            noteForm.append('related_object_uuid', jobUuid);
            noteForm.append('body', `Image from GHL: ${filename}`);
            noteForm.append('attachment', fs.createReadStream(tempPath), { filename, contentType: mimetype });

            const noteResponse = await serviceM8Api.post('/note.json', noteForm, {
              headers: noteForm.getHeaders(),
            });

            console.log(
              `Note with image added to job ${jobUuid} from URL ${photoUrl}, note UUID: ${
                noteResponse.headers['x-record-uuid']
              }`
            );
          } catch (error) {
            console.error(
              `Attempt ${attempt} failed to upload note for ${photoUrl}:`,
              error.response ? error.response.data : error.message
            );
            if (attempt < 2) {
              console.log(`Retrying note upload for ${photoUrl}...`);
              await uploadNote(attempt + 1);
            } else {
              throw error;
            }
          }
        };
        await uploadNote();

        const uploadCompanyAttachment = async (attempt = 1) => {
          try {
            const companyForm = new FormData();
            companyForm.append('related_object', 'company');
            companyForm.append('related_object_uuid', companyUuid);
            companyForm.append('attachment_name', filename);
            companyForm.append('file_type', mimetype);
            companyForm.append('attachment', fs.createReadStream(tempPath), { filename, contentType: mimetype });

            const companyAttachmentResponse = await serviceM8Api.post('/Attachment.json', companyForm, {
              headers: {
                ...companyForm.getHeaders(),
                'Content-Type': `multipart/form-data; boundary=${companyForm.getBoundary()}`,
              },
            });

            console.log(
              `Image added to company ${companyUuid} from URL ${photoUrl}, attachment UUID: ${
                companyAttachmentResponse.headers['x-record-uuid']
              }`
            );
          } catch (error) {
            console.error(
              `Attempt ${attempt} failed to upload company attachment for ${photoUrl}:`,
              error.response ? error.response.data : error.message
            );
            if (attempt < 2) {
              console.log(`Retrying company attachment upload for ${photoUrl}...`);
              await uploadCompanyAttachment(attempt + 1);
            } else {
              throw error;
            }
          }
        };
        await uploadCompanyAttachment();

      } catch (error) {
        console.error(
          `Error processing photo ${filename} from URL ${photoUrl}:`,
          error.response ? error.response.data : error.message
        );
      } finally {
        if (tempPath) {
          try {
            await fsPromises.unlink(tempPath);
            console.log(`Cleaned up temporary file ${tempPath}`);
          } catch (error) {
            console.error(`Error cleaning up ${tempPath}:`, error.message);
          }
        }
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