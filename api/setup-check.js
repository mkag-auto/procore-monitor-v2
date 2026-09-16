// api/setup-check.js — plain-language configuration check (shows no secrets)
const { storeCheck, storeType } = require('./_procore');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = n => !!(process.env[n] && process.env[n].trim());

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const expected = `https://${host}/api/callback`;
  const redirect = (process.env.PROCORE_REDIRECT_URI || '').trim();
  const type = storeType();
  const db = type ? await storeCheck() : { ok: false, detail: 'No database variable found' };

  const rows = [
    ['Procore client ID is set', has('PROCORE_CLIENT_ID'), has('PROCORE_CLIENT_ID') ? 'Present' : 'Add PROCORE_CLIENT_ID in Railway Variables'],
    ['Procore client secret is set', has('PROCORE_CLIENT_SECRET'), has('PROCORE_CLIENT_SECRET') ? 'Present (value hidden)' : 'Add PROCORE_CLIENT_SECRET in Railway Variables'],
    ['Redirect URI matches this site', redirect === expected,
      redirect === expected ? redirect : `Railway has "${redirect || '(not set)'}" but this site needs "${expected}". Use this exact value in Railway and in the Procore Developer Portal.`],
    ['Database is configured', !!type, type || 'Add a Redis service and a REDIS_URL variable referencing it'],
    ['Database read/write works', db.ok, db.detail],
  ];
  const allOk = rows.every(r => r[1]);

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset="utf-8"><title>Setup check</title>
<body style="font-family:'Times New Roman',serif;font-size:12pt;margin:1in;max-width:7in;color:#1d1d1f">
<h2 style="color:#851e20;font-size:14pt">Procore Monitor setup check</h2>
<p>${allOk ? 'Everything looks right. <a href="/" style="color:#851e20">Open the app</a>.' : 'Fix the items marked ✗, redeploy, then reload this page.'}</p>
<table style="border-collapse:collapse;width:100%">
<tr style="background:#878787;color:#fff"><th style="text-align:left;padding:6px">Check</th><th style="padding:6px">Result</th><th style="text-align:left;padding:6px">Details</th></tr>
${rows.map((r, i) => `<tr style="background:${i % 2 ? '#F7ECEC' : '#fff'}">
<td style="padding:6px">${esc(r[0])}</td>
<td style="padding:6px;text-align:center;font-weight:bold;color:${r[1] ? '#15803d' : '#851e20'}">${r[1] ? '✓' : '✗'}</td>
<td style="padding:6px">${esc(r[2])}</td></tr>`).join('')}
</table></body>`);
};
