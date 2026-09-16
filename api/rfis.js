// api/rfis.js — RFIs across all active projects for the selected company
const { makeResourceHandler, listProjectItems, safeStr, normStatus, daysSince } = require('./_procore');

async function fetchForProject(ctx, project, since) {
  const rfis = await listProjectItems(
    `/rest/v1.0/projects/${project.id}/rfis`, ctx, { project_id: project.id }, since
  );
  return rfis.map(rfi => ({
    id: rfi.id,
    number: rfi.number,
    subject: rfi.subject || rfi.title || '(No subject)',
    status: safeStr(rfi.status) || '',
    due_date: rfi.due_date || null,
    submitted_at: rfi.submitted_at || rfi.created_at || null,
    created_at: rfi.created_at || null,
    ball_in_court: safeStr(rfi.ball_in_court) || null,
    received_from: safeStr(rfi.received_from) || null,
    spec_section: safeStr(rfi.specification) || safeStr(rfi.spec_section) || null,
    assignees: (rfi.assignees || []).map(a => a.name || a.login).filter(Boolean).join(', ') || 'Unassigned',
    assignee_count: (rfi.assignees || []).length,
    has_response: !!(rfi.response && rfi.response.body),
    // Question/answer text is intentionally NOT stored here (keeps the snapshot
    // small). /api/rfi-detail fetches it on demand for a single RFI.
    project_id: project.id,
    project_name: project.name,
    procore_url: `https://us02.procore.com/webclients/host/companies/${ctx.companyId}/projects/${project.id}/tools/rfis/${rfi.id}`,
  }));
}

// Computed at serve time so flags stay correct no matter how old the snapshot is
function hydrate(r, today) {
  const status_key = normStatus(r.status);
  const late = daysSince(r.due_date, today);
  let flag;
  if (status_key === 'closed') flag = 'closed';
  else if (status_key === 'draft') flag = 'draft';
  else if (late && !r.has_response) flag = 'past_due';
  else if (late) flag = 'past_submitted';
  else if (status_key === 'open' && !r.assignee_count) flag = 'no_response';
  else flag = 'on_track';
  const active = flag !== 'closed' && flag !== 'draft';
  return { ...r, status_key, flag, days_past_due: active ? late : null };
}

module.exports = makeResourceHandler({ resource: 'rfis', concurrency: 3, fetchForProject, hydrate });
