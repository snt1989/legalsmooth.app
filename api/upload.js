const { put } = require('@vercel/blob');
const L = require('./_lib');

const MAX = 4.4 * 1024 * 1024; // Vercel の関数は 4.5MB まで

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!L.auth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  try {
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX) { res.status(413).json({ error: 'too large' }); return; }
      chunks.push(ch);
    }
    const buf = Buffer.concat(chunks);
    const name = String((req.query && req.query.n) || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    const rand = Math.random().toString(36).slice(2, 8);
    const pathname = L.root() + '/files/' + Date.now() + '-' + rand + '/' + name;
    await put(pathname, buf, {
      access: 'private',
      addRandomSuffix: false,
      contentType: String(req.headers['content-type'] || 'application/octet-stream'),
    });
    res.status(200).json({ id: pathname, url: '/api/file?p=' + encodeURIComponent(pathname) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: false } };
