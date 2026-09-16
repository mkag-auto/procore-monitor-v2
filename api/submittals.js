// api/submittals.js — Submittals across all active projects for the selected company
const { makeResourceHandler, listProjectItems, safeStr, safeNum, normStatus, daysSince } = require('./_procore');

// "Revise and Resubmit" stays OPEN on purpose — it still needs action.
const CLOSED = new Set(['closed', 'approved', 'approved_as_noted', 'rejected', 'void', 'voided']);

function specSection(s) {
  const ss = s.specification_section || s.spec_section || s.specification;
  if (!ss) return null;
  if (typeof ss === 'string') return ss.trim() || null;
  return safeStr(ss.label || ss.title || ss.description || ss.number || ss.name);
}

async function fetchForProject(ctx, project, since) {
  const subs = await listProjectItems(
    `/rest/v1.0/projects/${project.id}/submittals`, ctx, { project_id: project.id }, since
  );
  return subs.map(s => ({
    id: s.id,
    project_id: project.id,
    project_name: project.name,
    number: safeStr(s.number ?? s.submittal_number) ?? '',
    spec_section: specSection(s),
    title: safeStr(s.title) || safeStr(s.description) || '(No title)',
    status: safeStr(s.status) || '',
    responsible_contractor:
      safeStr(s.responsible_contractor?.name)
      || safeStr(s.responsible_contractor?.company?.name)
      || safeStr(s.responsible_contractor) || null,
    ball_in_court:
      safeStr(s.ball_in_court) || safeStr(s.current_ball_in_court)
      || safeStr(s.current_revision?.ball_in_court)
      || safeStr(s.workflow_state?.ball_in_court)
      || safeStr(s.submittal_manager) || null,
    received_from: safeStr(s.received_from) || null,
    due_date: s.due_date || null,
    lead_time: safeNum(s.lead_time),
    required_on_site_date: s.required_on_site_date || null,
    revision_number: safeNum(s.revision ?? s.revision_number) ?? 0,
    created_at: s.created_at || null,
    procore_url: `https://us02.procore.com/webclients/host/companies/${ctx.companyId}/projects/${project.id}/tools/submittals/${s.id}`,
  }));
}

function hydrate(s, today) {
  const status_key = normStatus(s.status);
  const is_open = !CLOSED.has(status_key);
  return { ...s, status_key, is_open, days_past_due: is_open ? daysSince(s.due_date, today) : null };
}

module.exports = makeResourceHandler({ resource: 'submittals', concurrency: 5, fetchForProject, hydrate });
