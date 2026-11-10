const { put, get } = require('@vercel/blob');
const L = require('./_lib');

const clean = (c) => (/^[a-z0-9_-]{1,40}$/i.test(String(c || '')) ? String(c) : '');
const pathOf = (c) => L.root() + '/' + c + '.json';

async function readColl(c) {
  const r = await get(pathOf(c), { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return { docs: {}, etag: '' };
  const text = await new Response(r.stream).text();
  let docs = {};
  try { docs = JSON.parse(text) || {}; } catch (e) { docs = {}; }
  return { docs, etag: r.blob.etag };
}

// 読み込み → 変更 → 条件付きで書き込み(同時に保存されたら、やり直す)
async function mutate(c, fn) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    const cur = await readColl(c);
    fn(cur.docs);
    try {
      await put(pathOf(c), JSON.stringify(cur.docs), {
        access: 'private',
        addRandomSuffix: false,
        contentType: 'application/json',
        ...(cur.etag ? { ifMatch: cur.etag } : { allowOverwrite: false }),
      });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 220));
    }
  }
  throw lastErr;
}

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
