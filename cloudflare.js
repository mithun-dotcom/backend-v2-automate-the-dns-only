const axios = require('axios');
const store = require('./settingsStore');

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function headers() {
  return {
    Authorization: `Bearer ${store.get('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json'
  };
}

async function getZoneId(domain) {
  const res = await axios.get(`${CF_BASE}/zones`, {
    headers: headers(),
    params: { name: domain }
  });
  const zones = res.data.result;
  if (!zones || zones.length === 0) {
    throw new Error(`"${domain}" not found in Cloudflare. Add it first.`);
  }
  return zones[0].id;
}

// ── Fetch all existing DNS records for a zone ──────────────────────────────
async function getExistingRecords(zoneId) {
  try {
    const res = await axios.get(`${CF_BASE}/zones/${zoneId}/dns_records`, {
      headers: headers(),
      params: { per_page: 500 }
    });
    return res.data.result || [];
  } catch (err) {
    return [];
  }
}

// ── Delete a DNS record by ID ──────────────────────────────────────────────
async function deleteRecord(zoneId, recordId, recordInfo) {
  try {
    await axios.delete(`${CF_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
      headers: headers()
    });
    return { success: true, deleted: true, type: recordInfo.type, name: recordInfo.name, content: recordInfo.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    return { success: false, error: msg, type: recordInfo.type, name: recordInfo.name };
  }
}

// ── Delete all existing records of a given type+name ──────────────────────
// Cloudflare returns full FQDN names (e.g. "www.example.com"), so we match both
// the full FQDN and the bare label to be safe.
async function deleteExisting(zoneId, type, name, existingRecords) {
  const nameLower = name.toLowerCase();
  const matches = existingRecords.filter(r => {
    if (r.type !== type) return false;
    const rName = r.name.toLowerCase();
    return rName === nameLower || rName === nameLower + '.';
  });
  const deleted = [];
  for (const r of matches) {
    const result = await deleteRecord(zoneId, r.id, { type: r.type, name: r.name, content: r.content });
    deleted.push(result);
  }
  return deleted;
}

// ── Fetch all existing Page Rules ──────────────────────────────────────────
async function getExistingPageRules(zoneId) {
  try {
    const res = await axios.get(`${CF_BASE}/zones/${zoneId}/pagerules`, {
      headers: headers(),
      params: { status: 'active' }
    });
    return res.data.result || [];
  } catch (err) {
    return [];
  }
}

// ── Delete existing Page Rules that match this domain ──────────────────────
async function deleteExistingPageRules(zoneId, domain) {
  const rules = await getExistingPageRules(zoneId);
  const domainLower = domain.toLowerCase();
  const matching = rules.filter(r => {
    const urlVal = r.targets?.[0]?.constraint?.value || '';
    return urlVal.toLowerCase().includes(domainLower);
  });
  for (const rule of matching) {
    try {
      await axios.delete(`${CF_BASE}/zones/${zoneId}/pagerules/${rule.id}`, { headers: headers() });
    } catch (err) {
      // ignore delete errors on old rules
    }
  }
}

// ── Add a single DNS record ────────────────────────────────────────────────
async function addRecord(zoneId, record) {
  try {
    await axios.post(`${CF_BASE}/zones/${zoneId}/dns_records`, record, { headers: headers() });
    return { success: true, skipped: false, type: record.type, name: record.name, content: record.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    return { success: false, error: msg, type: record.type, name: record.name };
  }
}

// ── Page redirect via Page Rules ───────────────────────────────────────────
async function setupPageRedirect(zoneId, domain, forwardTarget) {
  try {
    // Delete any existing page rules for this domain first to avoid duplicates
    await deleteExistingPageRules(zoneId, domain);

    await axios.post(
      `${CF_BASE}/zones/${zoneId}/pagerules`,
      {
        targets: [{ target: 'url', constraint: { operator: 'matches', value: `${domain}/*` } }],
        actions: [{ id: 'forwarding_url', value: { url: `${forwardTarget}/$1`, status_code: 301 } }],
        status: 'active',
        priority: 1
      },
      { headers: headers() }
    );
    return { success: true, skipped: false, type: 'REDIRECT', name: domain, content: `-> ${forwardTarget} (301)` };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    // If it's a permission issue, report it clearly as a failure (not silent skip)
    if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('not allowed') || msg.toLowerCase().includes('forbidden')) {
      return { success: false, error: 'Page Rules permission missing — add "Zone > Page Rules > Edit" to your Cloudflare API token.', type: 'REDIRECT', name: domain };
    }
    return { success: false, error: msg, type: 'REDIRECT', name: domain };
  }
}

