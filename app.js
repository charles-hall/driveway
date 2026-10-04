// Driveway server. cPanel's "Setup Node.js App" runs this file under Passenger.
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
const brand = h => (h ? `${h.name} Driveway` : "Driveway");
const MANIFEST = JSON.parse(require("fs").readFileSync(pub("manifest.webmanifest"), "utf8"));
app.get("/login", (req, res) => (req.user ? res.redirect("/") : res.sendFile(pub("login.html"))));
// The Home Screen name follows the signed-in person's household.
app.get("/manifest.webmanifest", (req, res) => res.set("Cache-Control", "no-store").type("application/manifest+json")
  .send(JSON.stringify({ ...MANIFEST, name: brand(req.household) })));
app.get("/sw.js", (_req, res) => res.set("Service-Worker-Allowed", "/").type("application/javascript").sendFile(pub("sw.js")));
app.use("/icons", express.static(pub("icons"), { maxAge: "30d" }));
app.get("/favicon.ico", (_req, res) => res.set("Cache-Control", "public, max-age=604800").sendFile(pub("favicon.ico")));
app.get("/privacy", (_req, res) => res.sendFile(pub("privacy.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Everything else needs a signed-in, invited person.
app.use(auth.requireUser);

// "/?h=2" switches to household 2 (used by notification links), then loads the app.
app.get("/", (req, res) => {
  const h = Number(req.query.h);
  if (h) {
    if (req.households.some(x => x.id === h)) store.setSessionHousehold(req.sessionKey, h);
    return res.redirect("/");
  }
  res.set("Cache-Control", "no-store").sendFile(pub("index.html"));
});

// ---------- data API (always the active household) ----------
const COLS = new Set(["vehicles", "parts", "history"]);
const isOut = v => /^\s*0(\s|$|x)/i.test(String(v || ""));
const hid = req => req.household.id;
// The generic routes only handle these three collections; anything else (like /api/users) falls through.
const docsOnly = (req, _res, next) => (COLS.has(req.params.col) ? next() : next("route"));

app.get("/api/state", auth.requireHousehold, (req, res) => {
  res.set("Cache-Control", "no-store").json({
    version: store.stateVersion(),
    vehicles: store.allDocs(hid(req), "vehicles"),
    parts: store.allDocs(hid(req), "parts"),
    history: store.allDocs(hid(req), "history"),
  });
});

app.get("/api/version", (_req, res) => res.set("Cache-Control", "no-store").json({ version: store.stateVersion() }));

app.put("/api/:col/:id", docsOnly, auth.requireHousehold, auth.requireEditor, async (req, res) => {
  const { col, id } = req.params;
  if (!COLS.has(col) || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id)) return res.status(400).json({ error: "bad_path" });
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { ...req.body } : null;
  if (!body) return res.status(400).json({ error: "bad_body" });
  delete body.id;
  if (col === "history" && !body.loggedBy) body.loggedBy = req.user.name || req.user.email;
  const h = req.household;
  const before = store.getDoc(h.id, col, id);
  store.putDoc(h.id, col, id, body, req.user.id);
  res.json({ ok: true, version: store.stateVersion() });

  // A part that just ran out notifies that household's members who want it.
  if (col === "parts" && isOut(body.onHand) && !(before && isOut(before.onHand))) {
    for (const u of store.members(h.id)) {
      if (u.status !== "active" || !u.prefs.outOfStock) continue;
      const key = `h${h.id}:out:${id}:${new Date().toISOString().slice(0, 10)}`;
      if (store.lastSent(key, u.id)) continue;
      const n = await push.sendToUser(u.id, { title: `${body.name || "A part"} is out`, body: `Added to the ${brand(h)} shopping list.`, url: `/?h=${h.id}#inventory`, tag: key });
      if (n) store.markSent(key, u.id);
    }
  }
});

app.delete("/api/:col/:id", docsOnly, auth.requireHousehold,
  (req, res, next) => (req.params.col === "vehicles" ? auth.requireOwner : auth.requireEditor)(req, res, next),
  (req, res) => {
    const { col, id } = req.params;
    if (!COLS.has(col)) return res.status(400).json({ error: "bad_path" });
    store.deleteDoc(hid(req), col, id);
    res.json({ ok: true, version: store.stateVersion() });
  });

// Full JSON export of the active household, for its owners.
app.get("/api/export", auth.requireHousehold, auth.requireOwner, (req, res) => {
  const slug = req.household.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "household";
  res.set("Content-Disposition", `attachment; filename="${slug}-driveway-${new Date().toISOString().slice(0, 10)}.json"`)
    .json({ household: req.household.name, vehicles: store.allDocs(hid(req), "vehicles"), parts: store.allDocs(hid(req), "parts"), history: store.allDocs(hid(req), "history") });
});

// ---------- me ----------
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, status: u.status, lastLogin: u.last_login, prefs: u.prefs });

