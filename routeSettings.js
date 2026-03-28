const express = require('express');
const router = express.Router();
const store = require('./settingsStore');

router.get('/status', (req, res) => res.json({ configured: store.isConfigured() }));
router.get('/', (req, res) => res.json({ settings: store.getAll(), configured: store.isConfigured() }));
router.post('/', (req, res) => {
  store.setMany({ CLOUDFLARE_API_TOKEN: req.body.CLOUDFLARE_API_TOKEN });
  res.json({ success: true, settings: store.getAll(), configured: store.isConfigured() });
});

module.exports = router;
