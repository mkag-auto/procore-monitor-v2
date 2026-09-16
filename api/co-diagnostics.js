// api/co-diagnostics.js — read-only check of what Procore returns for change orders.
// Open /api/co-diagnostics?project_id=123 while signed in. Makes ~7 Procore calls.
// Shows field names and one trimmed sample per endpoint so the linking can be confirmed.
const { requireSession, makeCtx, procoreGet, getProjects, errMsg } = require('./_procore');

const trim = (v, depth = 0) => {
  if (Array.isArray(v)) return v.slice(0, 3).map(x => trim(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 2) return '{…}';
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trim(x, depth + 1)]));
  }
  return typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
};

async function probe(ctx, path, params) {
  try {
    const data = await procoreGet(path, ctx, { per_page: 3, page: 1, ...params });
    const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
    const first = arr ? arr[0] : data;
    return { ok: true, shape: arr ? `array(${arr.length})` : typeof data, fields: first ? Object.keys(first) : [], sample: trim(first), _first: first };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: errMsg(err) };
  }
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;
  const ctx = makeCtx(session);
  try {
    let projectId = req.query.project_id;
    if (!projectId) {
      const projects = await getProjects(ctx);
      if (!projects.length) return res.json({ error: 'No active projects' });
      return res.json({ hint: 'Add ?project_id=ID for a project that has change orders', projects: projects.slice(0, 100) });
    }
    if (!/^\d+$/.test(projectId)) return res.status(400).json({ error: 'project_id must be a number' });
    const p = { project_id: projectId };
    const out = {
      change_order_packages: await probe(ctx, '/rest/v1.0/change_order_packages', p),
      potential_change_orders: await probe(ctx, '/rest/v1.0/potential_change_orders', p),
      commitment_change_orders_extended: await probe(ctx, `/rest/v1.0/projects/${projectId}/commitment_change_orders`, { ...p, view: 'extended' }),
      commitments: await probe(ctx, '/rest/v1.0/commitments', p),
      change_event_line_items: await probe(ctx, '/rest/v1.1/change_event_line_items', p),
    };
    const firstPco = out.potential_change_orders._first;
    out.pco_line_items = firstPco?.id
      ? await probe(ctx, `/rest/v1.0/potential_change_orders/${firstPco.id}/line_items`, p)
      : { ok: false, error: 'No PCOs in this project to inspect' };
    for (const v of Object.values(out)) delete v._first;
    res.json({ company_id: ctx.companyId, project_id: projectId, results: out });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
};
