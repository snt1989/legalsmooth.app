const L = require('./_lib');

// 取り込み用: GET /api/import?k=<hash>&d=<base64url(JSON [{id,data}, ...])>
// 既にあるIDは上書きしない(画面で編集した内容を守る)。追加した件数を返す。
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!L.auth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    const raw = String((req.query && req.query.d) || '');
    if (!raw) { res.status(400).json({ error: 'no data' }); return; }
    const list = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(list)) { res.status(400).json({ error: 'bad data' }); return; }
    let added = 0, skipped = 0;
    await L.mutate('cases', (docs) => {
      added = 0; skipped = 0;
      for (const it of list) {
        if (!it || !it.id || typeof it.data !== 'object') continue;
        if (docs[it.id]) { skipped++; continue; }
        docs[it.id] = it.data; added++;
      }
    });
    res.status(200).json({ ok: true, added, skipped });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
