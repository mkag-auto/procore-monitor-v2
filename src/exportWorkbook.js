// src/exportWorkbook.js — builds the branded Excel report in the browser.
// Uses data already on screen, so exporting makes zero Procore API calls.
const RED = "FF851E20", GREY = "FF878787", LTRED = "FFF7ECEC", WHITE = "FFFFFFFF";
const FONT = { name: "Times New Roman", size: 12 };
const DATE_FMT = "mmm d, yyyy";
const MONEY_FMT = '"$"#,##0';

// Excel date from "YYYY-MM-DD" or a timestamp, without timezone drift
function toDate(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

const late = { type: "late" };

export function columns(flagLabel) {
  return {
    rfis: [
      { h: "Project", v: r => r.project_name, w: 30 },
      { h: "RFI #", v: r => r.number, w: 9 },
      { h: "Subject", v: r => r.subject, w: 45 },
      { h: "Status", v: r => r.status, w: 12 },
      { h: "Flag", v: r => flagLabel(r.flag), w: 15 },
      { h: "Ball in Court", v: r => r.ball_in_court, w: 22 },
      { h: "Received From", v: r => r.received_from, w: 22 },
      { h: "Date Initiated", v: r => r.submitted_at, type: "date", w: 15 },
      { h: "Due Date", v: r => r.due_date, type: "date", w: 14 },
      { h: "Days Past Due", v: r => r.days_past_due, ...late, w: 14 },
    ],
    submittals: [
      { h: "Project", v: s => s.project_name, w: 30 },
      { h: "Sub #", v: s => s.number, w: 10 },
      { h: "Spec Section", v: s => s.spec_section, w: 24 },
      { h: "Title", v: s => s.title, w: 40 },
      { h: "Status", v: s => s.status, w: 14 },
      { h: "Responsible Contractor", v: s => s.responsible_contractor, w: 26 },
      { h: "Ball in Court", v: s => s.ball_in_court, w: 22 },
      { h: "Due Date", v: s => s.due_date, type: "date", w: 14 },
      { h: "Days Past Due", v: s => s.days_past_due, ...late, w: 14 },
      { h: "Lead Time (days)", v: s => s.lead_time, w: 14 },
      { h: "Required On Site", v: s => s.required_on_site_date, type: "date", w: 16 },
      { h: "Rev #", v: s => s.revision_number ?? 0, w: 8 },
    ],
    changeEvents: [
      { h: "Project", v: e => e.project_name, w: 30 },
      { h: "Event #", v: e => e.number, w: 10 },
      { h: "Title", v: e => e.title, w: 40 },
      { h: "Status", v: e => e.status, w: 12 },
      { h: "Type", v: e => e.type, w: 16 },
      { h: "Change Reason", v: e => e.change_reason, w: 20 },
      { h: "Scope", v: e => e.scope, w: 14 },
      { h: "Origin", v: e => e.origin, w: 14 },
      { h: "Created By", v: e => e.created_by, w: 20 },
      { h: "Created", v: e => e.created_at, type: "date", w: 14 },
      { h: "Days Open", v: e => e.days_open, w: 11 },
      { h: "Days Past Due", v: e => e.days_past_due, ...late, w: 14 },
      { h: "Latest Price", v: e => e.estimated_amount, type: "money", w: 16 },
      { h: "Change Orders", v: e => e.linked_cos_label, w: 24 },
    ],
    changeOrders: [
      { h: "Project", v: c => c.project_name, w: 30 },
      { h: "Type", v: c => c.kind_label, w: 16 },
      { h: "CO #", v: c => c.number, w: 10 },
      { h: "Title", v: c => c.title, w: 40 },
      { h: "Contract / Vendor", v: c => c.vendor || c.contract_label, w: 26 },
      { h: "Prime CO (for PCOs)", v: c => c.package_label, w: 22 },
      { h: "Status", v: c => c.status, w: 16 },
      { h: "Change Events", v: c => c.linked_events_label, w: 22 },
      { h: "Change Reason", v: c => c.change_reason, w: 18 },
      { h: "Created", v: c => c.created_at, type: "date", w: 14 },
      { h: "Due Date", v: c => c.due_date, type: "date", w: 14 },
      { h: "Days Past Due", v: c => c.days_past_due, ...late, w: 14 },
      { h: "Amount", v: c => c.amount, type: "money", w: 16 },
    ],
  };
}

function setup(ws) {
  ws.pageSetup = {
    orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
  };
}

function titleRows(ws, title, subtitle) {
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { ...FONT, size: 14, bold: true, color: { argb: RED } };
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { ...FONT, color: { argb: GREY } };
}

function sectionRow(ws, row, label, ncols) {
  ws.mergeCells(row, 1, row, ncols);
  const c = ws.getCell(row, 1);
  c.value = label;
  c.font = { ...FONT, bold: true, color: { argb: WHITE } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: RED } };
  c.alignment = { vertical: "middle" };
  ws.getRow(row).height = 18;
}

