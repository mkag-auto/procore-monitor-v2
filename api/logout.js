// api/logout.js — ends the session on this browser
const { destroySession } = require('./_procore');

module.exports = async (req, res) => {
  await destroySession(req, res);
  res.setHeader('Content-Type', 'text/html');
  res.end('<p style="font-family:Times New Roman;font-size:12pt">Signed out of Procore Monitor. <a href="/api/auth">Sign in again</a></p>');
};
