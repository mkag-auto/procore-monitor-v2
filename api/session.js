// api/session.js
//   GET  → who is signed in, the active company, and the companies they can switch to
//   POST { companyId } → switch the active company
const { requireSession, saveSession, setCookie } = require('./_procore');

const view = s => ({
  user: s.user || null,
  company: (s.companies || []).find(c => c.id === s.companyId) || null,
  companies: s.companies || [],
});

module.exports = async (req, res) => {
  const session = await requireSession(req, res, { needCompany: false });
  if (!session) return;

  if (req.method === 'POST') {
    const companyId = String(req.body?.companyId || '');
    if (!(session.companies || []).some(c => c.id === companyId)) {
      return res.status(400).json({ error: 'You do not have access to that company.' });
    }
    session.companyId = companyId;
    await saveSession(session);
    setCookie(res, 'pm_company', companyId, 365 * 24 * 3600); // remember across sign-ins
  }

  res.json(view(session));
};
