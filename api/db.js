const L = require('./_lib');

const clean = L.clean;
const { readColl, mutate } = L;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!L.auth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    if (req.method === 'GET') {
      const c = clean(req.query && req.query.c);
      if (!c) { res.status(200).json({ ok: true }); return; }
      const cur = await readColl(c);
      res.status(200).json({ docs: cur.docs });
      return;
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const c = clean(b.c);
      const id = String(b.id || '');
      if (!c || !id) { res.status(400).json({ error: 'bad request' }); return; }
      await mutate(c, (docs) => {
        if (b.del) delete docs[id];
        else docs[id] = b.data;
      });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
