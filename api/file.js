const { get } = require('@vercel/blob');
const { Readable } = require('stream');
const L = require('./_lib');

module.exports = async function handler(req, res) {
  if (!L.auth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  const p = String((req.query && req.query.p) || '');
  if (!p.startsWith(L.root() + '/files/') || p.includes('..')) { res.status(400).json({ error: 'bad request' }); return; }
  try {
    const r = await get(p, { access: 'private' });
    if (!r || r.statusCode !== 200) { res.status(404).json({ error: 'not found' }); return; }
    const name = p.split('/').pop();
    res.setHeader('Content-Type', r.blob.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', (req.query.d ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name));
    res.setHeader('Cache-Control', 'private, max-age=300');
    Readable.fromWeb(r.stream).pipe(res);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
