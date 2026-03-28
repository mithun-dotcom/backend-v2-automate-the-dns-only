const jobs = {};

function createJob(id, domains) {
  jobs[id] = {
    id, status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: domains.length,
    done: 0,
    domains: Object.fromEntries(domains.map(d => [d, { status: 'pending', message: 'Waiting...' }])),
    errors: [],
    listeners: []
  };
  return jobs[id];
}

function getJob(id) { return jobs[id] || null; }

function updateDomain(jobId, domain, update) {
  if (!jobs[jobId]) return;
  Object.assign(jobs[jobId].domains[domain], update);
  if (update.status === 'done' || update.status === 'partial' || update.status === 'error') {
    jobs[jobId].done++;
  }
  broadcast(jobId, { type: 'domain_update', domain, ...update });
}

function completeJob(jobId, status = 'completed') {
  if (!jobs[jobId]) return;
  jobs[jobId].status = status;
  jobs[jobId].completedAt = new Date().toISOString();
  broadcast(jobId, { type: 'job_complete', status, jobId });
  jobs[jobId].listeners.forEach(res => { try { res.end(); } catch(e){} });
  jobs[jobId].listeners = [];
}

function addError(jobId, error) {
  if (!jobs[jobId]) return;
  jobs[jobId].errors.push(error);
  broadcast(jobId, { type: 'error', error });
}

function addSSEListener(jobId, res) {
  if (!jobs[jobId]) return false;
  jobs[jobId].listeners.push(res);
  return true;
}

function removeSSEListener(jobId, res) {
  if (!jobs[jobId]) return;
  jobs[jobId].listeners = jobs[jobId].listeners.filter(l => l !== res);
}

function broadcast(jobId, data) {
  if (!jobs[jobId]) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  jobs[jobId].listeners.forEach(res => { try { res.write(payload); } catch(e){} });
}

module.exports = { createJob, getJob, updateDomain, completeJob, addError, addSSEListener, removeSSEListener };
