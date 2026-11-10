// リーガルスムーズからの依頼メールを、案件の項目に分解する(ルールベース。AIは使わない)
const PURPOSE = ['無断退去(夜逃げ)判断', '孤独死に伴う状況確認'];
const z2h = (s) => String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
const jstDate = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

function sections(body) {
  const out = {}; let key = '_head';
  String(body || '').replace(/\r/g, '').split('\n').forEach((ln) => {
    const m = /^\s*[●■◆▼]\s*(.+?)\s*$/.exec(ln);
    if (m) { key = m[1]; out[key] = out[key] || []; return; }
    (out[key] = out[key] || []).push(ln);
  });
  Object.keys(out).forEach((k) => { out[k] = out[k].join('\n').trim(); });
  return out;
}
const pick = (sec, re) => { const k = Object.keys(sec).find((x) => re.test(x)); return k ? sec[k] : ''; };

// 依頼メールか(返信・請求書・転送ではない)
function isRequest(subject, body) {
  const s = z2h(subject);
  if (/^\s*(re|fw|fwd)\s*[:：]/i.test(s)) return false;
  if (/請求|報酬|訂正版/.test(s)) return false;
  if (!/孤独死|無断退去|夜逃げ/.test(s)) return false;
  return /●\s*(管理会社|鍵)/.test(String(body || ''));
}

function parseRequest(subject, body, dateIso) {
  const sec = sections(body);
  const s = z2h(subject).replace(/^[\s　]+/, '');
  const unc = [];
  const purpose = /無断退去|夜逃げ/.test(s) ? PURPOSE[0] : PURPOSE[1];
  const place = /物件外/.test(s) ? '物件外' : /物件内/.test(s) ? '物件内' : '';
  let rest = s.replace(/孤独死|無断退去|夜逃げ|案件|[()（）]|物件内|物件外/g, ' ').replace(/\s+/g, ' ').trim();
  let name = '';
  const nm = /(\S+?)様/.exec(rest);
  if (nm) { name = nm[1]; rest = rest.replace(nm[0], ' ').replace(/\s+/g, ' ').trim(); }
  const toks = rest ? rest.split(' ') : [];
  // 管理会社ブロック
  const mgrLines = pick(sec, /管理会社/).split('\n').map((x) => x.trim()).filter(Boolean);
  const manager = mgrLines[0] || '';
  const mgrAddr = mgrLines.find((l, i) => i > 0 && /[都道府県市区町村]/.test(l) && !/^担当/.test(l)) || '';
  const phoneRe = /0\d{1,4}-\d{1,4}-\d{2,4}/;
  const phoneLine = mgrLines.find((l) => !/^担当/.test(l) && phoneRe.test(l)) || '';
  const managerPhone = (phoneRe.exec(phoneLine) || [''])[0];
  const personLine = mgrLines.find((l) => /^担当/.test(l)) || '';
  const managerPerson = personLine.replace(/^担当\s*[:：]?\s*/, '').trim();
  const pref = (/^(.{2,3}[都道府県])/.exec(mgrAddr) || ['', ''])[1];
  // 件名の残りトークン → 住所 / 物件名
  let address = '', prop = '', room = '';
  const hasAddr = (t) => /[都道府県市区町村郡]/.test(t);
  toks.forEach((t) => {
    if (!address && hasAddr(t)) address = t;
    else if (!prop) prop = t;
  });
  if (prop) { const m = /^(.*\D)(\d{1,4}|[A-Za-z]-?\d{1,4})$/.exec(prop); if (m && m[1].length >= 2) { prop = m[1]; room = m[2]; } }
  if (address && pref && !address.startsWith(pref)) address = pref + address;
  if (!name) unc.push('故人名が件名にない');
  if (!prop) unc.push('物件名・号室が件名にない');
  if (managerPhone && managerPhone.replace(/\D/g, '').length < 9) unc.push('電話番号が途中までの可能性(' + managerPhone + ')');
  const key = pick(sec, /^鍵/).split(/\n+/).map((x) => x.trim()).filter(Boolean).join(' ');
  const ym = /(?:居住|入居)年数\s*[:：]?\s*([^\n]+)/.exec(String(body || '')); const years = ym ? ym[1].trim() : '';
  const equip = pick(sec, /設備/).split('\n')[0].trim();
  const svc = pick(sec, /サービス/).split('\n')[0].trim();
  const extra = [pick(sec, /残置物/), pick(sec, /現地調査/), pick(sec, /^備考|その他/)].filter(Boolean).map((x) => x.replace(/\s*\n+\s*/g, ' ')).join(' / ');
  const recv = jstDate(dateIso);
  return {
    propertyName: prop || address, room, propKind: '集合住宅', contractor: name, tenant: '', purpose,
    manager, managerPerson, managerPhone, police: '', keyMethod: key, status: '依頼受付',
    receivedDate: recv, surveyDate: '', surveyTime: '', dueDate: addDays(recv, 7),
    utilElec: '', utilGas: '', utilWater: '', mailbox: '', nameplate: '', findings: '', neighbor: '',
    docs: {}, files: [], quote: '', amount: '', invoiceDate: '', assignee: '',
    address, services: svc, equipment: equip, residentYears: years, deathPlace: place,
    memo: [extra, equip ? '設備: ' + equip : '', unc.length ? '要確認: ' + unc.join(' / ') : ''].filter(Boolean).join('\n'),
    needsReview: true, source: 'gmail',
  };
}

// 書類の種類を、ファイル名から推測
function guessDoc(name) {
  const n = z2h(name);
  if (/賃貸借|契約書/.test(n)) return 'lease';
  if (/保証/.test(n)) return 'guarantee';
  if (/申込|申請/.test(n)) return 'apply';
  if (/状況確認|現状/.test(n)) return 'status';
  if (/死亡|診断書|検案/.test(n)) return 'death';
  return '';
}
module.exports = { isRequest, parseRequest, guessDoc, jstDate, addDays, z2h, PURPOSE };
