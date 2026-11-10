const crypto = require('crypto');

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
