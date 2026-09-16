// api/rfi-detail.js — question/answer text for one RFI (fetched on demand)
const { requireSession, makeCtx, procoreGet, errMsg } = require('./_procore');

function extractText(field) {
  if (!field) return null;
  const raw = typeof field === 'string' ? field
    : field.plain_text_body || field.body || field.text || field.description || null;
  if (typeof raw !== 'string') return null;
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;
  const { project_id, rfi_id } = req.query;
  if (!/^\d+$/.test(project_id || '') || !/^\d+$/.test(rfi_id || '')) {
    return res.status(400).json({ error: 'project_id and rfi_id are required' });
  }
  try {
    const rfi = await procoreGet(`/rest/v1.0/projects/${project_id}/rfis/${rfi_id}`, makeCtx(session), { project_id });
    const question = extractText(rfi.question) || extractText(rfi.question_body) || extractText(rfi.body);
    const answer = extractText(rfi.response) || extractText(rfi.answer) || extractText(rfi.official_response)
      || (Array.isArray(rfi.responses) && rfi.responses.length
        ? extractText(rfi.responses[0].body) || extractText(rfi.responses[0]) : null);
    res.json({ question, answer });
  } catch (err) {
    if (err.response?.status === 401) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    res.status(500).json({ error: errMsg(err) });
  }
};
