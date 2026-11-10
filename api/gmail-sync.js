const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { unzipSync } = require('fflate');
const L = require('./_lib');
const P = require('./_parse');

const MAXFILE = 4.4 * 1024 * 1024;
const PER_RUN = 6;

function authed(req) {
  const h = String(req.headers.authorization || '');
  const c = String(process.env.CRON_SECRET || '');
  if (c && h.length === ('Bearer ' + c).length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from('Bearer ' + c))) return true;
  return L.auth(req);
}

async function token() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN || '', grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Googleの認証に失敗: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}
async function gj(tk, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { authorization: 'Bearer ' + tk } });
  if (!r.ok) throw new Error('Gmail ' + r.status + ' ' + path.split('?')[0]);
  return r.json();
}
const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function walk(part, out) {
  if (!part) return out;
  const mt = String(part.mimeType || '');
  if (part.filename && part.body && part.body.attachmentId) out.files.push({ name: part.filename, id: part.body.attachmentId, size: part.body.size || 0, type: mt });
  else if (mt === 'text/plain' && part.body && part.body.data) out.text += b64(part.body.data).toString('utf8') + '\n';
  else if (mt === 'text/html' && part.body && part.body.data) out.html += b64(part.body.data).toString('utf8') + '\n';
  (part.parts || []).forEach((p) => walk(p, out));
  return out;
}
const stripHtml = (h) => h.replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hdr = (m, n) => ((m.payload.headers || []).find((h) => h.name.toLowerCase() === n) || {}).value || '';
const quoteCut = (t) => String(t).split(/\n\s*(?:From|差出人|-----Original|On .* wrote)\s*[:：]?/i)[0].replace(/\n{3,}/g, '\n\n').trim();

async function saveFile(name, buf, type) {
  const clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  const pathname = L.root() + '/files/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '/' + clean;
  await put(pathname, buf, { access: 'private', addRandomSuffix: false, contentType: type || 'application/octet-stream' });
  return { id: pathname, url: '/api/file?p=' + encodeURIComponent(pathname), name: clean };
}

// 添付を保存(zipは中身を取り出す。4.4MBを超えるものは保存せず名前だけ返す)
async function attachments(tk, mid, files) {
  const saved = [], skipped = [];
  for (const f of files) {
    if (/^image\//.test(f.type) && f.size < 8000) continue; // 署名のロゴなど
    try {
      const a = await gj(tk, 'messages/' + mid + '/attachments/' + f.id);
      const buf = b64(a.data);
      if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) {
        const z = unzipSync(new Uint8Array(buf));
        for (const k of Object.keys(z)) {
          if (k.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(k)) continue;
          const nm = k.split('/').pop();
          if (z[k].length > MAXFILE) { skipped.push(nm); continue; }
          saved.push(await saveFile(nm, Buffer.from(z[k]), ''));
        }
      } else if (buf.length > MAXFILE) skipped.push(f.name);
      else saved.push(await saveFile(f.name, buf, f.type));
    } catch (e) { skipped.push(f.name); }
  }
  return { saved, skipped };
}