app.get("/api/me", (req, res) => res.set("Cache-Control", "no-store").json({
  ...publicUser(req.user),
  role: req.household?.role || null,
  household: req.household,
  households: req.households,
  isAdmin: req.user.isAdmin,
  devices: store.subscriptionsFor(req.user.id).length,
  pushKey: push.publicKey,
}));

app.post("/api/me/household", (req, res) => {
  const h = Number(req.body?.id);
  if (!req.households.some(x => x.id === h)) return res.status(403).json({ error: "You aren't a member of that household." });
  store.setSessionHousehold(req.sessionKey, h);
  res.json({ ok: true });
});

app.patch("/api/me/prefs", (req, res) => {
  const allowed = Object.keys(store.DEFAULT_PREFS);
  const next = { ...req.user.prefs };
  for (const k of allowed) if (typeof req.body?.[k] === "boolean") next[k] = req.body[k];
  store.setPrefs(req.user.id, next);
  res.json({ ok: true, prefs: next });
});

// ---------- household settings and people (owners of the active household) ----------
const cleanName = v => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

app.patch("/api/household", auth.requireHousehold, auth.requireOwner, (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Enter a household name." });
  store.renameHousehold(hid(req), name);
  res.json({ ok: true, name });
});

app.get("/api/users", auth.requireHousehold, auth.requireOwner, (req, res) => {
  res.json(store.members(hid(req)).map(u => ({ ...publicUser(u), role: u.role, devices: store.subscriptionsFor(u.id).length })));
});

app.post("/api/users", auth.requireHousehold, auth.requireOwner, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = req.body?.role;
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!store.ROLES.includes(role)) return res.status(400).json({ error: "Pick a role." });
  const u = store.ensureUser(email, req.user.id);
  if (store.membership(hid(req), u.id)) return res.status(409).json({ error: "That person is already in this household." });
  store.addMember(hid(req), u.id, role, req.user.id);
  res.json({ ...publicUser(u), role });
});

app.patch("/api/users/:id", auth.requireHousehold, auth.requireOwner, (req, res) => {
  const id = Number(req.params.id), role = req.body?.role;
  if (!store.ROLES.includes(role)) return res.status(400).json({ error: "Pick a role." });
  if (!store.membership(hid(req), id)) return res.status(404).json({ error: "That person isn't in this household." });
  if (id === req.user.id && role !== "owner") return res.status(400).json({ error: "You can't remove your own owner role." });
  store.setMemberRole(hid(req), id, role);
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth.requireHousehold, auth.requireOwner, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  if (!store.membership(hid(req), id)) return res.status(404).json({ error: "That person isn't in this household." });
  store.removeMember(hid(req), id);
  store.pruneUser(id, auth.ADMIN()); // someone left in no household is removed entirely
  res.json({ ok: true });
});

// ---------- households (site admin only) ----------
app.get("/api/admin/households", auth.requireAdmin, (_req, res) => res.json(store.listHouseholds()));

app.post("/api/admin/households", auth.requireAdmin, (req, res) => {
  const name = cleanName(req.body?.name);
  const email = String(req.body?.ownerEmail || "").trim().toLowerCase();
  if (!name) return res.status(400).json({ error: "Enter a household name." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter the owner's Google email address." });
  const h = store.db.transaction(() => {
    const h = store.createHousehold(name);
    const u = store.ensureUser(email, req.user.id);
    store.addMember(h.id, u.id, "owner", req.user.id);
    return h;
  })();
  res.json(h);
});

app.patch("/api/admin/households/:id", auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id), name = cleanName(req.body?.name);
  if (!store.household(id)) return res.status(404).json({ error: "No such household." });
  if (!name) return res.status(400).json({ error: "Enter a household name." });
  store.renameHousehold(id, name);
  res.json({ ok: true });
});

app.delete("/api/admin/households/:id", auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id), h = store.household(id);
  if (!h) return res.status(404).json({ error: "No such household." });
  if (String(req.body?.confirm || "") !== h.name) return res.status(400).json({ error: `Type "${h.name}" to confirm.` });
  const orphans = store.deleteHousehold(id);
  orphans.forEach(uid => store.pruneUser(uid, auth.ADMIN()));
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
  const n = await push.sendToUser(req.user.id, { title: brand(req.household), body: "Notifications are working on this device.", url: "/" });
  res.json({ sent: n });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Driveway listening on ${port}`));