function headerRow(ws, row, cols) {
  cols.forEach((col, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = col.h;
    c.font = { ...FONT, bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
}

function dataRows(ws, startRow, cols, items) {
  items.forEach((item, idx) => {
    const row = startRow + idx;
    cols.forEach((col, i) => {
      const c = ws.getCell(row, i + 1);
      let v = col.v(item);
      if (col.type === "date") { v = toDate(v); if (v) c.numFmt = DATE_FMT; }
      if (col.type === "money" && v != null) c.numFmt = MONEY_FMT;
      c.value = v ?? "";
      c.font = { ...FONT };
      if (col.type === "late" && v) c.font = { ...FONT, bold: v > 14, color: { argb: RED } };
      if (col.type === "money" && v > 50000) c.font = { ...FONT, bold: true };
      if (idx % 2 === 1) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LTRED } };
    });
  });
  return startRow + items.length;
}

function sheetName(name, used) {
  const clean = String(name || "Project").replace(/[*?:/\\[\]]/g, "-").slice(0, 31);
  let out = clean, n = 2;
  while (used.has(out.toLowerCase())) out = `${clean.slice(0, 27)} (${n++})`;
  used.add(out.toLowerCase());
  return out;
}

export function buildWorkbook(ExcelJS, { rfis, submittals, changeEvents, changeOrders = [], companyName, flagLabel, asOf }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Enfield Enterprises Procore Monitor";
  wb.created = new Date();
  const cols = columns(flagLabel);
  const used = new Set();
  const stamp = `${companyName || ""}${companyName ? " — " : ""}Data as of ${asOf}`;

  // Portfolio-wide sheets
  const summary = [
    ["All RFIs", cols.rfis, rfis],
    ["All Submittals", cols.submittals, submittals],
    ["All Change Events", cols.changeEvents, changeEvents],
    ["All Change Orders", cols.changeOrders, changeOrders],
  ];
  for (const [name, c, items] of summary) {
    const ws = wb.addWorksheet(sheetName(name, used));
    setup(ws);
    titleRows(ws, name, stamp);
    headerRow(ws, 4, c);
    const end = dataRows(ws, 5, c, items);
    c.forEach((col, i) => { ws.getColumn(i + 1).width = col.w; });
    ws.views = [{ state: "frozen", ySplit: 4 }];
    if (items.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: end - 1, column: c.length } };
  }

  // One sheet per project (project column dropped — it's the sheet name)
  const byProject = new Map();
  const add = (key, r) => {
    if (!byProject.has(r.project_name)) byProject.set(r.project_name, { rfis: [], submittals: [], changeEvents: [], changeOrders: [] });
    byProject.get(r.project_name)[key].push(r);
  };
  rfis.forEach(r => add("rfis", r));
  submittals.forEach(r => add("submittals", r));
  changeEvents.forEach(r => add("changeEvents", r));
  changeOrders.forEach(r => add("changeOrders", r));

  const sections = [["rfis", "RFIs"], ["submittals", "Submittals"], ["changeEvents", "Change Events"], ["changeOrders", "Change Orders"]];
  for (const proj of [...byProject.keys()].sort()) {
    const data = byProject.get(proj);
    const ws = wb.addWorksheet(sheetName(proj, used));
    setup(ws);
    titleRows(ws, proj, stamp);
    const widths = [];
    let row = 4;
    for (const [key, label] of sections) {
      const c = cols[key].slice(1);
      c.forEach((col, i) => { widths[i] = Math.max(widths[i] || 0, col.w); });
      sectionRow(ws, row++, `${label} (${data[key].length})`, c.length);
      if (!data[key].length) {
        const cell = ws.getCell(row++, 1);
        cell.value = `No ${label.toLowerCase()}`;
        cell.font = { ...FONT, italic: true, color: { argb: GREY } };
      } else {
        headerRow(ws, row++, c);
        row = dataRows(ws, row, c, data[key]);
      }
      row++;
    }
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }
  return wb;
}

// "Export this view": one sheet with exactly the rows on screen, in on-screen order,
// plus a line stating which filters were applied.
export function buildViewWorkbook(ExcelJS, { kind, rows, title, filterText, companyName, flagLabel, asOf }) {
  const c = columns(flagLabel)[kind];
  if (!c) throw new Error(`Unknown export type: ${kind}`);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Enfield Enterprises Procore Monitor";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName(title, new Set()));
  setup(ws);
  titleRows(ws, title, `${companyName ? `${companyName} — ` : ""}Data as of ${asOf}; exported ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`);
  const f = ws.getCell(3, 1);
  f.value = `Filters: ${filterText}. ${rows.length} row${rows.length !== 1 ? "s" : ""}.`;
  f.font = { ...FONT, italic: true };
  headerRow(ws, 5, c);
  const end = dataRows(ws, 6, c, rows);
  c.forEach((col, i) => { ws.getColumn(i + 1).width = col.w; });
  ws.views = [{ state: "frozen", ySplit: 5 }];
  if (rows.length) ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: end - 1, column: c.length } };
  ws.headerFooter = { oddFooter: "&L&\"Times New Roman\"&10Enfield Enterprises, LLC&R&\"Times New Roman\"&10Page &P of &N" };
  return wb;
}
