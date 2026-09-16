import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { buildWorkbook, buildViewWorkbook } from "./exportWorkbook.js";

// ── Sync behaviour ────────────────────────────────────────────────────────────
// Opening the app shows the last saved snapshot and makes NO Procore calls.
// Click "Sync" to pull changes. To auto-sync when the snapshot gets old,
// set this to a number of hours (e.g. 12). null = only sync when you click.
const AUTO_SYNC_AFTER_HOURS = null;
const STALE_WARN_HOURS = 4;       // age pill turns amber
const SYNC_REMINDER_HOURS = 8;    // yellow "time to sync" banner appears
const STALE_ALERT_HOURS = 24;     // age pill and banner turn red
const SNOOZE_HOURS = 2;           // "Remind me later" hides the banner this long

// ── Design tokens ────────────────────────────────────────────────────────────
const C = {
  brand: "#851e20", brandLight: "#f7ecec", brandMid: "#b84042", grey: "#878787",
  bg: "#f2f2f7", surface: "#ffffff", surfaceAlt: "#f9f9f9",
  border: "rgba(0,0,0,0.08)", borderStrong: "rgba(0,0,0,0.14)",
  text: "#1d1d1f", textSecondary: "#6e6e73", textTertiary: "#aeaeb2",
  shadow: "0 1px 3px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.06)",
  shadowSm: "0 1px 2px rgba(0,0,0,0.05)",
};
const F = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif`;

// ── RFI flags ────────────────────────────────────────────────────────────────
const FLAGS = {
  past_due:       { label:"Past Due",       color:"#b91c1c", bg:"#fef2f2", border:"#fecaca" },
  past_submitted: { label:"Late, Answered", color:"#c2410c", bg:"#fff7ed", border:"#fed7aa" },
  no_response:    { label:"Unassigned",     color:"#a16207", bg:"#fefce8", border:"#fde68a" },
  draft:          { label:"Draft",          color:"#6b7280", bg:"#f9fafb", border:"#e5e7eb" },
  on_track:       { label:"On Track",       color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" },
  closed:         { label:"Closed",         color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd" },
};
const FLAG_ORDER = ["past_due","past_submitted","no_response","draft","on_track","closed"];
const ATTENTION_FLAGS = ["past_due","past_submitted","no_response"];
const NEUTRAL = { color:"#6b7280", bg:"#f9fafb", border:"#e5e7eb" };

const SUB_STATUS = {
  open:                { color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd" },
  pending:             { color:"#a16207", bg:"#fefce8", border:"#fde68a" },
  approved:            { color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" },
  approved_as_noted:   { color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" },
  revise_and_resubmit: { color:"#c2410c", bg:"#fff7ed", border:"#fed7aa" },
  rejected:            { color:"#b91c1c", bg:"#fef2f2", border:"#fecaca" },
  closed:              NEUTRAL,
};
const CE_STATUS = {
  open:    { color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd" },
  pending: { color:"#a16207", bg:"#fefce8", border:"#fde68a" },
  closed:  { color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" },
  void:    NEUTRAL, voided: NEUTRAL,
};

// ── Change order kinds & statuses ─────────────────────────────────────────────
const CO_KIND = {
  prime_co:      { label:"Prime CO",      short:"PCCO", color:"#851e20", bg:"#f7ecec", border:"#e8c8c8" },
  pco:           { label:"Potential CO",  short:"PCO",  color:"#6b21a8", bg:"#faf5ff", border:"#e9d5ff" },
  commitment_co: { label:"Commitment CO", short:"CCO",  color:"#0f766e", bg:"#f0fdfa", border:"#99f6e4" },
};
const coStatusScheme = k => {
  const key = String(k || "");
  if (key === "approved") return { color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0" };
  if (key.startsWith("pending")) return { color:"#a16207", bg:"#fefce8", border:"#fde68a" };
  if (key === "rejected") return { color:"#b91c1c", bg:"#fef2f2", border:"#fecaca" };
  if (key === "draft" || key.includes("void") || key === "no_charge") return NEUTRAL;
  return { color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd" };
};

// ── Utilities ─────────────────────────────────────────────────────────────────
// Date-only strings ("2026-09-16") are parsed as local dates so they don't show a day early
const toLocalDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? new Date(`${d}T00:00:00`) : new Date(d);
const fmt = d => d ? toLocalDate(d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : null;
const fmtCurrency = n => n == null ? "—" : new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ageText(iso) {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} days ago`;
}
const ageHours = iso => iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity;

const safeVal = v => {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "object") return v.name || v.label || v.title || v.description || JSON.stringify(v);
  return String(v);
};

// ── Shared small components ───────────────────────────────────────────────────
function StatusBadge({ label, scheme }) {
  const c = scheme || NEUTRAL;
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,background:c.bg,border:`1px solid ${c.border}`,fontSize:11.5,fontWeight:500,color:c.color,whiteSpace:"nowrap"}}>
      <span style={{width:5,height:5,borderRadius:"50%",background:c.color,flexShrink:0}}/>
      {label}
    </span>
  );
}
const Badge = ({ flag }) => { const c = FLAGS[flag] || FLAGS.draft; return <StatusBadge label={c.label} scheme={c}/>; };

function Spinner({ label = "Loading…" }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:80,gap:14}}>
      <div style={{width:26,height:26,border:`2.5px solid ${C.border}`,borderTopColor:C.brand,borderRadius:"50%",animation:"spin 0.75s linear infinite"}}/>
      <div style={{fontSize:13,color:C.textSecondary,fontFamily:F}}>{label}</div>
    </div>
  );
}

function SummaryCard({ label, value, sub, color, active, onClick }) {
  const clickable = !!onClick;
  return (
    <button onClick={onClick} disabled={!clickable} style={{
      background: active ? C.brandLight : C.surface,
      border:`1px solid ${active ? (color || C.brand) : C.border}`,
      borderRadius:14,padding:"15px 18px",cursor:clickable?"pointer":"default",
      flex:1,minWidth:130,textAlign:"left",boxShadow:active?"none":C.shadowSm,transition:"all 0.15s",
    }}>
      <div style={{fontSize:26,fontWeight:600,lineHeight:1,letterSpacing:"-0.02em",color:color||C.text,fontFamily:F}}>{value}</div>
      <div style={{fontSize:11.5,color:C.textSecondary,marginTop:5,fontWeight:500}}>{label}</div>
      {sub&&<div style={{fontSize:10.5,color:C.textTertiary,marginTop:2}}>{sub}</div>}
    </button>
  );
}

function ProcoreIconBtn({ url }) {
  return (
    <td style={{...td,width:36,padding:"8px 6px 8px 10px"}}>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open in Procore" className="pm-link"
          style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:28,height:28,borderRadius:7,background:C.brandLight,border:"1px solid #e8c8c8",color:C.brand}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
      ) : <div style={{width:28,height:28}}/>}
    </td>
  );
}

const SortIcon = ({active, dir}) => <span style={{marginLeft:4,opacity:active?1:0.25,color:active?C.brand:C.textTertiary}}>{active?(dir==="asc"?"↑":"↓"):"↕"}</span>;
const Dash = () => <span style={{color:C.textTertiary}}>—</span>;

const chipStyle = s => ({
  fontFamily:F,fontSize:11,fontWeight:600,padding:"2px 7px",borderRadius:6,cursor:"pointer",whiteSpace:"nowrap",
  color:s.color,background:s.bg,border:`1px solid ${s.border}`,
});

// Linked items shown as small buttons; clicking jumps to them on the other tab
function LinkChips({ items, state, emptyLabel, onOpen }) {
  if (state === "unknown") return <span title="Procore did not return link data for this item" style={{fontSize:11.5,color:C.textTertiary}}>Not available</span>;
  if (state === "pending") return <Dash/>;
  if (!items.length) return <span style={{fontSize:11.5,color:"#b45309",fontWeight:500}}>{emptyLabel}</span>;
  const shown = items.slice(0, 3);
  return (
    <div style={{display:"flex",gap:4,flexWrap:"wrap",maxWidth:230}}>
      {shown.map(it => <button key={it.key} onClick={onOpen} title={it.title} style={chipStyle(it.scheme)}>{it.label}</button>)}
      {items.length > 3 && <button onClick={onOpen} title="Show all linked items" style={chipStyle(NEUTRAL)}>+{items.length - 3}</button>}
    </div>
  );
}

// Lists the active filters so the exported file says what it contains
const describe = parts => parts.filter(Boolean).join("; ") || "No filters (everything in this tab)";

function ExportViewButton({ rows, busy, onExport, describeView }) {
  const n = rows.length;
  return (
    <button onClick={()=>onExport(rows, describeView())} disabled={!n||busy}
      title={n?"Download exactly the rows shown below as an Excel file":"Nothing to export with these filters"}
      style={{...btn,color:C.brand,background:C.brandLight,border:"1px solid #e8c8c8",fontWeight:500,cursor:(!n||busy)?"not-allowed":"pointer",opacity:(!n||busy)?0.6:1}}>
      {busy?"Building…":`Export this view (${n.toLocaleString()})`}
    </button>
  );
}

