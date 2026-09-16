// api/change-events.js — Change Events across all active projects for the selected company
const { makeResourceHandler, listProjectItems, procoreGetAll, safeStr, safeNum, normStatus, daysSince } = require('./_procore');

const CLOSED = new Set(['closed', 'void', 'voided']);

// Amount lives in change_items[].latest_revenue_values.amount (returned as a string)
function amountFromItems(e) {
  if (!Array.isArray(e.change_items) || e.change_items.length === 0) return null;
  return e.change_items.reduce((sum, item) => sum + (safeNum(item?.latest_revenue_values?.amount) || 0), 0);
}

async function fetchForProject(ctx, project, since) {
  const events = await listProjectItems('/rest/v1.1/change_events', ctx, { project_id: project.id }, since);

  // Only pull line items (an extra call per project) when the events themselves
  // don't carry amounts, and only on a full rebuild.
  let lineItemAmounts = {};
  const needLineItems = !since && events.some(e => !Array.isArray(e?.change_items));
  if (needLineItems) {
    try {
      const lineItems = await procoreGetAll('/rest/v1.1/change_event_line_items', ctx, { project_id: project.id });
      for (const li of lineItems) {
        const ceId = li.change_event_id || li.change_event?.id;
        if (!ceId) continue;
        const amt = safeNum(li.latest_revenue_values?.amount) ?? safeNum(li.amount)
          ?? safeNum(li.cost_amount) ?? safeNum(li.rom_amount) ?? 0;
        lineItemAmounts[ceId] = (lineItemAmounts[ceId] || 0) + amt;
      }
    } catch (err) {
      console.warn(`[ce] line items failed for ${project.name}: ${err.response?.status || err.message}`);
    }
  }

  return events.filter(e => e && typeof e === 'object').map(e => ({
    id: e.id,
    project_id: project.id,
    project_name: project.name,
    number: safeStr(e.number) ?? '',
    title: safeStr(e.title) || '(No title)',
    status: safeStr(e.status) || '',
    change_reason: safeStr(e.change_reason) || null,
    type: safeStr(e.change_event_type) || safeStr(e.event_type) || null,
    scope: safeStr(e.scope) || null,
    origin: safeStr(e.change_event_origin) || safeStr(e.origin) || safeStr(e.event_origin_type) || null,
    created_at: e.created_at || null,
    due_date: e.due_date || null,
    created_by: safeStr(e.created_by) || null,
    estimated_amount: amountFromItems(e)
      ?? lineItemAmounts[e.id]
      ?? safeNum(e.latest_revenue_values?.amount)
      ?? safeNum(e.cost_rom_amount)
      ?? null,
    cost_code: safeStr(e.cost_code) || null,
    procore_url: `https://us02.procore.com/${project.id}/project/change_events/events/${e.id}`,
  }));
}

// On incremental syncs, keep the stored amount if the update didn't include one
function mergeRecord(oldRec, newRec) {
  return newRec.estimated_amount == null ? { ...newRec, estimated_amount: oldRec.estimated_amount } : newRec;
}

function hydrate(e, today) {
  const status_key = normStatus(e.status);
  const is_open = !CLOSED.has(status_key);
  return {
    ...e, status_key, is_open,
    days_open: daysSince(e.created_at, today),
    days_past_due: is_open ? daysSince(e.due_date, today) : null,
  };
}

module.exports = makeResourceHandler({ resource: 'change_events', concurrency: 3, fetchForProject, hydrate, mergeRecord });
