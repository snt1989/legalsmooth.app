const crypto = require('crypto');
const { put, get } = require('@vercel/blob');

// ログイン済みか(パスコードのSHA-256を、ヘッダー x-auth またはクエリ k で受け取る)
exports.auth = function (req) {
  const h = String(req.headers['x-auth'] || (req.query && req.query.k) || '');
  const e = String(process.env.APP_PASSCODE_HASH || '');
  if (!e || h.length !== e.length) return false;
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(e));
};

// データの置き場所(推測されにくい先頭フォルダ)
exports.root = function () {
  return String(process.env.DATA_SECRET || 'data');
};

exports.clean = (c) => (/^[a-z0-9_-]{1,40}$/i.test(String(c || '')) ? String(c) : '');
const pathOf = (c) => exports.root() + '/' + c + '.json';

async function readColl(c) {
  const r = await get(pathOf(c), { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return { docs: {}, etag: '' };
  const text = await new Response(r.stream).text();
  let docs = {};
  try { docs = JSON.parse(text) || {}; } catch (e) { docs = {}; }
  return { docs, etag: r.blob.etag };
}

// ETag は「"abc"」「W/"abc"」「abc」のどれで来ても受け付けられるよう、順に試す
function etagVariants(e) {
  const bare = String(e).replace(/^W\//, '').replace(/^"|"$/g, '');
  const list = [String(e), bare, '"' + bare + '"'];
  return list.filter((v, i) => v && list.indexOf(v) === i);
}

// 読み込み → 変更 → 条件付きで書き込み(同時に保存されたら、やり直す)
async function mutate(c, fn) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    const cur = await readColl(c);
    fn(cur.docs);
    const body = JSON.stringify(cur.docs);
    const tags = cur.etag ? etagVariants(cur.etag) : [''];
    for (const tag of tags) {
      try {
        await put(pathOf(c), body, {
          access: 'private',
          addRandomSuffix: false,
          contentType: 'application/json',
          ...(tag ? { ifMatch: tag, allowOverwrite: true } : { allowOverwrite: false }),
        });
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 220));
  }
  throw lastErr;
}

exports.readColl = readColl;
exports.mutate = mutate;