function PinBanner({ pin, onClear }) {
  if (!pin) return null;
  return (
    <div style={{background:C.brandLight,border:"1px solid #e8c8c8",borderRadius:12,padding:"10px 16px",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
      <span style={{fontSize:12.5,color:C.brand}}>Showing {pin.ids.size} item{pin.ids.size!==1?"s":""} linked to {pin.label}</span>
      <button onClick={onClear} style={{...btn,padding:"5px 11px",color:C.brand}}>Show all</button>
    </div>
  );
}

const inp = {
  fontFamily:F,fontSize:13,color:C.text,background:C.surface,
  border:`1px solid ${C.border}`,borderRadius:10,padding:"9px 13px",
  WebkitAppearance:"none",appearance:"none",transition:"border-color 0.15s, box-shadow 0.15s",
};
const btn = {...inp,cursor:"pointer",fontSize:12,color:C.textSecondary,padding:"9px 13px"};
const th = {
  padding:"11px 16px",textAlign:"left",fontSize:11,fontWeight:600,letterSpacing:"0.05em",
  textTransform:"uppercase",color:C.textSecondary,background:C.surfaceAlt,
  borderBottom:`1px solid ${C.border}`,cursor:"pointer",userSelect:"none",whiteSpace:"nowrap",fontFamily:F,
};
const td = {padding:"12px 16px",fontSize:13,color:C.text,borderBottom:`1px solid ${C.border}`,verticalAlign:"middle",fontFamily:F};
const ellipsis = w => ({display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:w});
const sectionLabel = {fontSize:11,fontWeight:600,color:C.textSecondary,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:12};
const filterBar = {background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,boxShadow:C.shadowSm,padding:"13px 16px",marginBottom:16,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"};
const tableCard = {background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,boxShadow:C.shadow,overflow:"hidden"};

function useSort(initialField, initialDir) {
  const [sortField, setSortField] = useState(initialField);
  const [sortDir, setSortDir] = useState(initialDir);
  const sort = f => { if (sortField===f) setSortDir(d=>d==="asc"?"desc":"asc"); else { setSortField(f); setSortDir("asc"); } };
  const compare = (a, b, rank) => {
    let av = rank ? rank(a) : a[sortField], bv = rank ? rank(b) : b[sortField];
    const aMissing = av == null || av === "", bMissing = bv == null || bv === "";
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;   // blanks always sort last
    if (bMissing) return -1;
    if (typeof av === "string") { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
    const r = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? r : -r;
  };
  return { sortField, sortDir, sort, compare };
}

// ── RFI Tab ───────────────────────────────────────────────────────────────────
function RFITab({ rfis, loading, onExportView, exporting }) {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("All Projects");
  const [flagFilter, setFlagFilter] = useState("All Flags");
  const { sortField, sortDir, sort, compare } = useSort("flag", "asc");

  const projects = useMemo(()=>["All Projects",...[...new Set(rfis.map(r=>r.project_name))].sort()],[rfis]);
  const counts = useMemo(()=>Object.fromEntries(FLAG_ORDER.map(f=>[f,rfis.filter(r=>r.flag===f).length])),[rfis]);

  const filtered = useMemo(()=>{
    let d = rfis;
    if (projectFilter!=="All Projects") d = d.filter(r=>r.project_name===projectFilter);
    if (flagFilter!=="All Flags") d = d.filter(r=>r.flag===flagFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      d = d.filter(r=>[r.subject,r.number,r.ball_in_court,r.received_from,r.assignees,r.project_name].some(v=>String(v??"").toLowerCase().includes(q)));
    }
    const rank = sortField==="flag" ? r=>FLAG_ORDER.indexOf(r.flag) : null;
    return [...d].sort((a,b)=>compare(a,b,rank));
  },[rfis,projectFilter,flagFilter,search,sortField,sortDir]);

  const exportCSV = () => {
    const q = v => `"${String(v??"").replace(/"/g,'""')}"`;
    const h = ["Number","Project","Subject","Status","Ball in Court","Received From","Submitted","Due Date","Days Past Due","Flag"];
    const rows = filtered.map(r=>[r.number,r.project_name,r.subject,r.status,r.ball_in_court,r.received_from,r.submitted_at,r.due_date,r.days_past_due,FLAGS[r.flag]?.label].map(q));
    const blob = new Blob([[h.map(q),...rows].map(r=>r.join(",")).join("\n")],{type:"text/csv"});
    Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`enfield-rfis-${new Date().toISOString().split("T")[0]}.csv`}).click();
  };

  const visibleFlags = FLAG_ORDER.filter(f => counts[f] > 0 || !["past_submitted","no_response"].includes(f));

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div style={sectionLabel}>Status overview, all projects</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {visibleFlags.map(f=>{
            const c = FLAGS[f], count = counts[f]||0, on = flagFilter===f;
            return (
              <button key={f} onClick={()=>setFlagFilter(v=>v===f?"All Flags":f)}
                style={{background:on?c.bg:C.surface,border:`1px solid ${on?c.border:C.border}`,borderRadius:14,padding:"15px 18px",cursor:"pointer",flex:1,minWidth:110,textAlign:"left",boxShadow:on?"none":C.shadowSm}}>
                <div style={{fontSize:28,fontWeight:600,lineHeight:1,letterSpacing:"-0.02em",color:ATTENTION_FLAGS.includes(f)&&count>0?c.color:C.text,fontFamily:F}}>{count}</div>
                <div style={{fontSize:11.5,color:C.textSecondary,marginTop:5,fontWeight:500}}>{c.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={filterBar}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search subject, number, ball in court…" style={{...inp,flex:1,minWidth:220}}/>
        <select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)} style={{...inp,minWidth:200}}>
          {projects.map(p=><option key={p}>{p}</option>)}
        </select>
        <select value={flagFilter} onChange={e=>setFlagFilter(e.target.value)} style={{...inp,minWidth:155}}>
          <option value="All Flags">All Flags</option>
          {FLAG_ORDER.map(f=><option key={f} value={f}>{FLAGS[f].label}</option>)}
        </select>
        {(search||projectFilter!=="All Projects"||flagFilter!=="All Flags")&&(
          <button onClick={()=>{setSearch("");setProjectFilter("All Projects");setFlagFilter("All Flags");}} style={btn}>Clear</button>
        )}
        <button onClick={exportCSV} style={btn}>Download CSV</button>
        <ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>describe([
          flagFilter!=="All Flags" && `Flag: ${FLAGS[flagFilter].label}`,
          projectFilter!=="All Projects" && `Project: ${projectFilter}`,
          search.trim() && `Search: "${search.trim()}"`,
        ])}/>
        <span style={{fontSize:12,color:C.textTertiary,whiteSpace:"nowrap"}}>{filtered.length} of {rfis.length} RFIs</span>
      </div>

      <div style={tableCard}>
        {loading && !rfis.length ? <Spinner label="Loading RFIs…"/> : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>
                <th style={{...th,cursor:"default",width:36,padding:"11px 6px 11px 10px"}}></th>
                {[["Status","flag"],["#","number"],["Project","project_name"],["Subject","subject"],["Ball in Court","ball_in_court"],["Received From","received_from"],["Date Initiated","submitted_at"],["Due Date","due_date"]].map(([l,f])=>(
                  <th key={f} style={th} onClick={()=>sort(f)}>{l}<SortIcon active={sortField===f} dir={sortDir}/></th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((rfi,i)=>{
                  const past = rfi.days_past_due;
                  return (
                    <tr key={rfi.id} style={{background:i%2===0?C.surface:C.surfaceAlt}}>
                      <ProcoreIconBtn url={rfi.procore_url}/>
                      <td style={td}><Badge flag={rfi.flag}/></td>
                      <td style={{...td,fontWeight:600,color:C.brand,fontSize:12,whiteSpace:"nowrap"}}>{rfi.number}</td>
                      <td style={{...td,maxWidth:160}}><span style={{...ellipsis(160),fontSize:12,color:C.textSecondary}} title={rfi.project_name}>{rfi.project_name}</span></td>
                      <td style={{...td,maxWidth:280}}><span style={ellipsis(280)} title={rfi.subject}>{rfi.subject}</span></td>
                      <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{rfi.ball_in_court||<Dash/>}</td>
                      <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{rfi.received_from||<Dash/>}</td>
                      <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{fmt(rfi.submitted_at)||<Dash/>}</td>
                      <td style={{...td,fontSize:12,whiteSpace:"nowrap"}}>
                        {rfi.due_date ? (
                          <div>
                            <span style={{color:past?"#b91c1c":C.textSecondary,fontWeight:past?500:400}}>{fmt(rfi.due_date)}</span>
                            {past&&<div style={{fontSize:10.5,color:"#b91c1c",fontWeight:500,marginTop:1}}>{past}d past due</div>}
                          </div>
                        ) : <Dash/>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length===0&&<div style={{padding:56,textAlign:"center",color:C.textTertiary,fontSize:13}}>No RFIs match these filters.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Submittals Tab ────────────────────────────────────────────────────────────
function SubmittalsTab({ submittals, loading, onExportView, exporting }) {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("All Projects");
  const [contractorFilter, setContractorFilter] = useState("All Contractors");
  const [bicFilter, setBicFilter] = useState("All");
  const [showClosed, setShowClosed] = useState(false);
  const [hideDraft, setHideDraft] = useState(true);
  const [tileFilter, setTileFilter] = useState(null);
  const { sortField, sortDir, sort, compare } = useSort("due_date", "asc");

  const projects    = useMemo(()=>["All Projects",...[...new Set(submittals.map(s=>s.project_name))].sort()],[submittals]);
  const contractors = useMemo(()=>["All Contractors",...[...new Set(submittals.map(s=>s.responsible_contractor).filter(Boolean))].sort()],[submittals]);
  const bicOptions  = useMemo(()=>["All",...[...new Set(submittals.map(s=>s.ball_in_court).filter(Boolean))].sort()],[submittals]);

  const open         = useMemo(()=>submittals.filter(s=>s.is_open && s.status_key!=="draft"),[submittals]);
  const pastDueItems = useMemo(()=>open.filter(s=>s.days_past_due>0),[open]);
  const avgDPD       = pastDueItems.length ? Math.round(pastDueItems.reduce((a,s)=>a+s.days_past_due,0)/pastDueItems.length) : 0;
  const noDueDate    = useMemo(()=>open.filter(s=>!s.due_date),[open]);

  const filtered = useMemo(()=>{
    let d = showClosed ? submittals : submittals.filter(s=>s.is_open);
    if (hideDraft) d = d.filter(s=>s.status_key!=="draft");
    if (tileFilter==="past_due")    d = d.filter(s=>s.days_past_due>0);
    if (tileFilter==="open")        d = d.filter(s=>s.is_open);
    if (tileFilter==="no_due_date") d = d.filter(s=>s.is_open && !s.due_date);
    if (projectFilter!=="All Projects") d = d.filter(s=>s.project_name===projectFilter);
    if (contractorFilter!=="All Contractors") d = d.filter(s=>s.responsible_contractor===contractorFilter);
    if (bicFilter!=="All") d = d.filter(s=>s.ball_in_court===bicFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      d = d.filter(s=>[s.title,s.number,s.spec_section,s.ball_in_court,s.responsible_contractor,s.project_name].some(v=>String(v??"").toLowerCase().includes(q)));
    }
    return [...d].sort((a,b)=>compare(a,b));
  },[submittals,showClosed,hideDraft,tileFilter,projectFilter,contractorFilter,bicFilter,search,sortField,sortDir]);

  const toggleTile = key => setTileFilter(v=>v===key?null:key);

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div style={sectionLabel}>Submittals overview</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <SummaryCard label="Open / Pending" value={open.length} active={tileFilter==="open"} onClick={()=>toggleTile("open")}/>
          <SummaryCard label="Past Due" value={pastDueItems.length} color={pastDueItems.length?"#b91c1c":undefined} active={tileFilter==="past_due"} onClick={()=>toggleTile("past_due")}/>
          <SummaryCard label="Avg Days Past Due" value={avgDPD||"—"} color={avgDPD?"#c2410c":undefined}/>
          <SummaryCard label="No Due Date" value={noDueDate.length} color={noDueDate.length?"#7c3aed":undefined} active={tileFilter==="no_due_date"} onClick={()=>toggleTile("no_due_date")}/>
        </div>
        {tileFilter&&<button onClick={()=>setTileFilter(null)} style={{marginTop:8,fontSize:11.5,color:C.brand,background:"none",border:"none",cursor:"pointer"}}>✕ Clear tile filter</button>}
      </div>

      <div style={filterBar}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, number, spec section…" style={{...inp,flex:1,minWidth:220}}/>
        <select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)} style={{...inp,minWidth:200}}>{projects.map(p=><option key={p}>{p}</option>)}</select>
        <select value={contractorFilter} onChange={e=>setContractorFilter(e.target.value)} style={{...inp,minWidth:180}}>{contractors.map(c=><option key={c}>{c}</option>)}</select>
        <select value={bicFilter} onChange={e=>setBicFilter(e.target.value)} style={{...inp,minWidth:155}}>
          {bicOptions.map(b=><option key={b} value={b}>{b==="All"?"All Ball in Court":b}</option>)}
        </select>
        <button onClick={()=>setHideDraft(v=>!v)} style={{...btn,color:hideDraft?C.brand:C.textSecondary,background:hideDraft?C.brandLight:C.surface,border:`1px solid ${hideDraft?"#e8c8c8":C.border}`}}>
          {hideDraft?"Drafts hidden":"Drafts shown"}
        </button>
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.textSecondary,cursor:"pointer",whiteSpace:"nowrap"}}>
          <input type="checkbox" checked={showClosed} onChange={e=>setShowClosed(e.target.checked)} style={{accentColor:C.brand}}/>
          Show closed
        </label>
        {(search||projectFilter!=="All Projects"||contractorFilter!=="All Contractors"||bicFilter!=="All")&&(
          <button onClick={()=>{setSearch("");setProjectFilter("All Projects");setContractorFilter("All Contractors");setBicFilter("All");}} style={btn}>Clear</button>
        )}
        <ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>describe([
          showClosed ? "Including closed" : "Open only",
          hideDraft && "Drafts hidden",
          tileFilter==="open" && "Open / pending",
          tileFilter==="past_due" && "Past due",
          tileFilter==="no_due_date" && "No due date",
          projectFilter!=="All Projects" && `Project: ${projectFilter}`,
          contractorFilter!=="All Contractors" && `Contractor: ${contractorFilter}`,
          bicFilter!=="All" && `Ball in court: ${bicFilter}`,
          search.trim() && `Search: "${search.trim()}"`,
        ])}/>
        <span style={{fontSize:12,color:C.textTertiary,whiteSpace:"nowrap"}}>{filtered.length} shown</span>
      </div>

      <div style={tableCard}>
        {loading && !submittals.length ? <Spinner label="Loading submittals…"/> : (
          <SubmittalsTable filtered={filtered} sortField={sortField} sortDir={sortDir} sort={sort}/>
        )}
      </div>
    </div>
  );
}

function SubmittalsTable({ filtered, sortField, sortDir, sort }) {
  const scrollRef = useRef(null);
  const topRef = useRef(null);
  const sync = (from, to) => { if (from.current && to.current) to.current.scrollLeft = from.current.scrollLeft; };

  useEffect(()=>{
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(()=>{ if (topRef.current) topRef.current.firstChild.style.width = el.scrollWidth + "px"; });
    obs.observe(el);
    return ()=>obs.disconnect();
  },[]);

  return (
    <>
      <div ref={topRef} onScroll={()=>sync(topRef,scrollRef)} style={{overflowX:"auto",overflowY:"hidden",borderBottom:`1px solid ${C.border}`,height:12}}><div style={{height:1}}/></div>
      <div ref={scrollRef} onScroll={()=>sync(scrollRef,topRef)} style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>
            <th style={{...th,cursor:"default",width:36,padding:"11px 6px 11px 10px"}}></th>
            {[["Project","project_name"],["Sub #","number"],["Spec Section","spec_section"],["Title","title"],["Contractor","responsible_contractor"],["Ball in Court","ball_in_court"],["Status","status"],["Due Date","due_date"],["Rev #","revision_number"]].map(([l,f])=>(
              <th key={f} style={th} onClick={()=>sort(f)}>{l}<SortIcon active={sortField===f} dir={sortDir}/></th>
            ))}
          </tr></thead>
          <tbody>
            {filtered.map((s,i)=>{
              const revHigh = (s.revision_number||0) >= 3;
              const past = s.days_past_due;
              return (
                <tr key={s.id} style={{background:i%2===0?C.surface:C.surfaceAlt}}>
                  <ProcoreIconBtn url={s.procore_url}/>
                  <td style={{...td,maxWidth:150}}><span style={{...ellipsis(150),fontSize:12,color:C.textSecondary}} title={s.project_name}>{safeVal(s.project_name)}</span></td>
                  <td style={{...td,fontWeight:600,color:C.brand,fontSize:12,whiteSpace:"nowrap"}}>{safeVal(s.number)}</td>
                  <td style={{...td,maxWidth:160}}><span style={{...ellipsis(160),fontSize:12,color:C.textSecondary}} title={s.spec_section||""}>{safeVal(s.spec_section)||<Dash/>}</span></td>
                  <td style={{...td,maxWidth:240}}><span style={ellipsis(240)} title={s.title}>{safeVal(s.title)}</span></td>
                  <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{safeVal(s.responsible_contractor)||<Dash/>}</td>
                  <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{safeVal(s.ball_in_court)||<Dash/>}</td>
                  <td style={td}><StatusBadge label={safeVal(s.status)||"unknown"} scheme={SUB_STATUS[s.status_key]}/></td>
                  <td style={{...td,fontSize:12,whiteSpace:"nowrap"}}>
                    {s.due_date ? (
                      <div>
                        <span style={{color:past?"#b91c1c":C.textSecondary,fontWeight:past?500:400}}>{fmt(s.due_date)}</span>
                        {past&&<div style={{fontSize:10.5,color:"#b91c1c",fontWeight:500,marginTop:1}}>{past}d past due</div>}
                      </div>
                    ) : <Dash/>}
                  </td>
                  <td style={{...td,fontSize:12}}>
                    <span style={revHigh?{color:"#c2410c",fontWeight:600,background:"#fff7ed",padding:"2px 7px",borderRadius:6,border:"1px solid #fed7aa"}:{}}>{s.revision_number??0}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length===0&&<div style={{padding:56,textAlign:"center",color:C.textTertiary,fontSize:13}}>No submittals match these filters.</div>}
      </div>
    </>
  );
}

// ── Change Events Tab ─────────────────────────────────────────────────────────
function ChangeEventsTab({ changeEvents, loading, coByEvent, coLoaded, pin, onClearPin, onJump, onExportView, exporting }) {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("All Projects");
  const [openOnly, setOpenOnly] = useState(true);
  const [reasonFilter, setReasonFilter] = useState("All");
  const [createdByFilter, setCreatedByFilter] = useState("All");
  const [hideVoided, setHideVoided] = useState(true);
  const [noCoOnly, setNoCoOnly] = useState(false);
  const { sortField, sortDir, sort, compare } = useSort("estimated_amount", "desc");

  const projects   = useMemo(()=>["All Projects",...[...new Set(changeEvents.map(e=>e.project_name))].sort()],[changeEvents]);
  const reasons    = useMemo(()=>["All",...[...new Set(changeEvents.map(e=>e.change_reason).filter(Boolean))].sort()],[changeEvents]);
  const createdBys = useMemo(()=>[...new Set(changeEvents.map(e=>e.created_by).filter(Boolean))].sort(),[changeEvents]);

  const cosFor = e => coByEvent.get(e.id) || [];
  const openPending   = useMemo(()=>changeEvents.filter(e=>e.is_open),[changeEvents]);
  const totalExposure = useMemo(()=>openPending.reduce((a,e)=>a+(e.estimated_amount||0),0),[openPending]);
  const avgDaysOpen   = openPending.length ? Math.round(openPending.reduce((a,e)=>a+(e.days_open||0),0)/openPending.length) : 0;
  const noCo          = useMemo(()=>coLoaded ? openPending.filter(e=>!(coByEvent.get(e.id)||[]).length) : [],[openPending,coByEvent,coLoaded]);
  const topReason = useMemo(()=>{
    const m = {};
    openPending.forEach(e=>{ if (e.change_reason) m[e.change_reason] = (m[e.change_reason]||0)+1; });
    return Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
  },[openPending]);

  const filtered = useMemo(()=>{
    let d = changeEvents;
    if (pin) {
      d = d.filter(e=>pin.ids.has(e.id));
    } else {
      if (openOnly) d = d.filter(e=>e.is_open);
      if (hideVoided) d = d.filter(e=>!String(e.status_key).includes("void"));
      if (noCoOnly) d = d.filter(e=>!(coByEvent.get(e.id)||[]).length);
      if (projectFilter!=="All Projects") d = d.filter(e=>e.project_name===projectFilter);
      if (reasonFilter!=="All") d = d.filter(e=>e.change_reason===reasonFilter);
      if (createdByFilter!=="All") d = d.filter(e=>e.created_by===createdByFilter);
      if (search.trim()) {
        const q = search.toLowerCase();
        d = d.filter(e=>[e.title,e.number,e.change_reason,e.created_by,e.project_name].some(v=>String(v??"").toLowerCase().includes(q)));
      }
    }
    const rank = sortField==="linked_cos" ? e=>(coByEvent.get(e.id)||[]).length : null;
    return [...d].sort((a,b)=>compare(a,b,rank));
  },[changeEvents,pin,openOnly,hideVoided,noCoOnly,coByEvent,projectFilter,reasonFilter,createdByFilter,search,sortField,sortDir]);

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div style={sectionLabel}>Change events overview</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <SummaryCard label="Open / Pending" value={openPending.length} active={openOnly&&!noCoOnly} onClick={()=>{setOpenOnly(v=>!v);setNoCoOnly(false);}}/>
          <SummaryCard label="Open Exposure" value={fmtCurrency(totalExposure)} color={totalExposure>0?"#9a3412":undefined}/>
          <SummaryCard label="Avg Days Open" value={avgDaysOpen||"—"} color={avgDaysOpen>30?"#c2410c":undefined}/>
          <SummaryCard label="Open, no change order found" value={coLoaded?noCo.length:"—"} color={noCo.length?"#b45309":undefined}
            sub="Not tied to any CO yet" active={noCoOnly} onClick={coLoaded?()=>{setNoCoOnly(v=>!v);setOpenOnly(true);}:undefined}/>
          <SummaryCard label="Top Reason" value={topReason?topReason[1]:"—"} sub={topReason?.[0]} color={topReason?"#0369a1":undefined}/>
        </div>
      </div>

      <PinBanner pin={pin} onClear={onClearPin}/>
      {pin&&<div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>`Change events linked to ${pin.label}`}/>
      </div>}

      <div style={{...filterBar,opacity:pin?0.5:1,pointerEvents:pin?"none":"auto"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, number, reason…" style={{...inp,flex:1,minWidth:200}}/>
        <select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)} style={{...inp,minWidth:200}}>{projects.map(p=><option key={p}>{p}</option>)}</select>
        <select value={openOnly?"open":"all"} onChange={e=>setOpenOnly(e.target.value==="open")} style={{...inp,minWidth:150}}>
          <option value="open">Open &amp; pending</option>
          <option value="all">All statuses</option>
        </select>
        <select value={reasonFilter} onChange={e=>setReasonFilter(e.target.value)} style={{...inp,minWidth:160}}>
          {reasons.map(r=><option key={r} value={r}>{r==="All"?"All Reasons":r}</option>)}
        </select>
        <select value={createdByFilter} onChange={e=>setCreatedByFilter(e.target.value)} style={{...inp,minWidth:160}}>
          <option value="All">All Created By</option>
          {createdBys.map(b=><option key={b} value={b}>{b}</option>)}
        </select>
        <button onClick={()=>setHideVoided(v=>!v)} style={{...btn,color:hideVoided?C.brand:C.textSecondary,background:hideVoided?C.brandLight:C.surface,border:`1px solid ${hideVoided?"#e8c8c8":C.border}`}}>
          {hideVoided?"Voided hidden":"Voided shown"}
        </button>
        {(search||projectFilter!=="All Projects"||reasonFilter!=="All"||createdByFilter!=="All"||noCoOnly)&&(
          <button onClick={()=>{setSearch("");setProjectFilter("All Projects");setReasonFilter("All");setCreatedByFilter("All");setNoCoOnly(false);}} style={btn}>Clear</button>
        )}
        {!pin&&<ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>describe([
          openOnly ? "Open & pending" : "All statuses",
          hideVoided && "Voided hidden",
          noCoOnly && "No change order found",
          projectFilter!=="All Projects" && `Project: ${projectFilter}`,
          reasonFilter!=="All" && `Reason: ${reasonFilter}`,
          createdByFilter!=="All" && `Created by: ${createdByFilter}`,
          search.trim() && `Search: "${search.trim()}"`,
        ])}/>}
        <span style={{fontSize:12,color:C.textTertiary,whiteSpace:"nowrap"}}>{filtered.length} shown</span>
      </div>

      <div style={tableCard}>
        {loading && !changeEvents.length ? <Spinner label="Loading change events…"/> : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>
                <th style={{...th,cursor:"default",width:36,padding:"11px 6px 11px 10px"}}></th>
                {[["Project","project_name"],["Event #","number"],["Title","title"],["Status","status"],["Change Orders","linked_cos"],["Created By","created_by"],["Created","created_at"],["Days Open","days_open"],["Latest Price","estimated_amount"]].map(([l,f])=>(
                  <th key={f} style={th} onClick={()=>sort(f)}>{l}<SortIcon active={sortField===f} dir={sortDir}/></th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((e,i)=>{
                  const bigAmt = (e.estimated_amount||0) > 50000;
                  const cos = cosFor(e);
                  const chips = cos.map(co=>({
                    key: co.id, scheme: CO_KIND[co.kind],
                    label: `${CO_KIND[co.kind].short} ${co.number}`.trim(),
                    title: `${CO_KIND[co.kind].label} ${co.number}: ${co.title} (${co.status})`,
                  }));
                  return (
                    <tr key={e.id} style={{background:i%2===0?C.surface:C.surfaceAlt}}>
                      <ProcoreIconBtn url={e.procore_url}/>
                      <td style={{...td,maxWidth:150}}><span style={{...ellipsis(150),fontSize:12,color:C.textSecondary}} title={e.project_name}>{safeVal(e.project_name)}</span></td>
                      <td style={{...td,fontWeight:600,color:C.brand,fontSize:12,whiteSpace:"nowrap"}}>{safeVal(e.number)}</td>
                      <td style={{...td,maxWidth:220}}><span style={ellipsis(220)} title={e.title}>{safeVal(e.title)}</span></td>
                      <td style={td}><StatusBadge label={safeVal(e.status)||"unknown"} scheme={CE_STATUS[e.status_key]}/></td>
                      <td style={td}>
                        <LinkChips items={chips} state={coLoaded?"ok":"pending"} emptyLabel={e.is_open?"None found":"None"}
                          onOpen={()=>onJump("changeOrders", cos.map(c=>c.id), `change event ${e.number}`)}/>
                      </td>
                      <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{safeVal(e.created_by)||<Dash/>}</td>
                      <td style={{...td,fontSize:12,color:C.textSecondary,whiteSpace:"nowrap"}}>{fmt(e.created_at)||<Dash/>}</td>
                      <td style={{...td,fontSize:12,color:C.textSecondary}}>{e.days_open!=null?`${e.days_open}d`:<Dash/>}</td>
                      <td style={{...td,fontSize:12,fontWeight:bigAmt?700:400,color:bigAmt?"#9a3412":C.text,textAlign:"right",whiteSpace:"nowrap"}}>
                        {e.estimated_amount!=null?fmtCurrency(e.estimated_amount):<Dash/>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length===0&&<div style={{padding:56,textAlign:"center",color:C.textTertiary,fontSize:13}}>No change events match these filters.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Change Orders Tab ─────────────────────────────────────────────────────────
function ChangeOrdersTab({ changeOrders, loading, ceById, ceLoaded, pin, onClearPin, onJump, onExportView, exporting }) {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("All Projects");
  const [kindFilter, setKindFilter] = useState("all");
  const [contractFilter, setContractFilter] = useState("All Contracts");
  const [openOnly, setOpenOnly] = useState(true);
  const [tileFilter, setTileFilter] = useState(null);
  const { sortField, sortDir, sort, compare } = useSort("amount", "desc");

  const projects  = useMemo(()=>["All Projects",...[...new Set(changeOrders.map(c=>c.project_name))].sort()],[changeOrders]);
  const contracts = useMemo(()=>["All Contracts",...[...new Set(changeOrders.map(c=>c.vendor||c.contract_label).filter(Boolean))].sort()],[changeOrders]);

  const isUnlinked = c => c.links_known && !(c.linked_events||[]).length;
  const eventStillOpen = c => c.status_key==="approved" && (c.linked_events||[]).some(ev=>ceById.get(ev.id)?.is_open);

  const open        = useMemo(()=>changeOrders.filter(c=>c.is_open),[changeOrders]);
  const pendingVal  = useMemo(()=>open.filter(c=>c.kind!=="pco"||!changeOrders.some(p=>p.kind==="prime_co"&&(p.linked_pcos||[]).some(x=>x.id===c.id))).reduce((a,c)=>a+(c.amount||0),0),[open,changeOrders]);
  const unlinked    = useMemo(()=>open.filter(isUnlinked),[open]);
  const staleEvents = useMemo(()=>ceLoaded?changeOrders.filter(eventStillOpen):[],[changeOrders,ceById,ceLoaded]);
  const pastDue     = useMemo(()=>open.filter(c=>c.days_past_due>0),[open]);

  const filtered = useMemo(()=>{
    let d = changeOrders;
    if (pin) {
      d = d.filter(c=>pin.ids.has(c.id));
    } else {
      if (tileFilter==="unlinked")   d = d.filter(c=>c.is_open && isUnlinked(c));
      else if (tileFilter==="stale") d = d.filter(eventStillOpen);
      else if (tileFilter==="late")  d = d.filter(c=>c.is_open && c.days_past_due>0);
      else if (openOnly)             d = d.filter(c=>c.is_open);
      if (kindFilter!=="all") d = d.filter(c=>c.kind===kindFilter);
      if (projectFilter!=="All Projects") d = d.filter(c=>c.project_name===projectFilter);
      if (contractFilter!=="All Contracts") d = d.filter(c=>(c.vendor||c.contract_label)===contractFilter);
      if (search.trim()) {
        const q = search.toLowerCase();
        d = d.filter(c=>[c.title,c.number,c.vendor,c.contract_label,c.project_name,c.package_label,c.change_reason].some(v=>String(v??"").toLowerCase().includes(q)));
      }
    }
    const rank = sortField==="linked_events" ? c=>(c.linked_events||[]).length : sortField==="kind" ? c=>CO_KIND[c.kind].label : null;
    return [...d].sort((a,b)=>compare(a,b,rank));
  },[changeOrders,pin,tileFilter,openOnly,kindFilter,projectFilter,contractFilter,search,ceById,sortField,sortDir]);

  const toggleTile = key => setTileFilter(v=>v===key?null:key);

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div style={sectionLabel}>Change orders overview</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <SummaryCard label="Open / Pending" value={open.length} active={openOnly&&!tileFilter} onClick={()=>{setOpenOnly(v=>!v);setTileFilter(null);}}/>
          <SummaryCard label="Pending value" value={fmtCurrency(pendingVal)} sub="PCOs already in a prime CO counted once" color={pendingVal>0?"#9a3412":undefined}/>
          <SummaryCard label="Open, no change event" value={unlinked.length} sub="Created outside Change Events" color={unlinked.length?"#b45309":undefined} active={tileFilter==="unlinked"} onClick={()=>toggleTile("unlinked")}/>
          <SummaryCard label="Approved, event still open" value={ceLoaded?staleEvents.length:"—"} sub="Event may need closing" color={staleEvents.length?"#b91c1c":undefined} active={tileFilter==="stale"} onClick={ceLoaded?()=>toggleTile("stale"):undefined}/>
          <SummaryCard label="Past Due" value={pastDue.length} color={pastDue.length?"#b91c1c":undefined} active={tileFilter==="late"} onClick={()=>toggleTile("late")}/>
        </div>
        {tileFilter&&<button onClick={()=>setTileFilter(null)} style={{marginTop:8,fontSize:11.5,color:C.brand,background:"none",border:"none",cursor:"pointer"}}>✕ Clear tile filter</button>}
      </div>

      <PinBanner pin={pin} onClear={onClearPin}/>
      {pin&&<div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>`Change orders linked to ${pin.label}`}/>
      </div>}

      <div style={{...filterBar,opacity:pin?0.5:1,pointerEvents:pin?"none":"auto"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, number, vendor…" style={{...inp,flex:1,minWidth:200}}/>
        <select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)} style={{...inp,minWidth:200}}>{projects.map(p=><option key={p}>{p}</option>)}</select>
        <select value={kindFilter} onChange={e=>setKindFilter(e.target.value)} style={{...inp,minWidth:160}}>
          <option value="all">All CO types</option>
          {Object.entries(CO_KIND).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={contractFilter} onChange={e=>setContractFilter(e.target.value)} style={{...inp,minWidth:180}}>{contracts.map(c=><option key={c}>{c}</option>)}</select>
        <select value={openOnly?"open":"all"} onChange={e=>setOpenOnly(e.target.value==="open")} style={{...inp,minWidth:150}}>
          <option value="open">Open &amp; pending</option>
          <option value="all">All statuses</option>
        </select>
        {(search||projectFilter!=="All Projects"||kindFilter!=="all"||contractFilter!=="All Contracts")&&(
          <button onClick={()=>{setSearch("");setProjectFilter("All Projects");setKindFilter("all");setContractFilter("All Contracts");}} style={btn}>Clear</button>
        )}
        {!pin&&<ExportViewButton rows={filtered} busy={exporting} onExport={onExportView} describeView={()=>describe([
          tileFilter==="unlinked" ? "Open, no change event"
            : tileFilter==="stale" ? "Approved, change event still open"
            : tileFilter==="late" ? "Past due"
            : openOnly ? "Open & pending" : "All statuses",
          kindFilter!=="all" && `Type: ${CO_KIND[kindFilter].label}`,
          projectFilter!=="All Projects" && `Project: ${projectFilter}`,
          contractFilter!=="All Contracts" && `Contract: ${contractFilter}`,
          search.trim() && `Search: "${search.trim()}"`,
        ])}/>}
        <span style={{fontSize:12,color:C.textTertiary,whiteSpace:"nowrap"}}>{filtered.length} shown</span>
      </div>

      <div style={tableCard}>
        {loading && !changeOrders.length ? <Spinner label="Loading change orders…"/> : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>
                <th style={{...th,cursor:"default",width:36,padding:"11px 6px 11px 10px"}}></th>
                {[["Type","kind"],["Project","project_name"],["CO #","number"],["Title","title"],["Contract","contract_label"],["Status","status"],["Change Events","linked_events"],["Due Date","due_date"],["Amount","amount"]].map(([l,f])=>(
                  <th key={f} style={th} onClick={()=>sort(f)}>{l}<SortIcon active={sortField===f} dir={sortDir}/></th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((c,i)=>{
                  const k = CO_KIND[c.kind];
                  const events = c.linked_events || [];
                  const chips = events.map(ev=>{
                    const ce = ceById.get(ev.id);
                    const num = ce?.number ?? ev.number ?? ev.id;
                    return {
                      key: ev.id, label: `CE ${num}`,
                      scheme: ce && !ce.is_open ? NEUTRAL : { color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd" },
                      title: ce ? `${ce.title} (${ce.status})` : "Change event not in the current list (it may be on an inactive project)",
                    };
                  });
                  const linkState = events.length ? "ok" : c.links_known ? "ok" : "unknown";
                  const past = c.days_past_due;
                  const big = (c.amount||0) > 50000;
                  return (
                    <tr key={c.id} style={{background:i%2===0?C.surface:C.surfaceAlt}}>
                      <ProcoreIconBtn url={c.procore_url}/>
                      <td style={td}><span style={{...chipStyle(k),cursor:"default"}}>{k.short}</span></td>
                      <td style={{...td,maxWidth:150}}><span style={{...ellipsis(150),fontSize:12,color:C.textSecondary}} title={c.project_name}>{c.project_name}</span></td>
                      <td style={{...td,fontWeight:600,color:C.brand,fontSize:12,whiteSpace:"nowrap"}}>{c.number||<Dash/>}</td>
                      <td style={{...td,maxWidth:240}}>
                        <span style={ellipsis(240)} title={c.title}>{c.title}</span>
                        {c.kind==="pco"&&c.package_label&&<span style={{...ellipsis(240),fontSize:10.5,color:C.textTertiary,marginTop:2}} title={c.package_label}>In {c.package_label}</span>}
                      </td>
                      <td style={{...td,maxWidth:170}}><span style={{...ellipsis(170),fontSize:12,color:C.textSecondary}} title={c.contract_label||""}>{c.vendor||c.contract_label||<Dash/>}</span></td>
                      <td style={td}><StatusBadge label={c.status||"unknown"} scheme={coStatusScheme(c.status_key)}/></td>
                      <td style={td}>
                        <LinkChips items={chips} state={linkState} emptyLabel={c.is_open?"None found":"None"}
                          onOpen={()=>onJump("changeEvents", events.map(ev=>ev.id), `${k.short} ${c.number}`)}/>
                      </td>
                      <td style={{...td,fontSize:12,whiteSpace:"nowrap"}}>
                        {c.due_date ? (
                          <div>
                            <span style={{color:past?"#b91c1c":C.textSecondary,fontWeight:past?500:400}}>{fmt(c.due_date)}</span>
                            {past&&<div style={{fontSize:10.5,color:"#b91c1c",fontWeight:500,marginTop:1}}>{past}d past due</div>}
                          </div>
                        ) : <Dash/>}
                      </td>
                      <td style={{...td,fontSize:12,fontWeight:big?700:400,color:big?"#9a3412":C.text,textAlign:"right",whiteSpace:"nowrap"}}>
                        {c.amount!=null?fmtCurrency(c.amount):<Dash/>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length===0&&<div style={{padding:56,textAlign:"center",color:C.textTertiary,fontSize:13}}>No change orders match these filters.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Data Health Footer ────────────────────────────────────────────────────────
const SOURCE_LABEL = { HIT:"saved snapshot", INCREMENTAL:"changes synced", FULL:"full rebuild", SYNCING:"sync already running" };

function DataHealthFooter({ tabs, rateLimit, onFullRebuild, busy }) {
  return (
    <div style={{marginTop:20,borderTop:`1px solid ${C.border}`,paddingTop:16,display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-start"}}>
        <span style={{...sectionLabel,marginBottom:0,marginTop:3}}>Data health</span>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",flex:1}}>
          {TABS.map(t=>{
            const tab = tabs[t.id];
            const m = tab.meta;
            const skipped = m?.skipped || [];
            const status = tab.error ? "error" : tab.loading ? "loading" : !tab.loaded ? "idle" : skipped.length ? "warn" : "ok";
            const s = {
              ok:      { color:"#15803d", bg:"#f0fdf4", border:"#bbf7d0", dot:"#15803d", icon:"✓" },
              warn:    { color:"#92400e", bg:"#fffbeb", border:"#fcd34d", dot:"#f59e0b", icon:"!" },
              error:   { color:"#b91c1c", bg:"#fef2f2", border:"#fecaca", dot:"#b91c1c", icon:"✗" },
              loading: { color:"#0369a1", bg:"#f0f9ff", border:"#bae6fd", dot:"#0369a1", icon:"" },
              idle:    { color:"#6b7280", bg:"#f9fafb", border:"#e5e7eb", dot:"#9ca3af", icon:"–" },
            }[status];
            return (
              <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",borderRadius:10,background:s.bg,border:`1px solid ${s.border}`,minWidth:200}}>
                <span style={status==="loading"
                  ? {width:16,height:16,borderRadius:"50%",border:`2px solid ${s.border}`,borderTopColor:s.dot,animation:"spin 0.75s linear infinite",flexShrink:0}
                  : {width:18,height:18,borderRadius:"50%",background:s.dot,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>
                  {s.icon}
                </span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:s.color}}>{t.label}</div>
                  <div style={{fontSize:10.5,color:s.color,opacity:0.85,marginTop:1}}>
                    {status==="idle"&&"Not loaded"}
                    {status==="loading"&&(tab.loadingLabel||"Loading…")}
                    {status==="error"&&tab.error}
                    {(status==="ok"||status==="warn")&&m&&<>{m.total.toLocaleString()} records in {m.withData} of your {m.projectCount ?? m.withData + m.withNone} projects</>}
                    {skipped.length>0&&<span style={{color:"#b91c1c",fontWeight:600}}>, {skipped.length} failed</span>}
                  </div>
                  {skipped.length>0&&<div style={{fontSize:10,color:"#92400e",marginTop:2,...ellipsis(240)}} title={skipped.join(", ")}>Failed last sync: {skipped.join(", ")}</div>}
                  {m?.unsynced>0&&<div style={{fontSize:10,color:"#92400e",marginTop:2}}>{m.unsynced} project{m.unsynced!==1?"s":""} not pulled yet</div>}
                  {m?.notes?.length>0&&<div style={{fontSize:10,color:"#92400e",marginTop:2,...ellipsis(240),cursor:"help"}} title={m.notes.join("\n")}>{m.notes.length} partial result{m.notes.length!==1?"s":""} (hover for details)</div>}
                </div>
                {tab.meta?.syncedAt&&(status==="ok"||status==="warn")&&(
                  <div style={{fontSize:10,color:s.color,opacity:0.75,whiteSpace:"nowrap",textAlign:"right"}}>
                    {SOURCE_LABEL[tab.cacheStatus]||""}<br/>{ageText(tab.meta.syncedAt)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <span style={{fontSize:11,color:C.textTertiary}}>
          Enfield Enterprises, LLC, Procore Monitor.{" "}
          <button onClick={onFullRebuild} disabled={busy} title="Re-downloads every record. Use if something looks wrong or deleted items still show."
            style={{background:"none",border:"none",color:C.brand,cursor:busy?"not-allowed":"pointer",fontSize:11,padding:0,textDecoration:"underline"}}>
            Full rebuild
          </button>
        </span>
        {rateLimit?.limit!=null&&(
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:11,color:C.textTertiary}}>Procore API limit</span>
            <div style={{width:80,height:5,background:C.border,borderRadius:3,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${Math.min(rateLimit.percentUsed||0,100)}%`,background:(rateLimit.percentUsed||0)>80?"#b91c1c":(rateLimit.percentUsed||0)>50?"#c2410c":"#15803d"}}/>
            </div>
            <span style={{fontSize:11,fontWeight:500,color:rateLimit.remaining<200?"#b91c1c":rateLimit.remaining<600?"#c2410c":C.textTertiary}}>
              {rateLimit.remaining?.toLocaleString()} of {rateLimit.limit?.toLocaleString()} left
            </span>
            {rateLimit.resetAt&&<span style={{fontSize:10,color:C.textTertiary}}>(resets {new Date(rateLimit.resetAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})})</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Header pieces ─────────────────────────────────────────────────────────────
function CompanyPicker({ session, onSwitch, disabled }) {
  if (!session?.company) return null;
  const many = session.companies.length > 1;
  return (
    <div style={{display:"flex",flexDirection:"column",lineHeight:1.2}}>
      <span style={{fontSize:10.5,color:C.textTertiary}}>Procore company</span>
      {many ? (
        <select value={session.company.id} disabled={disabled} onChange={e=>onSwitch(e.target.value)}
          title="Switch Procore company"
          style={{...inp,padding:"3px 26px 3px 8px",fontSize:12.5,fontWeight:600,borderRadius:7,maxWidth:260,
            background:`${C.surface} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23851e20'/%3E%3C/svg%3E") no-repeat right 9px center`}}>
          {session.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ) : (
        <span style={{fontSize:12.5,fontWeight:600,color:C.text}}>{session.company.name}</span>
      )}
    </div>
  );
}

function AgePill({ syncedAt, onSync, busy }) {
  if (!syncedAt) return null;
  const h = ageHours(syncedAt);
  const tone = h >= STALE_ALERT_HOURS ? {bg:"#fef2f2",fg:"#b91c1c",bd:"#fecaca"}
    : h >= STALE_WARN_HOURS ? {bg:"#fffbeb",fg:"#92400e",bd:"#fcd34d"}
    : {bg:"#f0fdf4",fg:"#15803d",bd:"#bbf7d0"};
  return (
    <button onClick={onSync} disabled={busy}
      title={`Oldest data on screen was synced ${new Date(syncedAt).toLocaleString()}. Click to sync.`}
      style={{fontFamily:F,fontSize:11,fontWeight:500,padding:"3px 9px",borderRadius:7,background:tone.bg,color:tone.fg,border:`1px solid ${tone.bd}`,whiteSpace:"nowrap",cursor:busy?"default":"pointer"}}>
      Data from {ageText(syncedAt)}
    </button>
  );
}

function SyncReminder({ syncedAt, onSync, onSnooze }) {
  const hrs = ageHours(syncedAt);
  const urgent = hrs >= STALE_ALERT_HOURS;
  const tone = urgent ? {bg:"#fef2f2",bd:"#fecaca",fg:"#b91c1c"} : {bg:"#fffbeb",bd:"#fcd34d",fg:"#92400e"};
  return (
    <div role="status" style={{background:tone.bg,border:`1px solid ${tone.bd}`,borderRadius:12,padding:"12px 18px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
      <div style={{fontSize:12.5,color:tone.fg}}>
        <b>{urgent ? "This data is over a day old." : "Time to sync."}</b>{" "}
        Some of what you're seeing was last pulled from Procore {ageText(syncedAt)}, so recent changes may be missing.
      </div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={onSnooze} style={{...btn,padding:"7px 12px"}}>Remind me later</button>
        <button onClick={onSync} style={{background:C.brand,color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap"}}>Sync with Procore</button>
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
const TABS = [
  { id:"rfis",         label:"RFIs",          noun:"RFIs" },
  { id:"submittals",   label:"Submittals",    noun:"submittals" },
  { id:"changeEvents", label:"Change Events", noun:"change events" },
  { id:"changeOrders", label:"Change Orders", noun:"change orders" },
];
const ENDPOINTS = { rfis:"/api/rfis", submittals:"/api/submittals", changeEvents:"/api/change-events", changeOrders:"/api/change-orders" };
const mkTabState = () => ({ data:[], loaded:false, loading:false, loadingLabel:null, error:null, cacheStatus:null, meta:null });
const mkTabs = () => ({ rfis:mkTabState(), submittals:mkTabState(), changeEvents:mkTabState(), changeOrders:mkTabState() });

class AuthError extends Error {}
const goLogin = () => { window.location.href = "/api/auth"; };

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionError, setSessionError] = useState(null);
  const [activeTab, setActiveTab] = useState("rfis");
  const [tabs, setTabs] = useState(mkTabs);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rateLimit, setRateLimit] = useState(null);
  const [pin, setPin] = useState(null); // { tab, ids:Set, label } — "show only these linked items"
  const [, setTick] = useState(0);          // re-render every minute so data age stays current
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const epoch = useRef(0); // bumps on company switch so stale responses are ignored
  const autoSyncDone = useRef(false);

  const patchTab = (id, patch) => setTabs(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const fetchRateLimit = useCallback(async () => {
    try { const r = await fetch("/api/rate-limit"); if (r.ok) setRateLimit(await r.json()); } catch {}
  }, []);

  // mode: "read" (snapshot only) | "sync" (changes since last sync) | "full" (rebuild)
  const loadTab = useCallback(async (tabId, mode) => {
    const myEpoch = epoch.current;
    const noun = TABS.find(t=>t.id===tabId).noun;
    const label = mode==="read" ? "Opening saved data…" : mode==="sync" ? `Syncing ${noun} from Procore…` : `Rebuilding ${noun} from Procore…`;
    patchTab(tabId, { loading:true, loadingLabel:label, error:null });
    const qs = mode==="sync" ? "?sync=true" : mode==="full" ? "?force=true" : "";
    try {
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await fetch(ENDPOINTS[tabId] + qs);
        if (res.status !== 409 || attempt > 40) break;          // another sync is running for this company
        patchTab(tabId, { loadingLabel:"Waiting for a sync already in progress…" });
        await sleep(4000);
      }
      if (res.status === 401) throw new AuthError();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      if (epoch.current !== myEpoch) return;
      const rawMeta = res.headers.get("X-Sync-Summary");
      let meta = null;
      try { meta = rawMeta ? JSON.parse(decodeURIComponent(rawMeta)) : null; } catch {}
      if (res.headers.get("X-Cache-Write") === "failed") console.warn(`[${tabId}] snapshot could not be saved to Redis`);
      setTabs(prev => ({ ...prev, [tabId]: { data, loaded:true, loading:false, loadingLabel:null, error:null, cacheStatus:res.headers.get("X-Cache"), meta } }));
      return res.headers.get("X-Cache");
    } catch (e) {
      if (e instanceof AuthError) { goLogin(); throw e; }
      if (epoch.current === myEpoch) patchTab(tabId, { loading:false, loadingLabel:null, error:e.message });
    }
  }, []);

  // One tab at a time so we never fire three Procore syncs in parallel
  const loadAll = useCallback(async (mode) => {
    setBusy(true);
    let synced = false;
    try {
      for (const t of TABS) {
        const status = await loadTab(t.id, mode);
        if (status && status !== "HIT") synced = true;
      }
    } catch { /* redirecting to login */ }
    finally {
      setBusy(false);
      if (synced || mode !== "read") fetchRateLimit();
    }
  }, [loadTab, fetchRateLimit]);

  // Startup: who am I → open saved data (no Procore calls unless there is no snapshot yet)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/session");
        if (r.status === 401) return goLogin();
        const s = await r.json();
        if (!r.ok) throw new Error(s.error || `Error ${r.status}`);
        if (!s.company) throw new Error("Your Procore login has no companies this app can access.");
        setSession(s);
        fetchRateLimit();
        await loadAll("read");
      } catch (e) {
        setSessionError(e.message);
      }
    })();
  }, []);

  const ceById = useMemo(() => new Map(tabs.changeEvents.data.map(e => [e.id, e])), [tabs.changeEvents.data]);
  const coByEvent = useMemo(() => {
    const m = new Map();
    for (const co of tabs.changeOrders.data) {
      for (const ev of co.linked_events || []) {
        if (!m.has(ev.id)) m.set(ev.id, []);
        m.get(ev.id).push(co);
      }
    }
    return m;
  }, [tabs.changeOrders.data]);

  const jump = (tab, ids, label) => {
    setPin({ tab, ids: new Set(ids), label });
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const openTab = tab => { setActiveTab(tab); if (pin && pin.tab !== tab) setPin(null); };

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const oldestSync = useMemo(() => {
    const times = TABS.map(t=>tabs[t.id].meta?.syncedAt).filter(Boolean);
    return times.length ? times.sort()[0] : null;
  }, [tabs]);

  // Optional auto-sync (off by default — see AUTO_SYNC_AFTER_HOURS)
  useEffect(() => {
    if (AUTO_SYNC_AFTER_HOURS == null || autoSyncDone.current || busy || !oldestSync) return;
    if (ageHours(oldestSync) >= AUTO_SYNC_AFTER_HOURS) { autoSyncDone.current = true; loadAll("sync"); }
  }, [oldestSync, busy, loadAll]);

  const switchCompany = async (companyId) => {
    if (companyId === session?.company?.id) return;
    setBusy(true);
    try {
      const r = await fetch("/api/session", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ companyId }) });
      if (r.status === 401) return goLogin();
      const s = await r.json();
      if (!r.ok) throw new Error(s.error || `Error ${r.status}`);
      epoch.current++;
      autoSyncDone.current = false;
      setSession(s);
      setPin(null);
      setTabs(mkTabs());
      await loadAll("read");
    } catch (e) {
      alert(`Could not switch company: ${e.message}`);
      setBusy(false);
    }
  };

  const fullRebuild = () => {
    if (window.confirm("Full rebuild re-downloads every record for all of your projects and uses a lot of Procore API calls. Other people's projects are not affected. Continue?")) loadAll("full");
  };

  const [exportingView, setExportingView] = useState(false);

  // Adds the link text used in Excel to change events / change orders
  const enrichCE = rows => rows.map(e => ({
    ...e,
    linked_cos_label: (coByEvent.get(e.id) || []).map(co => `${CO_KIND[co.kind].short} ${co.number}`.trim()).join(", ") || "None found",
  }));
  const enrichCO = rows => rows.map(co => ({
    ...co,
    kind_label: CO_KIND[co.kind].label,
    linked_events_label: (co.linked_events || []).length
      ? co.linked_events.map(ev => `CE ${ceById.get(ev.id)?.number ?? ev.number ?? ev.id}`).join(", ")
      : co.links_known ? "None found" : "Not available",
  }));
  const exportMeta = () => ({
    companyName: session?.company?.name,
    flagLabel: f => FLAGS[f]?.label || f,
    asOf: oldestSync ? new Date(oldestSync).toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"}) : "unknown",
  });
  const loadExcel = async () => { const mod = await import("exceljs"); return mod.default || mod; };
  const download = async (wb, name) => {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const co = (session?.company?.name || "Procore").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "");
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href:url, download:`${co}_${name}_${new Date().toISOString().split("T")[0]}.xlsx` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const wb = buildWorkbook(await loadExcel(), {
        rfis: tabs.rfis.data, submittals: tabs.submittals.data,
        changeEvents: enrichCE(tabs.changeEvents.data), changeOrders: enrichCO(tabs.changeOrders.data),
        ...exportMeta(),
      });
      await download(wb, "Procore_Report");
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  // "Export this view": only the rows currently shown, in the order shown
  const exportView = kind => async (rows, filterText) => {
    setExportingView(true);
    try {
      const prepared = kind === "changeEvents" ? enrichCE(rows) : kind === "changeOrders" ? enrichCO(rows) : rows;
      const label = TABS.find(t => t.id === kind).label;
      const wb = buildViewWorkbook(await loadExcel(), { kind, rows: prepared, title: `${label}, filtered view`, filterText, ...exportMeta() });
      await download(wb, `${label.replace(/\s+/g, "_")}_View`);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      setExportingView(false);
    }
  };

  const unsyncedMax = Math.max(0, ...TABS.map(t => tabs[t.id].meta?.unsynced || 0));
  const showReminder = !!oldestSync && !busy
    && ageHours(oldestSync) >= SYNC_REMINDER_HOURS
    && Date.now() >= snoozeUntil;
  const currentTab = tabs[activeTab];
  const allLoaded = TABS.every(t => tabs[t.id].loaded);
  const rfiAlerts = useMemo(()=>tabs.rfis.data.filter(r=>ATTENTION_FLAGS.includes(r.flag)).length,[tabs.rfis.data]);

  if (sessionError) {
    return (
      <div style={{fontFamily:F,padding:60,textAlign:"center"}}>
        <div style={{fontSize:15,fontWeight:600,color:C.brand}}>Procore Monitor could not start</div>
        <div style={{fontSize:13,color:C.textSecondary,margin:"8px 0 18px"}}>{sessionError}</div>
        <button onClick={goLogin} style={{background:C.brand,color:"#fff",border:"none",borderRadius:10,padding:"9px 18px",cursor:"pointer",fontFamily:F}}>Sign in to Procore</button>
      </div>
    );
  }

  return (
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:F}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:${C.bg};-webkit-font-smoothing:antialiased}
        input:focus,select:focus,button:focus-visible,a:focus-visible{border-color:${C.brand}!important;box-shadow:0 0 0 3px ${C.brandLight}!important;outline:none}
        .pm-link:hover{background:#f0d0d0!important}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-thumb{background:${C.borderStrong};border-radius:3px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media (prefers-reduced-motion: reduce){*{animation-duration:2s!important}}
      `}</style>

      <header style={{background:"rgba(255,255,255,0.9)",backdropFilter:"saturate(180%) blur(20px)",WebkitBackdropFilter:"saturate(180%) blur(20px)",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,zIndex:100,minHeight:60,padding:"8px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:13,flexWrap:"wrap"}}>
          <div style={{width:30,height:30,borderRadius:8,background:C.brand,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{color:"#fff",fontSize:13,fontWeight:700}}>E</span>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:C.text,lineHeight:1.2}}>Enfield Enterprises</div>
            <div style={{fontSize:11,color:C.textSecondary,marginTop:1}}>Procore Monitor</div>
          </div>
          <div style={{width:1,height:26,background:C.border,margin:"0 2px"}}/>
          <CompanyPicker session={session} onSwitch={switchCompany} disabled={busy}/>
          <AgePill syncedAt={oldestSync} onSync={()=>loadAll("sync")} busy={busy}/>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          {rfiAlerts>0&&(
            <button onClick={()=>openTab("rfis")} style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"5px 12px",fontSize:11.5,color:"#b91c1c",fontWeight:500,cursor:"pointer"}}>
              {rfiAlerts} RFI{rfiAlerts!==1?"s":""} need attention
            </button>
          )}
          <button onClick={()=>loadAll("sync")} disabled={busy} title="Pull changes from Procore since the last sync"
            style={{...btn,padding:"7px 13px",fontWeight:500,cursor:busy?"not-allowed":"pointer",opacity:busy?0.7:1}}>
            {busy ? "Working…" : "↻ Sync with Procore"}
          </button>
          <button onClick={handleExport} disabled={exporting||!allLoaded}
            title={!allLoaded?"Wait for all three tabs to load":undefined}
            style={{background:C.brand,color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontSize:12,fontWeight:500,cursor:(exporting||!allLoaded)?"not-allowed":"pointer",fontFamily:F,opacity:(exporting||!allLoaded)?0.7:1}}>
            {exporting?"Building…":"Export everything"}
          </button>
          {session?.user&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",lineHeight:1.25,marginLeft:4}}>
              <span style={{fontSize:11.5,color:C.text,fontWeight:500}}>{session.user.name}</span>
              <a href="/api/logout" style={{fontSize:10.5,color:C.textSecondary}}>Sign out</a>
            </div>
          )}
        </div>
      </header>

      <nav style={{background:"rgba(255,255,255,0.9)",borderBottom:`1px solid ${C.border}`,padding:"0 28px",display:"flex",alignItems:"center",gap:2}}>
        {TABS.map(tab=>{
          const on = activeTab===tab.id, t = tabs[tab.id];
          return (
            <button key={tab.id} onClick={()=>openTab(tab.id)}
              style={{background:"none",border:"none",cursor:"pointer",padding:"14px 20px",fontSize:13,fontWeight:on?600:400,color:on?C.brand:C.textSecondary,borderBottom:on?`2px solid ${C.brand}`:"2px solid transparent",marginBottom:-1,fontFamily:F,display:"flex",alignItems:"center",gap:6}}>
              {tab.label}
              {t.loading&&<span style={{width:12,height:12,border:`1.5px solid ${C.border}`,borderTopColor:C.brand,borderRadius:"50%",display:"inline-block",animation:"spin 0.75s linear infinite"}}/>}
              {t.loaded&&!t.loading&&<span style={{fontSize:10.5,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"1px 7px",color:C.textTertiary}}>{t.data.length}</span>}
              {t.error&&<span style={{color:"#b91c1c",fontSize:12}}>!</span>}
            </button>
          );
        })}
      </nav>

      <main style={{maxWidth:1520,margin:"0 auto",padding:"28px 28px 56px"}}>
        {showReminder&&(
          <SyncReminder syncedAt={oldestSync} onSync={()=>loadAll("sync")}
            onSnooze={()=>setSnoozeUntil(Date.now() + SNOOZE_HOURS*3600000)}/>
        )}

        {unsyncedMax>0&&!busy&&(
          <div style={{background:"#fffbeb",border:"1px solid #fcd34d",borderRadius:12,padding:"12px 18px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
            <div style={{fontSize:12.5,color:"#92400e"}}>
              {unsyncedMax} of your projects {unsyncedMax===1?"hasn't":"haven't"} been pulled from Procore yet, so {unsyncedMax===1?"it isn't":"they aren't"} shown.
            </div>
            <button onClick={()=>loadAll("sync")} style={{background:C.brand,color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap"}}>Sync now</button>
          </div>
        )}

        {currentTab.error&&(
          <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:12,padding:"16px 20px",marginBottom:24,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#b91c1c"}}>Could not load {TABS.find(t=>t.id===activeTab).noun}</div>
              <div style={{fontSize:12,color:"#9b1c1c",marginTop:3}}>{currentTab.error}</div>
            </div>
            <button onClick={()=>loadTab(activeTab,"read")} disabled={busy} style={{background:C.brand,color:"#fff",border:"none",borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:F}}>Try again</button>
          </div>
        )}

        {activeTab==="rfis"&&<RFITab rfis={tabs.rfis.data} loading={tabs.rfis.loading} onExportView={exportView("rfis")} exporting={exportingView}/>}
        {activeTab==="submittals"&&<SubmittalsTab submittals={tabs.submittals.data} loading={tabs.submittals.loading} onExportView={exportView("submittals")} exporting={exportingView}/>}
        {activeTab==="changeEvents"&&<ChangeEventsTab changeEvents={tabs.changeEvents.data} loading={tabs.changeEvents.loading}
          coByEvent={coByEvent} coLoaded={tabs.changeOrders.loaded}
          pin={pin?.tab==="changeEvents"?pin:null} onClearPin={()=>setPin(null)} onJump={jump}
          onExportView={exportView("changeEvents")} exporting={exportingView}/>}
        {activeTab==="changeOrders"&&<ChangeOrdersTab changeOrders={tabs.changeOrders.data} loading={tabs.changeOrders.loading}
          ceById={ceById} ceLoaded={tabs.changeEvents.loaded}
          pin={pin?.tab==="changeOrders"?pin:null} onClearPin={()=>setPin(null)} onJump={jump}
          onExportView={exportView("changeOrders")} exporting={exportingView}/>}

        <DataHealthFooter tabs={tabs} rateLimit={rateLimit} onFullRebuild={fullRebuild} busy={busy}/>
      </main>
    </div>
  );
}