// ── Main DNS setup ─────────────────────────────────────────────────────────
async function setupDNS(domain, options = {}) {
  const results = [];
  const deletedResults = [];
  const forwardTarget = options.forwardUrl || `https://www.${domain}`;
  const zoneId = await getZoneId(domain);

  // Fetch ALL existing DNS records once upfront
  const existing = await getExistingRecords(zoneId);

  // ── Delete old records before adding fresh ones ──────────────────────────

  // MX records
  const delMX = await deleteExisting(zoneId, 'MX', domain, existing);
  deletedResults.push(...delMX);

  // SPF (root TXT containing v=spf1)
  const rootTXTs = existing.filter(r =>
    r.type === 'TXT' &&
    r.name.toLowerCase() === domain.toLowerCase()
  );
  for (const r of rootTXTs) {
    if (r.content.toLowerCase().includes('v=spf1')) {
      const del = await deleteRecord(zoneId, r.id, { type: 'TXT', name: r.name, content: r.content });
      deletedResults.push({ ...del, label: 'SPF (old)' });
    }
  }

  // DMARC
  const dmarcName = `_dmarc.${domain}`;
  const delDMARC = await deleteExisting(zoneId, 'TXT', dmarcName, existing);
  deletedResults.push(...delDMARC.map(d => ({ ...d, label: 'DMARC (old)' })));

  // www CNAME (Cloudflare stores as full FQDN)
  const delWWW = await deleteExisting(zoneId, 'CNAME', `www.${domain}`, existing);
  deletedResults.push(...delWWW.map(d => ({ ...d, label: 'www CNAME (old)' })));

  // DKIM placeholder cleanup — ONLY delete the sample/placeholder record,
  // never touch a real DKIM key that was manually set
  const dkimName = `google._domainkey.${domain}`;
  const dkimRecords = existing.filter(r =>
    r.type === 'TXT' &&
    r.name.toLowerCase() === dkimName.toLowerCase()
  );
  for (const r of dkimRecords) {
    if (r.content.includes('REPLACE_WITH_YOUR_DKIM_KEY')) {
      const del = await deleteRecord(zoneId, r.id, { type: 'TXT', name: r.name, content: r.content });
      deletedResults.push({ ...del, label: 'DKIM placeholder (old)' });
    }
    // Real DKIM records (containing actual key data) are left untouched
  }

  // Custom CNAME if provided
  if (options.cnameHost) {
    const customCnameName = `${options.cnameHost}.${domain}`;
    const delCustom = await deleteExisting(zoneId, 'CNAME', customCnameName, existing);
    deletedResults.push(...delCustom.map(d => ({ ...d, label: 'Custom CNAME (old)' })));
  }

  // ── Add fresh records ────────────────────────────────────────────────────

  // MX Records (5 Google MX servers)
  const mxList = [
    { priority: 1,  content: 'aspmx.l.google.com' },
    { priority: 5,  content: 'alt1.aspmx.l.google.com' },
    { priority: 5,  content: 'alt2.aspmx.l.google.com' },
    { priority: 10, content: 'alt3.aspmx.l.google.com' },
    { priority: 10, content: 'alt4.aspmx.l.google.com' },
  ];
  for (const mx of mxList) {
    results.push(await addRecord(zoneId, {
      type: 'MX', name: domain, content: mx.content, priority: mx.priority, ttl: 3600
    }));
  }

  // SPF
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: domain,
    content: 'v=spf1 include:_spf.google.com ~all',
    ttl: 3600
  }));

  // DMARC
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: `_dmarc.${domain}`,
    content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; fo=1`,
    ttl: 3600
  }));

  // www CNAME
  results.push(await addRecord(zoneId, {
    type: 'CNAME', name: 'www', content: domain, ttl: 3600, proxied: true
  }));

  // Domain redirect (Page Rule)
  results.push(await setupPageRedirect(zoneId, domain, forwardTarget));

  // Custom CNAME
  if (options.cnameHost && options.cnameTarget) {
    results.push(await addRecord(zoneId, {
      type: 'CNAME', name: options.cnameHost, content: options.cnameTarget, ttl: 3600, proxied: false
    }));
  }

  const allSuccess = results.every(r => r.success);
  return { domain, records: results, deleted: deletedResults, allSuccess };
}

module.exports = { setupDNS };
