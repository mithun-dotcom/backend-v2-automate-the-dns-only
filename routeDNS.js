const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const store = require('./settingsStore');
const { setupDNS } = require('./cloudflare');
const { createJob, getJob, updateDomain, completeJob, addError, addSSEListener, removeSSEListener } = require('./jobStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

function parseDomains(buffer) {
  const lines = buffer.toString().trim().split('\n').map(l => l.trim()).filter(Boolean);
  const hasHeader = lines[0].toLowerCase().replace(/"/g, '').includes('domain');
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const domains = dataLines
    .map(l => l.split(',')[0].replace(/"/g, '').trim().toLowerCase())
    .filter(d => d && d.includes('.') && d.includes('.'));
  if (domains.length === 0) throw new Error('No valid domains found in CSV');
  return [...new Set(domains)];
}

// POST /api/run
// Body is multipart: csv file + optional cnameHost + cnameTarget fields
router.post('/run', upload.single('csv'), async (req, res) => {
  if (!store.isConfigured()) {
    return res.status(400).json({ error: 'Cloudflare API token not configured. Go to Settings first.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  let domains;
  try {
    domains = parseDomains(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // CNAME options from form fields
  const cnameHost   = req.body.cnameHost   ? req.body.cnameHost.trim()   : null;
  const cnameTarget = req.body.cnameTarget ? req.body.cnameTarget.trim() : null;
  const cnameLabel  = req.body.cnameLabel  ? req.body.cnameLabel.trim()  : 'Custom';

  const jobId = uuidv4();
  createJob(jobId, domains);

  res.json({
    jobId,
    domains,
    total: domains.length,
    cname: cnameHost && cnameTarget ? { host: cnameHost, target: cnameTarget, label: cnameLabel } : null
  });

  runPipeline(jobId, domains, { cnameHost, cnameTarget }).catch(err => {
    addError(jobId, err.message);
    completeJob(jobId, 'failed');
  });
});

// GET /api/progress/:jobId
router.get('/progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'init', job: { ...job, listeners: undefined } })}\n\n`);
  addSSEListener(req.params.jobId, res);
  req.on('close', () => removeSSEListener(req.params.jobId, res));
});

// GET /api/results/:jobId
router.get('/results/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: job.id, status: job.status,
    startedAt: job.startedAt, completedAt: job.completedAt,
    total: job.total, done: job.done,
    domains: job.domains, errors: job.errors
  });
});

async function runPipeline(jobId, domains, options) {
  for (const domain of domains) {
    updateDomain(jobId, domain, { status: 'running', message: 'Setting up DNS records...' });
    try {
      const result = await setupDNS(domain, options);
      const created = result.records.filter(r => r.success && !r.skipped).length;
      const skipped = result.records.filter(r => r.skipped).length;
      const failed  = result.records.filter(r => !r.success);

      updateDomain(jobId, domain, {
        status: failed.length === 0 ? 'done' : 'partial',
        message: failed.length === 0
          ? `${created} records created, ${skipped} already existed`
          : `${created} created — ${failed.length} failed`,
        records: result.records
      });

      for (const f of failed) {
        addError(jobId, `[${domain}] ${f.type}: ${f.error}`);
      }
    } catch (err) {
      updateDomain(jobId, domain, { status: 'error', message: err.message });
      addError(jobId, `[${domain}] ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 800));
  }
  completeJob(jobId, 'completed');
}

module.exports = router;
