// Web Push (works on iPhone for Home Screen web apps, iOS 16.4 and later).
const webpush = require("web-push");
const store = require("./db");

const ready = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (ready) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// Send one notification to every device a person has turned on.
// Expired subscriptions (404/410) are removed automatically.
async function sendToUser(userId, payload) {
  if (!ready) return 0;
  let sent = 0;
  for (const sub of store.subscriptionsFor(userId)) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) store.deleteSubscription(sub.endpoint);
      else console.error("push failed", e.statusCode, e.body || e.message);
    }
  }
  return sent;
}

module.exports = { ready, sendToUser, publicKey: process.env.VAPID_PUBLIC_KEY || "" };
