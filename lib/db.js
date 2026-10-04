// SQLite storage. Vehicles, parts and history are stored as JSON documents,
// the same shape the app used in its first version, so the front end and the
// import script stay simple. Every document belongs to one household; people
// reach a household through a membership that carries their role there.
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
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  picture TEXT,
  role TEXT NOT NULL DEFAULT 'viewer', -- legacy (pre-households); roles now live in memberships
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active')),
  prefs TEXT NOT NULL DEFAULT '{}',
  invited_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, user_id)
);
CREATE TABLE IF NOT EXISTS docs (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  collection TEXT NOT NULL CHECK (collection IN ('vehicles','parts','history')),
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER,
  PRIMARY KEY (household_id, collection, id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id INTEGER,
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

// One-time upgrade from the single-household version: everything that existed
// becomes household #1 (named by FIRST_HOUSEHOLD_NAME, default "Cottage"),
// and each person keeps the role they had, now as a membership in it.
const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols("docs").includes("household_id")) {
  db.transaction(() => {
    db.prepare("INSERT INTO households (id, name) VALUES (1, ?)").run((process.env.FIRST_HOUSEHOLD_NAME || "Cottage").trim());
    db.exec(`
      CREATE TABLE docs_v2 (
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        collection TEXT NOT NULL CHECK (collection IN ('vehicles','parts','history')),
        id TEXT NOT NULL, body TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by INTEGER,
        PRIMARY KEY (household_id, collection, id));
      INSERT INTO docs_v2 (household_id, collection, id, body, updated_at, updated_by)
        SELECT 1, collection, id, body, updated_at, updated_by FROM docs;
      DROP TABLE docs;
      ALTER TABLE docs_v2 RENAME TO docs;
      INSERT OR IGNORE INTO memberships (household_id, user_id, role, invited_by)
        SELECT 1, id, CASE WHEN role IN ('owner','editor','viewer') THEN role ELSE 'viewer' END, invited_by FROM users;
      UPDATE notification_log SET key = 'h1:' || key WHERE key NOT LIKE 'h%:%';
    `);
  })();
  console.log("Upgraded the database to households: existing data is now in household #1.");
}
if (!cols("sessions").includes("household_id")) db.exec("ALTER TABLE sessions ADD COLUMN household_id INTEGER");

const DEFAULT_PREFS = { dueSoon: true, overdue: true, outOfStock: true, mileage: true, allVehicles: false };

function parsePrefs(u) {
  if (!u) return u;
  let p = {};
  try { p = JSON.parse(u.prefs || "{}"); } catch {}
  const { role: _legacy, ...rest } = u;
  return { ...rest, prefs: { ...DEFAULT_PREFS, ...p } };
}

const bump = () => db.exec(`PRAGMA user_version = ${userVersion() + 1}`);
const ROLES = ["owner", "editor", "viewer"];

module.exports = {
  db,
  DEFAULT_PREFS,
  ROLES,

  // ---- documents (always scoped to one household) ----
  allDocs(hid, collection) {
    return db.prepare("SELECT id, body FROM docs WHERE household_id = ? AND collection = ?").all(hid, collection)
      .map(r => ({ id: r.id, ...JSON.parse(r.body) }));
  },
  getDoc(hid, collection, id) {
    const r = db.prepare("SELECT body FROM docs WHERE household_id = ? AND collection = ? AND id = ?").get(hid, collection, id);
    return r ? JSON.parse(r.body) : null;
  },
  putDoc(hid, collection, id, body, userId) {
    db.prepare(`INSERT INTO docs (household_id, collection, id, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(household_id, collection, id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(hid, collection, id, JSON.stringify(body), userId ?? null);
    bump();
  },
  deleteDoc(hid, collection, id) {
    db.prepare("DELETE FROM docs WHERE household_id = ? AND collection = ? AND id = ?").run(hid, collection, id);
    bump();
  },
  stateVersion() {
    // Every write bumps a counter kept in the database file, so clients never miss a change.
    return String(userVersion());
  },

  // ---- households ----
  household(id) { return db.prepare("SELECT id, name, created_at FROM households WHERE id = ?").get(id) || null; },
  listHouseholds() {
    return db.prepare(`SELECT h.id, h.name, h.created_at AS createdAt,
        (SELECT count(*) FROM memberships m WHERE m.household_id = h.id) AS members,
        (SELECT count(*) FROM docs d WHERE d.household_id = h.id AND d.collection = 'vehicles') AS vehicles,
        (SELECT group_concat(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = h.id AND m.role = 'owner') AS owners
      FROM households h ORDER BY h.name COLLATE NOCASE`).all().map(r => ({ ...r }));
  },
  createHousehold(name) {
    const r = db.prepare("INSERT INTO households (name) VALUES (?)").run(name.trim());
    bump();
    return this.household(Number(r.lastInsertRowid));
  },
  renameHousehold(id, name) { db.prepare("UPDATE households SET name = ? WHERE id = ?").run(name.trim(), id); bump(); },
  deleteHousehold(id) {
    // Docs and memberships cascade. People left with no household lose access.
    const orphans = db.prepare("SELECT user_id FROM memberships WHERE household_id = ?").all(id).map(r => r.user_id);
    db.prepare("DELETE FROM households WHERE id = ?").run(id);
    db.prepare("DELETE FROM notification_log WHERE key LIKE ?").run(`h${id}:%`);
    bump();
    return orphans;
  },

  // ---- memberships ----
  membershipsFor(userId) {
    return db.prepare(`SELECT h.id, h.name, m.role FROM memberships m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? ORDER BY h.name COLLATE NOCASE`).all(userId).map(r => ({ ...r }));
  },
  membership(hid, userId) {
    const r = db.prepare("SELECT role FROM memberships WHERE household_id = ? AND user_id = ?").get(hid, userId);
    return r ? r.role : null;
  },
  members(hid) {
    return db.prepare(`SELECT u.*, m.role AS hrole FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ? ORDER BY m.role = 'owner' DESC, u.name, u.email`).all(hid)
      .map(r => { const { hrole, ...u } = r; return { ...parsePrefs(u), role: hrole }; });
  },
  ownerCount(hid) { return db.prepare("SELECT count(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner'").get(hid).n; },
  addMember(hid, userId, role, invitedBy) {
    db.prepare("INSERT INTO memberships (household_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)").run(hid, userId, role, invitedBy ?? null);
  },
  setMemberRole(hid, userId, role) { db.prepare("UPDATE memberships SET role = ? WHERE household_id = ? AND user_id = ?").run(role, hid, userId); },
  removeMember(hid, userId) {
    db.prepare("DELETE FROM memberships WHERE household_id = ? AND user_id = ?").run(hid, userId);
    db.prepare("DELETE FROM notification_log WHERE user_id = ? AND key LIKE ?").run(userId, `h${hid}:%`);
  },

  // ---- people ----
  userByEmail(email) { return parsePrefs(db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase())); },
  userById(id) { return parsePrefs(db.prepare("SELECT * FROM users WHERE id = ?").get(id)); },
  ensureUser(email, invitedBy) {
    const e = String(email).trim().toLowerCase();
    db.prepare("INSERT OR IGNORE INTO users (email, invited_by) VALUES (?, ?)").run(e, invitedBy ?? null);
    return this.userByEmail(e);
  },
  // Removes a person entirely once they belong to no household (unless they're the site admin).
  pruneUser(userId, adminEmail) {
    const u = this.userById(userId);
    if (!u || (adminEmail && u.email.toLowerCase() === adminEmail)) return;
    if (!db.prepare("SELECT 1 FROM memberships WHERE user_id = ?").get(userId)) db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  },
  activeUsers() { return db.prepare("SELECT * FROM users WHERE status = 'active'").all().map(parsePrefs); },
  markLogin(id, name, picture) {
    db.prepare("UPDATE users SET name = ?, picture = ?, status = 'active', last_login = datetime('now') WHERE id = ?").run(name, picture, id);
  },
  setPrefs(id, prefs) { db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(prefs), id); },

  // ---- sessions ----
  createSession(id, userId, days) {
    db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, Date.now() + days * 864e5);
  },
  session(id) {
    const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!s) return null;
    if (s.expires_at < Date.now()) { db.prepare("DELETE FROM sessions WHERE id = ?").run(id); return null; }
    const user = this.userById(s.user_id);
    return user ? { user, householdId: s.household_id } : null;
  },
  setSessionHousehold(id, hid) { db.prepare("UPDATE sessions SET household_id = ? WHERE id = ?").run(hid, id); },
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
