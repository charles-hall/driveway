// Daily reminder job. Run once a day from a cPanel cron job:
//   cd ~/driveway && <node from the app's virtual environment> scripts/remind.js
// It never sends the same reminder twice: due-soon goes out once, overdue on the
// first day and then weekly, mileage check-ins at most monthly.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const store = require("../lib/db");
const push = require("../lib/push");
const { statusList, parseDate } = require("../lib/schedule");

const DAY = 864e5;

async function main() {
  if (!push.ready) { console.log("Push keys missing; nothing sent."); return; }
  const vehicles = store.allDocs("vehicles");
  const users = store.listUsers().filter(u => u.status === "active" && store.subscriptionsFor(u.id).length);
  let total = 0;

  for (const u of users) {
    const p = u.prefs;
    let overdueCount = 0;
    const messages = [];
    for (const v of vehicles) {
      if (!v.dailyDriver && !p.allVehicles) continue;
      for (const { it, d } of statusList(v)) {
        if (d.state === "over") {
          overdueCount++;
          if (!p.overdue) continue;
          const key = `over:${v.id}:${it.id}:${it.lastChanged || it.lastMiles || ""}`;
          const last = store.lastSent(key, u.id);
          if (!last || Date.now() - last >= 7 * DAY) messages.push({ key, title: `${v.name}: ${it.name} is overdue`, body: d.detail ? `Was due ${d.detail}.` : "Log it when it's done.", url: `/#v-${v.id}` });
        } else if (d.state === "soon" && p.dueSoon) {
          const key = `soon:${v.id}:${it.id}:${d.detail}`;
          if (!store.lastSent(key, u.id)) messages.push({ key, title: `${v.name}: ${it.name} due soon`, body: `Due ${d.detail}.`, url: `/#v-${v.id}` });
        }
      }
      // Mileage check-in: odometer not updated in 30 days
      if (p.mileage && v.dailyDriver) {
        const seen = parseDate(v.odometerDate);
        if (!seen || Date.now() - seen >= 30 * DAY) {
          const key = `miles:${v.id}`;
          const last = store.lastSent(key, u.id);
          if (!last || Date.now() - last >= 30 * DAY) messages.push({ key, title: `Update the ${v.name}'s mileage`, body: "A current odometer reading keeps due dates accurate.", url: `/#v-${v.id}` });
        }
      }
    }
    for (const m of messages) {
      const n = await push.sendToUser(u.id, { title: m.title, body: m.body, url: m.url, tag: m.key, badge: overdueCount });
      if (n) { store.markSent(m.key, u.id); total += n; }
    }
  }
  console.log(`${new Date().toISOString()} reminder job: ${total} notification(s) sent to ${users.length} person(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