function nextNo(docs, recv) {
  const ym = recv.slice(0, 7).replace('-', ''); let mx = 0;
  Object.keys(docs).forEach((k) => { const m = String(docs[k].caseNo || '').match(/^LS-(\d{6})-(\d+)$/); if (m && m[1] === ym) mx = Math.max(mx, +m[2]); });
  return 'LS-' + ym + '-' + String(mx + 1).padStart(3, '0');
}
const norm = (s) => P.z2h(s).replace(/^\s*((re|fw|fwd)\s*[:：]\s*)+/ig, '').replace(/\s+/g, '').toLowerCase();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!process.env.GOOGLE_REFRESH_TOKEN) { res.status(200).json({ ok: false, error: 'Googleの接続設定がまだです' }); return; }
  const t0 = Date.now();
  const sum = { registered: 0, linked: 0, skipped: 0, errors: 0, left: 0 };
  try {
    const tk = await token();
    const days = Math.min(Math.max(+(req.query && req.query.days) || 3, 1), 400);
    const label = String(process.env.GMAIL_LABEL || '100_業者別-リーガルスムーズ');
    let ids = [], pt = '';
    do {
      const q = 'label:' + label + ' newer_than:' + days + 'd';
      const j = await gj(tk, 'messages?maxResults=100&q=' + encodeURIComponent(q) + (pt ? '&pageToken=' + pt : ''));
      ids = ids.concat((j.messages || []).map((m) => m.id)); pt = j.nextPageToken || '';
    } while (pt && ids.length < 500);
    const log = (await L.readColl('mails')).docs;
    const todo = ids.filter((id) => !log[id] || log[id].state === 'error' && (log[id].tries || 0) < 3);
    sum.left = Math.max(0, todo.length - PER_RUN);
    for (const mid of todo.slice(0, PER_RUN)) {
      if (Date.now() - t0 > 40000) { sum.left = todo.length; break; }
      const entry = { state: 'skip', reason: '', caseIds: [], at: new Date().toISOString(), tries: ((log[mid] || {}).tries || 0) + 1 };
      try {
        const m = await gj(tk, 'messages/' + mid + '?format=full');
        const subject = hdr(m, 'subject'), from = hdr(m, 'from'), dateIso = new Date(+m.internalDate).toISOString();
        Object.assign(entry, { subject, from, date: dateIso, threadId: m.threadId });
        const w = walk(m.payload, { text: '', html: '', files: [] });
        const body = w.text || stripHtml(w.html);
        const url = 'https://mail.google.com/mail/u/0/#all/' + m.threadId;
        let target = null;
        if (P.isRequest(subject, body)) {
          const att = await attachments(tk, mid, w.files);
          const c = P.parseRequest(subject, body, dateIso);
          c.files = att.saved; att.saved.forEach((f) => { const k = P.guessDoc(f.name); if (k && !c.docs[k]) c.docs[k] = true; });
          if (att.skipped.length) c.memo += (c.memo ? '\n' : '') + '4.4MBを超えて保存できなかった添付: ' + att.skipped.join('、');
          c.mailId = mid; c.mailSubject = subject; c.threadId = m.threadId; c.mailUrl = url; c.updatedAt = new Date().toISOString(); c.updatedBy = 'メール自動取り込み';
          const id = 'gm' + mid; let made = false;
          await L.mutate('cases', (docs) => { made = false; if (docs[id]) return; c.caseNo = nextNo(docs, c.receivedDate); docs[id] = c; made = true; });
          entry.state = 'registered'; entry.caseIds = [id]; sum.registered += made ? 1 : 0;
        } else if (/^\s*(re|fw|fwd)\s*[:：]/i.test(P.z2h(subject)) || m.threadId !== mid) {
          const att = w.files.length ? await attachments(tk, mid, w.files) : { saved: [], skipped: [] };
          const sub = norm(subject); let hit = '';
          await L.mutate('cases', (docs) => {
            hit = '';
            const key = Object.keys(docs).find((k) => docs[k].threadId === m.threadId || docs[k].mailId === m.threadId) ||
              Object.keys(docs).find((k) => docs[k].source === 'gmail' && docs[k].mailSubject && norm(docs[k].mailSubject) === sub);
            if (!key) return;
            const c = docs[key]; c.thread = c.thread || [];
            if (c.thread.some((x) => x.mid === mid)) { hit = key; return; }
            c.thread.push({ mid, date: dateIso, from, subject, summary: quoteCut(body).slice(0, 300), url, files: att.saved.length, skipped: att.skipped.length });
            c.files = (c.files || []).concat(att.saved); c.unread = true; c.updatedAt = new Date().toISOString(); c.updatedBy = 'メール自動取り込み';
            hit = key;
          });
          if (hit) { entry.state = 'linked'; entry.caseIds = [hit]; sum.linked++; } else { entry.reason = '紐づく案件がありません'; sum.skipped++; }
        } else { entry.reason = '案件の依頼メールではありません'; sum.skipped++; }
      } catch (e) { entry.state = 'error'; entry.reason = String((e && e.message) || e).slice(0, 200); sum.errors++; }
      await L.mutate('mails', (docs) => { docs[mid] = entry; });
    }
    await L.mutate('meta', (docs) => { docs.sync = { at: new Date().toISOString(), ...sum, ok: true }; });
    res.status(200).json({ ok: true, ...sum });
  } catch (e) {
    try { await L.mutate('meta', (docs) => { docs.sync = { at: new Date().toISOString(), ok: false, error: String((e && e.message) || e).slice(0, 300) }; }); } catch (x) { /* noop */ }
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
