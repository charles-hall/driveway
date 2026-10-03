/* ---------- settings, people and notifications (server build only) ---------- */
const ROLE_LABEL={owner:"Owner",editor:"Editor",viewer:"Viewer"};
const PREF_LABEL=[
  ["overdue","Overdue maintenance","On the day an item goes overdue, then weekly until it's logged."],
  ["dueSoon","Coming due","Once, about two weeks or 500 miles ahead."],
  ["outOfStock","Parts out of stock","When a logged service uses the last of a part."],
  ["mileage","Mileage check-in","Monthly reminder to update the odometer on daily drivers."],
  ["allVehicles","Include non-daily drivers","Also send reminders for vehicles not marked as daily drivers."],
];
let people=null, pushState="unknown", settingsBusy=false;
const me=()=>window.DRIVEWAY.me||{};
const sapi=(m,u,b)=>window.DRIVEWAY.api(m,u,b);
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const standalone=matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
function b64u(s){ const p="=".repeat((4-s.length%4)%4), b=atob((s+p).replace(/-/g,"+").replace(/_/g,"/")); return Uint8Array.from(b,c=>c.charCodeAt(0)); }
function deviceName(){ const ua=navigator.userAgent; return (/iPhone/.test(ua)?"iPhone":/iPad/.test(ua)||isIOS?"iPad":/Android/.test(ua)?"Android":/Mac/.test(ua)?"Mac":/Windows/.test(ua)?"Windows":"Browser")+(standalone?" (Home Screen app)":" (browser)"); }

async function checkPush(){
  if(!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window)){ pushState=isIOS&&!standalone?"needs-install":"unsupported"; return; }
  if(Notification.permission==="denied"){ pushState="denied"; return; }
  try{ const reg=await navigator.serviceWorker.ready; pushState=(await reg.pushManager.getSubscription())?"on":"off"; }catch{ pushState="off"; }
}

async function enablePush(){
  // requestPermission must be the first thing awaited after the tap (iOS rule)
  let perm; try{ perm=await Notification.requestPermission(); }catch{ perm="default"; }
  if(perm!=="granted"){ toast(perm==="denied"?"Notifications are blocked. Turn them on in Settings › Notifications › Driveway.":"Notifications weren't turned on"); await checkPush(); return renderSettings(true); }
  if(!me().pushKey){ toast("Push keys aren't set up on the server yet"); return; }
  try{
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(me().pushKey)});
    await sapi("POST","/api/push/subscribe",{subscription:sub.toJSON(),device:deviceName()});
    toast("Notifications are on for this device");
  }catch(e){ toast("Couldn't turn on notifications: "+(e.message||e)); }
  await refreshMe(); await checkPush(); renderSettings(true);
}
async function disablePush(){
  try{ const reg=await navigator.serviceWorker.ready, sub=await reg.pushManager.getSubscription();
    if(sub){ await sapi("POST","/api/push/unsubscribe",{endpoint:sub.endpoint}); await sub.unsubscribe(); }
    toast("Notifications are off for this device");
  }catch(e){ toast("Couldn't turn off notifications"); }
  await refreshMe(); await checkPush(); renderSettings(true);
}
async function refreshMe(){ try{ window.DRIVEWAY.me=await sapi("GET","/api/me"); }catch{} }
async function loadPeople(){ if(me().role!=="owner") return; try{ people=await sapi("GET","/api/users"); }catch{ people=[]; } }

function fmtLogin(s){ if(!s) return "Hasn't signed in yet"; const d=new Date(s.replace(" ","T")+(/[zZ]|[+-]\d\d:?\d\d$/.test(s)?"":"Z")); return isNaN(d)?"":"Last signed in "+fmtDate(d); }

