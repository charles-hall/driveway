// Due-date logic, kept identical to the front end (public/index.html) so the
// reminder job and the app always agree on what is overdue.
const pad2 = n => String(n).padStart(2, "0");
const fmtDate = d => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const fmtMi = n => Math.round(n).toLocaleString("en-US");

function parseDate(s) {
  if (!s) return null; s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, m[1] - 1, +m[2]); }
  m = s.match(/^(\d{1,2})\/(\d{4})$/); if (m) return new Date(+m[2], m[1] - 1, 1);
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (m) { const i = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].slice(0, 3).toLowerCase()); if (i >= 0) return new Date(+m[2], i, 1); }
  return null;
}

function dueInfo(it, v) {
  const mo = num(it.intervalMonths), mi = num(it.intervalMiles);
  if (!mo && !mi) return null;
  const skip = parseDate(it.skipUntil);
  if (skip && skip > new Date()) return { state: "skipped", label: "Skipped", detail: "until " + fmtDate(skip), sort: Infinity };
  const last = parseDate(it.lastChanged), lastMi = num(it.lastMiles), odo = num(v.odometer);
  let date = null, miles = null;
  if (mo && last) { date = new Date(last); date.setDate(date.getDate() + Math.round(mo * 30.44)); }
  if (mi && lastMi != null) miles = lastMi + mi;
  if (!date && miles == null) return { state: "none", label: "No record", detail: "Add the last date or mileage" };
  const days = date ? (date - Date.now()) / 864e5 : Infinity;
  const left = (miles != null && odo != null) ? miles - odo : Infinity;
  const state = (days < 0 || left <= 0) ? "over" : (days <= 45 || left <= 1000) ? "soon" : "ok";
  const bits = []; if (date) bits.push(fmtDate(date)); if (miles != null) bits.push(fmtMi(miles) + " miles");
  return { state, label: { over: "Overdue", soon: "Due soon", ok: "OK" }[state], detail: bits.join(" or "), sort: Math.min(days, left / 40) };
}

function svcCat(it) {
  if (it.category) return it.category;
  const n = String(it.name || "").toLowerCase();
  if (/oil|crush washer|drain plug/.test(n)) return "Oil change";
  if (/filter/.test(n)) return "Filters";
  if (/wiper/.test(n)) return "Wipers";
  if (/tire|wheel|rotation|alignment/.test(n)) return "Tires and wheels";
  if (/brake fluid|coolant|transmission fluid|differential|power steering/.test(n)) return "Fluids";
  if (/brake|pad|rotor/.test(n)) return "Brakes";
  if (/spark|timing|belt|battery|ignition|valve/.test(n)) return "Engine and ignition";
  return "Other";
}

// Oil, filter and crush washer count as one "Oil change".
function statusList(v) {
  const rank = { over: 0, soon: 1, ok: 2, none: 3, skipped: 4 }, out = []; let oil = null;
  (v.items || []).forEach(it => {
    const d = dueInfo(it, v); if (!d) return;
    if (svcCat(it) === "Oil change") {
      if (!oil || rank[d.state] < rank[oil.d.state] || (d.state === oil.d.state && (d.sort ?? 0) < (oil.d.sort ?? 0))) oil = { it: { ...it, id: "oil-change", name: "Oil change" }, d };
      return;
    }
    out.push({ it, d });
  });
  if (oil) out.unshift(oil);
  return out;
}

module.exports = { parseDate, dueInfo, svcCat, statusList, fmtDate, num, fmtMi };
