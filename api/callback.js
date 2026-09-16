// api/callback.js — trades the login code for tokens, loads the user's companies,
// and starts a server-side session (the browser only gets a random session id).
const {
  parseCookies, setCookie, exchangeToken, createSession, expiresAtFrom, procoreGet,
} = require('./_procore');

module.exports = async (req, res) => {
  const { code, state } = req.query;
  const cookies = parseCookies(req);
  if (!code) return res.status(400).send('No authorization code received from Procore.');
  if (!state || state !== cookies.pm_oauth_state) {
    return res.status(400).send('Login check failed. <a href="/api/auth">Sign in again</a>.');
  }
  setCookie(res, 'pm_oauth_state', '', 0);

  try {
    const tok = await exchangeToken({ grant_type: 'authorization_code', code });
    const ctx = { token: tok.access_token, companyId: null, userKey: 'login', rl: {}, lastPersist: Date.now() };

    const companiesRaw = await procoreGet('/rest/v1.0/companies', ctx);
    const companies = (Array.isArray(companiesRaw) ? companiesRaw : [])
      .filter(c => c && c.is_active !== false)
      .map(c => ({ id: String(c.id), name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Pick: last company used on this browser → PROCORE_COMPANY_ID → first available
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
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Failed to sign in with Procore. <a href="/api/auth">Try again</a>.');
  }
};
