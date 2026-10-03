// SQLite storage. Vehicles, parts and history are stored as JSON documents,
// the same shape the app used in its first version, so the front end and the
// import script stay simple. People, sessions and push data get real tables.
const fs = require("fs");
const path = require("path");
// Node's built-in SQLite (Node 22.13+): no native add-on to compile, so it runs on older hosting servers.
const quiet = process.emitWarning;
process.emitWarning = (w, ...a) => (/SQLite is an experimental/.test(String(w)) ? undefined : quiet.call(process, w, ...a));
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "tmp", "driveway.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
const userVersion = () => db.prepare("PRAGMA user_version").get().user_version;
// Runs fn inside one transaction (all or nothing).
db.transaction = fn => (...args) => {
  db.exec("BEGIN");
  try { const r = fn(...args); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL CHECK (collection IN ('vehicles','parts','history')),
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  picture TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active')),
  prefs TEXT NOT NULL DEFAULT '{}',
  invited_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notification_log (
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, user_id)
);
`);

const DEFAULT_PREFS = { dueSoon: true, overdue: true, outOfStock: true, mileage: true, allVehicles: false };

function parsePrefs(u) {
  if (!u) return u;
  let p = {};
  try { p = JSON.parse(u.prefs || "{}"); } catch {}
  return { ...u, prefs: { ...DEFAULT_PREFS, ...p } };
}

const bump = () => db.exec(`PRAGMA user_version = ${userVersion() + 1}`);

module.exports = {
  db,
  DEFAULT_PREFS,

  // ---- documents ----
  allDocs(collection) {
    return db.prepare("SELECT id, body FROM docs WHERE collection = ?").all(collection)
      .map(r => ({ id: r.id, ...JSON.parse(r.body) }));
  },
  getDoc(collection, id) {
    const r = db.prepare("SELECT body FROM docs WHERE collection = ? AND id = ?").get(collection, id);
    return r ? JSON.parse(r.body) : null;
  },
  putDoc(collection, id, body, userId) {
    db.prepare(`INSERT INTO docs (collection, id, body, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(collection, id, JSON.stringify(body), userId ?? null);
    bump();
  },
  deleteDoc(collection, id) {
    db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").run(collection, id);
    bump();
  },
  stateVersion() {
    // Every write bumps a counter kept in the database file, so clients never miss a change.
    return String(userVersion());
  },

  // ---- people ----
  userByEmail(email) { return parsePrefs(db.prepare("SELECT * FROM users WHERE email = ?").get(email)); },
  userById(id) { return parsePrefs(db.prepare("SELECT * FROM users WHERE id = ?").get(id)); },
  listUsers() { return db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, name, email").all().map(parsePrefs); },
  addUser(email, role, invitedBy) {
    db.prepare("INSERT INTO users (email, role, invited_by) VALUES (?, ?, ?)").run(email.trim().toLowerCase(), role, invitedBy ?? null);
    return this.userByEmail(email);
  },
  setRole(id, role) { db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id); },
  removeUser(id) { db.prepare("DELETE FROM users WHERE id = ?").run(id); },
  markLogin(id, name, picture) {
    db.prepare("UPDATE users SET name = ?, picture = ?, status = 'active', last_login = datetime('now') WHERE id = ?").run(name, picture, id);
  },
  setPrefs(id, prefs) { db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(prefs), id); },

  // ---- sessions ----
  createSession(id, userId, days) {
    db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, Date.now() + days * 864e5);
  },
  sessionUser(id) {
    const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!s) return null;
    if (s.expires_at < Date.now()) { db.prepare("DELETE FROM sessions WHERE id = ?").run(id); return null; }
    return this.userById(s.user_id);
  },
  deleteSession(id) { db.prepare("DELETE FROM sessions WHERE id = ?").run(id); },
  pruneSessions() { db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()); },

  // ---- push ----
  saveSubscription(userId, sub, device) {
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys, device) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, device = excluded.device`)
      .run(userId, sub.endpoint, JSON.stringify(sub.keys || {}), device || null);
  },
  deleteSubscription(endpoint) { db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint); },
  subscriptionsFor(userId) {
    return db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId)
      .map(r => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys), device: r.device }));
  },
  lastSent(key, userId) {
    const r = db.prepare("SELECT sent_at FROM notification_log WHERE key = ? AND user_id = ?").get(key, userId);
    return r ? new Date(r.sent_at.replace(" ", "T") + "Z") : null;
  },
  markSent(key, userId) {
    db.prepare(`INSERT INTO notification_log (key, user_id) VALUES (?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET sent_at = datetime('now')`).run(key, userId);
  },
};
