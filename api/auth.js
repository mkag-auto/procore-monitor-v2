// api/auth.js — sends the user to Procore login (with CSRF state check)
const crypto = require('crypto');
const { setCookie } = require('./_procore');

module.exports = (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'pm_oauth_state', state, 600);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.PROCORE_CLIENT_ID,
    redirect_uri: process.env.PROCORE_REDIRECT_URI,
    state,
  });
  res.redirect(`https://login.procore.com/oauth/authorize?${params.toString()}`);
};
