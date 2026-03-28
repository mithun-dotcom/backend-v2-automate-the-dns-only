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
    throw new Error(`"${domain}" not found in your Cloudflare account. Add it to Cloudflare first.`);
  }
  return zones[0].id;
}

async function addRecord(zoneId, record) {
  try {
    const res = await axios.post(`${CF_BASE}/zones/${zoneId}/dns_records`, record, { headers: headers() });
    return { success: true, skipped: false, type: record.type, name: record.name, content: record.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (msg.toLowerCase().includes('already exists')) {
      return { success: true, skipped: true, type: record.type, name: record.name, content: record.content };
    }
    return { success: false, error: msg, type: record.type, name: record.name };
  }
}

async function setupPageRedirect(zoneId, domain) {
  try {
    await axios.post(
      `${CF_BASE}/zones/${zoneId}/rulesets`,
      {
        name: `Redirect ${domain} to www`,
        kind: 'zone',
        phase: 'http_request_redirect',
        rules: [{
          action: 'redirect',
          action_parameters: {
            from_value: {
              status_code: 301,
              target_url: { expression: `concat("https://www.${domain}", http.request.uri.path)` },
              preserve_query_string: true
            }
          },
          expression: `(http.host eq "${domain}")`,
          description: `Redirect ${domain} to www.${domain}`,
          enabled: true
        }]
      },
      { headers: headers() }
    );
    return { success: true, skipped: false, type: 'REDIRECT', name: domain, content: `→ www.${domain} (301)` };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (msg.includes('already exists') || msg.includes('duplicate')) {
      return { success: true, skipped: true, type: 'REDIRECT', name: domain, content: `→ www.${domain} (301)` };
    }
    return { success: false, error: msg, type: 'REDIRECT', name: domain };
  }
}

/**
 * Main DNS setup function
 * @param {string} domain - e.g. "example.com"
 * @param {object} options
 * @param {string} options.cnameHost   - subdomain for CNAME e.g. "em1234" or "tracking"
 * @param {string} options.cnameTarget - CNAME target value e.g. "u12345678.wl.sendgrid.net"
 */
async function setupDNS(domain, options = {}) {
  const results = [];
  const zoneId = await getZoneId(domain);

  // ── MX Records ──────────────────────────────────────────────
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

  // ── SPF ─────────────────────────────────────────────────────
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: domain,
    content: 'v=spf1 include:_spf.google.com ~all',
    ttl: 3600
  }));

  // ── DMARC ───────────────────────────────────────────────────
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: `_dmarc.${domain}`,
    content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; fo=1`,
    ttl: 3600
  }));

  // ── DKIM placeholder ────────────────────────────────────────
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: `google._domainkey.${domain}`,
    content: 'v=DKIM1; k=rsa; p=REPLACE_WITH_YOUR_DKIM_KEY',
    ttl: 3600
  }));

  // ── www CNAME ───────────────────────────────────────────────
  results.push(await addRecord(zoneId, {
    type: 'CNAME', name: 'www', content: domain, ttl: 3600, proxied: true
  }));

  // ── Domain redirect: naked → www ────────────────────────────
  results.push(await setupPageRedirect(zoneId, domain));

  // ── Custom CNAME (Instantly / Smartlead / etc.) ─────────────
  if (options.cnameHost && options.cnameTarget) {
    results.push(await addRecord(zoneId, {
      type: 'CNAME',
      name: options.cnameHost,
      content: options.cnameTarget,
      ttl: 3600,
      proxied: false
    }));
  }

  const allSuccess = results.every(r => r.success);
  return { domain, records: results, allSuccess };
}

module.exports = { setupDNS };