function settingsView(){
  const u=me(), p=u.prefs||{};
  const pushBlock={
    "on":`<p>Notifications are <b>on</b> for this device.</p><div class="set-row"><button class="btn" data-sact="push-test">Send a test</button><button class="btn" data-sact="push-off">Turn off on this device</button></div>`,
    "off":`<p>Get reminders on this device when maintenance comes due.</p><div class="set-row"><button class="btn primary" data-sact="push-on">Turn on notifications</button></div>`,
    "denied":`<p>Notifications are blocked for this app. ${isIOS?"Open Settings › Notifications › Driveway on your iPhone to allow them.":"Allow them in your browser's site settings, then reload."}</p>`,
    "needs-install":`<p>On iPhone, notifications work once the app is on your Home Screen: in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Driveway from the Home Screen and come back here. Requires iOS 16.4 or later.</p>`,
    "unsupported":`<p>This browser doesn't support web notifications.</p>`,
    "unknown":`<p>Checking this device…</p>`,
  }[pushState];
  const others=u.devices&&pushState!=="on"?u.devices:u.devices-1;
  const prefs=PREF_LABEL.map(([k,l,h])=>`<label class="set-pref"><input type="checkbox" data-pref="${k}" ${p[k]?"checked":""}><span><b>${l}</b><small>${h}</small></span></label>`).join("");
  const owner=u.role==="owner";
  const peopleBlock=!owner?"":`<section class="plate" id="set-people"><h2 class="set-h">People</h2>
    <p class="form-hint">Only people listed here can sign in. Editors can log service and update inventory; viewers can only look; owners also manage people and vehicles.</p>
    ${people===null?`<p>Loading…</p>`:`<ul class="set-people">${people.map(x=>`<li>
      ${x.picture?`<img src="${esc(x.picture)}" alt="" referrerpolicy="no-referrer">`:`<span class="set-av">${esc((x.name||x.email)[0].toUpperCase())}</span>`}
      <span class="set-who"><b>${esc(x.name||x.email)}</b><small>${esc(x.name?x.email+" · ":"")}${esc(fmtLogin(x.lastLogin))}${x.devices?` · ${x.devices} device${x.devices>1?"s":""} with notifications`:""}</small></span>
      ${x.id===u.id?`<span class="chip">${ROLE_LABEL[x.role]} (you)</span>`:`<select data-role="${x.id}" aria-label="Role for ${esc(x.email)}">${Object.entries(ROLE_LABEL).map(([r,l])=>`<option value="${r}" ${r===x.role?"selected":""}>${l}</option>`).join("")}</select>
      <button class="btn danger" data-sact="remove" data-uid="${x.id}">Remove</button>`}</li>`).join("")}</ul>`}
    <form class="set-invite" id="set-invite"><input type="email" id="inv-email" placeholder="name@gmail.com" required aria-label="Email address to invite">
      <select id="inv-role" aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select>
      <button class="btn primary" type="submit">Invite</button></form>
    <p class="form-hint">They sign in at driveway.oaksync.com with that Google account. No email is sent, so let them know.</p></section>`;
  return `<section class="plate"><h2 class="set-h">Account</h2>
      <div class="set-me">${u.picture?`<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`:""}<span class="set-who"><b>${esc(u.name||u.email)}</b><small>${esc(u.email)} · ${ROLE_LABEL[u.role]||""}</small></span>
      <a class="btn" href="/auth/logout">Sign out</a></div>
      ${owner?`<p class="form-hint"><a href="/api/export" download>Download a backup</a> of all vehicles, parts and service history (JSON).</p>`:""}</section>
    <section class="plate"><h2 class="set-h">Notifications</h2>${pushBlock}
      ${others>0?`<p class="form-hint">Also on for ${others} other device${others>1?"s":""}.</p>`:""}
      <fieldset class="set-prefs"><legend>Send me</legend>${prefs}</fieldset></section>
    ${peopleBlock}`;
}
function renderSettings(force){
  if(view!=="settings") return;
  if(!force&&(settingsBusy||$("#main").contains(document.activeElement)&&document.activeElement.matches("input,select"))) return;
  $("#main").innerHTML=settingsView();
}
async function openSettings(){ await Promise.all([checkPush(),loadPeople(),refreshMe()]); renderSettings(true); }

$("#main").addEventListener("click",async e=>{
  const b=e.target.closest("[data-sact]"); if(!b||view!=="settings") return;
  const a=b.dataset.sact;
  if(a==="push-on") return enablePush();
  if(a==="push-off") return disablePush();
  if(a==="push-test"){ try{ const r=await sapi("POST","/api/push/test"); toast(r.sent?"Test sent":"No devices to send to"); }catch(err){ toast(err.message||"Couldn't send a test"); } return; }
  if(a==="remove"){
    if(!b.dataset.armed){ b.dataset.armed=1; b.textContent="Confirm remove"; return; }
    try{ await sapi("DELETE","/api/users/"+b.dataset.uid); toast("Access removed"); await loadPeople(); renderSettings(true); }catch(err){ toast(err.message||"Couldn't remove"); }
  }
});
$("#main").addEventListener("change",async e=>{
  if(view!=="settings") return; const t=e.target;
  if(t.dataset.pref){ try{ const r=await sapi("PATCH","/api/me/prefs",{[t.dataset.pref]:t.checked}); window.DRIVEWAY.me.prefs=r.prefs; toast("Saved"); }catch(err){ t.checked=!t.checked; toast(err.message||"Couldn't save"); } return; }
  if(t.dataset.role){ try{ await sapi("PATCH","/api/users/"+t.dataset.role,{role:t.value}); toast("Role updated"); await loadPeople(); renderSettings(true); }catch(err){ toast(err.message||"Couldn't change role"); await loadPeople(); renderSettings(true); } }
});
$("#main").addEventListener("submit",async e=>{
  if(e.target.id!=="set-invite") return; e.preventDefault();
  settingsBusy=true;
  try{ const em=$("#inv-email").value.trim(); await sapi("POST","/api/users",{email:em,role:$("#inv-role").value}); toast(em+" can now sign in"); await loadPeople(); }
  catch(err){ toast(err.message||"Couldn't invite"); }
  settingsBusy=false; renderSettings(true);
});

/* Deep links from notifications: #inventory, #settings, #v-<vehicleId> */
function applyHash(){
  const h=decodeURIComponent(location.hash.slice(1)); if(!h) return false;
  if(h==="inventory") view="inv";
  else if(h==="settings") view="settings";
  else if(h.startsWith("v-")){ view="service"; activeId=h.slice(2); }
  else return false;
  window.history.replaceState(null,"",location.pathname); // keep later navigation clean
  if(view==="settings") openSettings();
  return true;
}
window.addEventListener("hashchange",()=>{ if(applyHash()) { render(); window.scrollTo({top:0}); } });
