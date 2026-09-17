// api/change-orders.js — Change Orders across all active projects, linked to Change Events
//
// Three kinds of change orders are pulled per project:
//   • prime_co      Prime contract change orders   GET /rest/v1.0/change_order_packages
//   • pco           Potential change orders        GET /rest/v1.0/potential_change_orders
//   • commitment_co Commitment (sub) change orders GET /rest/v1.0/projects/:id/commitment_change_orders?view=extended
//
// How each kind is linked back to Change Events (only documented fields are used):
//   • commitment_co  → the extended view includes change_events [{ id, number }]      (0 extra calls)
//   • pco            → each PCO line item carries change_event_line_item.event_id     (1 extra call per PCO)
//   • prime_co       → through its PCOs. A PCO names its package by title + number
//                      (no id), so a PCO is tied to a package only when contract,
//                      title AND number all match. Otherwise the link is left unknown.
const {
  makeResourceHandler, procoreGetAll, listProjectItems, soft,
  safeStr, safeNum, normStatus, daysSince,
} = require('./_procore');

const CLOSED = new Set(['approved', 'rejected', 'void', 'voided', 'no_charge', 'closed']);

// ── Procore web links ─────────────────────────────────────────────────────────
// Confirmed against live Procore pages, Sept 2026:
//   PCCO → .../prime_contracts/{contract}/change_orders/prime-change-order-batches/{id}
//   PCO  → .../prime_contracts/{contract}/change_orders/prime-change-orders/{id}
//   CCO  → .../commitments/work_order_contracts/{contract}/change_orders/commitment-change-orders/{id}
//          (Procore also opened a subcontract CCO under purchase_order_contracts,
//           so one wording is used for both.)
// Links are rebuilt every time data is served (see hydrate), so if Procore changes
// these again, fixing this block is enough. No full rebuild needed for records
// that already carry company_id.
const WEB = 'https://us02.procore.com';
const LINK_PATHS = {
  prime_co:      r => `prime_contracts/${r.contract_id}/change_orders/prime-change-order-batches/${r.raw_id}`,
  pco:           r => `prime_contracts/${r.contract_id}/change_orders/prime-change-orders/${r.raw_id}`,
  commitment_co: r => `commitments/work_order_contracts/${r.contract_id}/change_orders/commitment-change-orders/${r.raw_id}`,
};

function buildUrl(r) {
  const path = LINK_PATHS[r.kind];
  if (!path || !r.company_id || r.project_id == null || r.contract_id == null || r.raw_id == null) return null;
  return `${WEB}/webclients/host/companies/${r.company_id}/projects/${r.project_id}/tools/contracts/${path(r)}`;
}

const digits = v => String(v ?? '').replace(/\D+/g, '').replace(/^0+/, '');
const uniqEvents = list => {
  const m = new Map();
  for (const e of list) if (e && e.id != null && !m.has(e.id)) m.set(e.id, { id: e.id, number: e.number ?? null });
  return [...m.values()];
};

function eventIdFromLineItem(li) {
  const ce = li?.change_event_line_item;
  return ce?.event_id ?? ce?.change_event_id ?? ce?.change_event?.id ?? li?.change_event_id ?? null;
}

