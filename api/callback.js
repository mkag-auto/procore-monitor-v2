// api/callback.js — trades the login code for tokens, loads the user's companies,
// and starts a server-side session (the browser only gets a random session id).
const {
  parseCookies, setCookie, exchangeToken, createSession, expiresAtFrom, procoreGet, errMsg,
} = require('./_procore');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function failPage(res, status, title, detail, hint) {
  res.status(status).setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in problem</title>
<body style="font-family:'Times New Roman',serif;font-size:12pt;margin:1in;max-width:6.5in;color:#1d1d1f">
<h2 style="color:#851e20;font-size:14pt">${esc(title)}</h2>
${detail ? `<p><b>What Procore or the server said:</b> ${esc(detail)}</p>` : ''}
${hint ? `<p><b>Likely fix:</b> ${hint}</p>` : ''}
<p><a href="/api/auth" style="color:#851e20">Try signing in again</a> &nbsp;|&nbsp; <a href="/api/setup-check" style="color:#851e20">Run the setup check</a></p>
</body>`);
}

module.exports = async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const cookies = parseCookies(req);

  if (error) return failPage(res, 400, 'Procore did not approve the sign-in.', error_description || error,
    'Make sure your Procore user has access to the app, then try again.');
  if (!code) return failPage(res, 400, 'No sign-in code came back from Procore.', null, 'Start again from the app.');
  if (!state || state !== cookies.pm_oauth_state) {
    return failPage(res, 400, 'Sign-in check failed.', 'The security check cookie was missing or did not match.',
      'Start sign-in from this same site address (not an old bookmark to /api/callback) and allow cookies.');
  }
  setCookie(res, 'pm_oauth_state', '', 0);

  let stage = 'token';
  try {
    const tok = await exchangeToken({ grant_type: 'authorization_code', code });
    const ctx = { token: tok.access_token, companyId: null, userKey: 'login', rl: {}, lastPersist: Date.now(), notes: [] };

    stage = 'companies';
    const companiesRaw = await procoreGet('/rest/v1.0/companies', ctx);
    const companies = (Array.isArray(companiesRaw) ? companiesRaw : [])
      .filter(c => c && c.is_active !== false)
      .map(c => ({ id: String(c.id), name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Pick: last company used on this browser → PROCORE_COMPANY_ID (optional) → first available
    const ids = new Set(companies.map(c => c.id));
    const preferred = [cookies.pm_company, process.env.PROCORE_COMPANY_ID].find(id => id && ids.has(String(id)));
    const companyId = preferred ? String(preferred) : companies[0]?.id || null;

    let user = null;
    try {
      const me = await procoreGet('/rest/v1.0/me', { ...ctx, companyId });
      user = { id: me.id, name: me.name || me.login, login: me.login };
    } catch (e) {
      console.warn('[callback] /me failed:', e.response?.status || e.message);
    }

    stage = 'session';
    await createSession(res, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: expiresAtFrom(tok),
      user,
      companies,
      companyId,
    });
    res.redirect('/');
  } catch (err) {
    const body = err.response?.data;
    const detail = body?.error_description || body?.error || errMsg(err);
    console.error(`[callback] failed at "${stage}":`, body || err.message);

    if (stage === 'token') {
      const code = body?.error;
      const hint = code === 'invalid_client'
        ? 'The client ID or secret is wrong. In Railway → your app → Variables, re-paste <b>PROCORE_CLIENT_ID</b> and <b>PROCORE_CLIENT_SECRET</b> from the Procore Developer Portal (production credentials, no extra spaces).'
        : code === 'invalid_grant'
        ? 'Usually a redirect URI mismatch. <b>PROCORE_REDIRECT_URI</b> in Railway must exactly equal the one in the Procore Developer Portal, including <code>https://</code> and <code>/api/callback</code>. It can also happen if this page was refreshed, so try signing in again first.'
        : 'Check PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET, and PROCORE_REDIRECT_URI in Railway.';
      return failPage(res, 502, 'Procore would not issue a sign-in token.', detail, hint);
    }
    if (stage === 'companies') {
      return failPage(res, 502, 'Signed in, but could not load your Procore companies.', detail,
        'Make sure the app is installed in your company\'s Procore App Management.');
    }
    return failPage(res, 500, 'Signed in with Procore, but could not save the session.', detail,
      'The app can\'t reach its database. In Railway, open your app → Variables and confirm <b>REDIS_URL</b> is set as a reference to the Redis service, then redeploy. The setup check below will confirm.');
  }
};
