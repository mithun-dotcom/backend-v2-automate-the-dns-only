const settings = {
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
};

function get(key) { return settings[key] || ''; }

function getAll() {
  return {
    CLOUDFLARE_API_TOKEN: settings.CLOUDFLARE_API_TOKEN
      ? '••••••' + settings.CLOUDFLARE_API_TOKEN.slice(-4)
      : '',
  };
}

function setMany(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (key in settings && value) settings[key] = value;
  }
}

function isConfigured() {
  return !!settings.CLOUDFLARE_API_TOKEN;
}

module.exports = { get, getAll, setMany, isConfigured };