async function fetchForProject(ctx, project, since, cached) {
  const pid = project.id;
  const params = { project_id: pid };
  const name = project.name;

  const [packages, pcos, ccos] = await Promise.all([
    soft(ctx, `${name} prime change orders`, () => listProjectItems('/rest/v1.0/change_order_packages', ctx, params, since)),
    soft(ctx, `${name} potential change orders`, () => listProjectItems('/rest/v1.0/potential_change_orders', ctx, params, since)),
    soft(ctx, `${name} commitment change orders`, () =>
      listProjectItems(`/rest/v1.0/projects/${pid}/commitment_change_orders`, ctx, { ...params, view: 'extended' }, since)),
  ]);

  // Contract names (vendor for subcontracts). Reuse what's cached unless something new shows up.
  const contractLabels = new Map();
  for (const r of cached) if (r.contract_id != null && r.contract_label) contractLabels.set(r.contract_id, { label: r.contract_label, vendor: r.vendor, side: r.contract_side });
  const needed = [...pcos, ...ccos, ...packages].some(r => r?.contract_id != null && !contractLabels.has(r.contract_id));
  let commitmentsLoaded = !needed;
  if (needed) {
    const commitments = await soft(ctx, `${name} commitments list`, () => procoreGetAll('/rest/v1.0/commitments', ctx, params), null);
    if (commitments) {
      commitmentsLoaded = true;
      for (const c of commitments) {
        const vendor = safeStr(c.vendor) || null;
        const label = [c.number, safeStr(c.title)].filter(Boolean).join(' ') || vendor || `Commitment ${c.id}`;
        contractLabels.set(c.id, { label, vendor, side: 'commitment' });
      }
    }
  }
  const contractInfo = id => {
    if (id == null) return { label: null, vendor: null, side: null };
    if (contractLabels.has(id)) return contractLabels.get(id);
    // Not a commitment we can see. Only call it "prime" if the commitments list actually loaded.
    return commitmentsLoaded ? { label: 'Prime contract', vendor: null, side: 'prime' } : { label: null, vendor: null, side: null };
  };

  const base = (kind, o) => {
    const c = contractInfo(o.contract_id);
    return {
      id: `${kind}-${o.id}`,
      raw_id: o.id,
      kind,
      company_id: ctx.companyId ?? null,
      project_id: pid,
      project_name: name,
      number: safeStr(o.number) ?? '',
      title: safeStr(o.title) || '(No title)',
      status: safeStr(o.status) || '',
      contract_id: o.contract_id ?? null,
      contract_label: c.label,
      contract_side: c.side,
      vendor: c.vendor,
      amount: safeNum(o.grand_total),
      executed: o.executed ?? null,
      due_date: o.due_date || null,
      created_at: o.created_at || null,
      reviewed_at: o.reviewed_at || null,
      updated_at: o.updated_at || null,
      change_reason: safeStr(o.change_reason) || safeStr(o.change_order_change_reason) || null,
    };
  };

  const records = [];

  // Commitment COs — links come straight from the extended view
  for (const o of ccos) {
    if (!o || typeof o !== 'object') continue;
    const r = base('commitment_co', o);
    r.links_known = Array.isArray(o.change_events);
    r.linked_events = uniqEvents(o.change_events || []);
    r.procore_url = buildUrl(r);
    records.push(r);
  }

  // PCOs — one line-item call each to find their change events
  for (const o of pcos) {
    if (!o || typeof o !== 'object' || o.deleted_at) continue;
    const r = base('pco', o);
    r.package_label = [safeStr(o.change_order_package_acronym_number), safeStr(o.change_order_package_title)].filter(Boolean).join(' ') || null;
    r.package_title = safeStr(o.change_order_package_title);
    r.package_number = safeStr(o.change_order_package_acronym_number);
    const items = await soft(ctx, `${name} PCO ${r.number} line items`,
      () => procoreGetAll(`/rest/v1.0/potential_change_orders/${o.id}/line_items`, ctx, params), null);
    r.links_known = items !== null;
    r.linked_events = uniqEvents((items || []).map(li => ({ id: eventIdFromLineItem(li), number: null })));
    r.procore_url = buildUrl(r);
    records.push(r);
  }

  // Prime COs (packages) — linked through matching PCOs (current + cached)
  const allPcos = new Map(cached.filter(r => r.kind === 'pco').map(r => [r.id, r]));
  for (const r of records) if (r.kind === 'pco') allPcos.set(r.id, r);
  const pcoList = [...allPcos.values()];

  const packageRecords = packages.filter(o => o && typeof o === 'object' && !o.deleted_at).map(o => base('prime_co', o));
  // On incremental syncs, re-link cached packages too (a changed PCO may now point at them)
  const pkgIdsNow = new Set(packageRecords.map(r => r.id));
  for (const r of cached) {
    if (r.kind === 'prime_co' && !pkgIdsNow.has(r.id)) {
      packageRecords.push({ ...r, company_id: r.company_id ?? ctx.companyId ?? null });
    }
  }

  for (const r of packageRecords) {
    const matches = pcoList.filter(p =>
      p.contract_id === r.contract_id &&
      p.package_title && p.package_title === r.title &&
      digits(p.package_number) !== '' && digits(p.package_number) === digits(r.number)
    );
    r.linked_pcos = matches.map(p => ({ id: p.id, number: p.number }));
    r.links_known = matches.length > 0 && matches.every(p => p.links_known);
    r.linked_events = uniqEvents(matches.flatMap(p => p.linked_events || []));
    r.procore_url = buildUrl(r);
    records.push(r);
  }

  return records;
}

function hydrate(r, today) {
  const status_key = normStatus(r.status);
  const is_open = !CLOSED.has(status_key);
  return {
    ...r,
    status_key,
    is_open,
    // Rebuilt on every read so link fixes apply without re-downloading.
    // Older saved rows without company_id keep their stored link until a Full rebuild.
    procore_url: buildUrl(r) || r.procore_url || null,
    days_open: is_open ? daysSince(r.created_at, today) : null,
    days_past_due: is_open ? daysSince(r.due_date, today) : null,
  };
}

// PCO line items are fetched on every sync of that PCO, so updates fully replace.
module.exports = makeResourceHandler({ resource: 'change_orders', concurrency: 2, fetchForProject, hydrate });
