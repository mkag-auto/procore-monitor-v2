// api/status.js — health check (confirms the session can reach Procore)
const { requireSession, makeCtx, procoreGet, errMsg } = require('./_procore');

module.exports = async (req, res) => {
  const session = await requireSession(req, res, { needCompany: false });
  if (!session) return;
  try {
    await procoreGet('/rest/v1.0/me', makeCtx(session));
    res.json({ ok: true, message: 'Connected to Procore', companyId: session.companyId });
  } catch (err) {
    res.status(err.response?.status === 401 ? 401 : 502).json({ ok: false, message: errMsg(err) });
  }
};
