// Cottage Driveway server. cPanel's "Setup Node.js App" runs this file under Passenger.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const store = require("./lib/db");
const auth = require("./lib/auth");
const push = require("./lib/push");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Security headers. The page uses inline scripts and two pinned cdnjs libraries (PDF export).
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.googleusercontent.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000",
  });
  next();
});

auth.ensureOwner();
app.use(auth.attachUser);
auth.routes(app);

const pub = p => path.join(__dirname, "public", p);

// Public files: sign-in page, manifest, icons and the service worker.
app.get("/login", (req, res) => (req.user ? res.redirect("/") : res.sendFile(pub("login.html"))));
app.get("/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").sendFile(pub("manifest.webmanifest")));
app.get("/sw.js", (_req, res) => res.set("Service-Worker-Allowed", "/").type("application/javascript").sendFile(pub("sw.js")));
app.use("/icons", express.static(pub("icons"), { maxAge: "30d" }));
app.get("/privacy", (_req, res) => res.sendFile(pub("privacy.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Everything else needs a signed-in, invited person.
app.use(auth.requireUser);

app.get("/", (_req, res) => res.set("Cache-Control", "no-store").sendFile(pub("index.html")));

// ---------- data API ----------
const COLS = new Set(["vehicles", "parts", "history"]);
const isOut = v => /^\s*0(\s|$|x)/i.test(String(v || ""));

app.get("/api/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json({
    version: store.stateVersion(),
    vehicles: store.allDocs("vehicles"),
    parts: store.allDocs("parts"),
    history: store.allDocs("history"),
  });
});

app.get("/api/version", (_req, res) => res.set("Cache-Control", "no-store").json({ version: store.stateVersion() }));

app.put("/api/:col/:id", auth.requireEditor, async (req, res) => {
  const { col, id } = req.params;
  if (!COLS.has(col) || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id)) return res.status(400).json({ error: "bad_path" });
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { ...req.body } : null;
  if (!body) return res.status(400).json({ error: "bad_body" });
  delete body.id;
  if (col === "history" && !body.loggedBy) body.loggedBy = req.user.name || req.user.email;
  const before = store.getDoc(col, id);
  store.putDoc(col, id, body, req.user.id);
  res.json({ ok: true, version: store.stateVersion() });

  // A part that just ran out triggers an "out of stock" notification.
  if (col === "parts" && isOut(body.onHand) && !(before && isOut(before.onHand))) {
    for (const u of store.listUsers()) {
      if (u.status !== "active" || !u.prefs.outOfStock) continue;
      const key = `out:${id}:${new Date().toISOString().slice(0, 10)}`;
      if (store.lastSent(key, u.id)) continue;
      const n = await push.sendToUser(u.id, { title: `${body.name || "A part"} is out`, body: "Added to your shopping list.", url: "/#inventory", tag: key });
      if (n) store.markSent(key, u.id);
    }
  }
});

app.delete("/api/:col/:id", (req, res, next) => (req.params.col === "vehicles" ? auth.requireOwner : auth.requireEditor)(req, res, next), (req, res) => {
  const { col, id } = req.params;
  if (!COLS.has(col)) return res.status(400).json({ error: "bad_path" });
  store.deleteDoc(col, id);
  res.json({ ok: true, version: store.stateVersion() });
});

// Full JSON export for the owner.
app.get("/api/export", auth.requireOwner, (_req, res) => {
  res.set("Content-Disposition", `attachment; filename="cottage-driveway-${new Date().toISOString().slice(0, 10)}.json"`)
    .json({ vehicles: store.allDocs("vehicles"), parts: store.allDocs("parts"), history: store.allDocs("history") });
});

// ---------- me ----------
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, role: u.role, status: u.status, lastLogin: u.last_login, prefs: u.prefs });

app.get("/api/me", (req, res) => res.json({
  ...publicUser(req.user),
  devices: store.subscriptionsFor(req.user.id).length,
  pushKey: push.publicKey,
}));

app.patch("/api/me/prefs", (req, res) => {
  const allowed = Object.keys(store.DEFAULT_PREFS);
  const next = { ...req.user.prefs };
  for (const k of allowed) if (typeof req.body?.[k] === "boolean") next[k] = req.body[k];
  store.setPrefs(req.user.id, next);
  res.json({ ok: true, prefs: next });
});

// ---------- people (owner only) ----------
app.get("/api/users", auth.requireOwner, (_req, res) => {
  res.json(store.listUsers().map(u => ({ ...publicUser(u), devices: store.subscriptionsFor(u.id).length })));
});

app.post("/api/users", auth.requireOwner, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = req.body?.role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!["owner", "editor", "viewer"].includes(role)) return res.status(400).json({ error: "Pick a role." });
  if (store.userByEmail(email)) return res.status(409).json({ error: "That person already has access." });
  res.json(publicUser(store.addUser(email, role, req.user.id)));
});

app.patch("/api/users/:id", auth.requireOwner, (req, res) => {
  const id = Number(req.params.id), role = req.body?.role;
  if (!["owner", "editor", "viewer"].includes(role)) return res.status(400).json({ error: "Pick a role." });
  if (id === req.user.id && role !== "owner") return res.status(400).json({ error: "You can't remove your own owner role." });
  store.setRole(id, role);
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth.requireOwner, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  store.removeUser(id); // sessions and push subscriptions go with it
  res.json({ ok: true });
});

// ---------- push ----------
app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys) return res.status(400).json({ error: "bad_subscription" });
  store.saveSubscription(req.user.id, sub, String(req.body?.device || "").slice(0, 120));
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  if (req.body?.endpoint) store.deleteSubscription(req.body.endpoint);
  res.json({ ok: true });
});

app.post("/api/push/test", async (req, res) => {
  if (!push.ready) return res.status(503).json({ error: "Push keys aren't set up on the server yet." });
  const n = await push.sendToUser(req.user.id, { title: "Cottage Driveway", body: "Notifications are working on this device.", url: "/" });
  res.json({ sent: n });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Cottage Driveway listening on ${port}`));
