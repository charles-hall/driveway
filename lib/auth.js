// Google sign-in (OpenID Connect) and cookie sessions.
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const store = require("./db");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const REDIRECT = `${BASE_URL}/auth/google/callback`;
const SECURE = BASE_URL.startsWith("https://");
const SESSION_DAYS = 30;
const SID = "bd_sid";

const google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT);

// Session ids are stored hashed, so a copied database can't be used to sign in.
const hash = v => crypto.createHmac("sha256", process.env.SESSION_SECRET || "dev-secret").update(v).digest("hex");
const cookieOpts = maxAgeMs => ({ httpOnly: true, secure: SECURE, sameSite: "lax", path: "/", maxAge: maxAgeMs });

// The first owner comes from OWNER_EMAIL so you can sign in the very first time.
function ensureOwner() {
  const email = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!email) return;
  const u = store.userByEmail(email);
  if (!u) store.addUser(email, "owner", null);
  else if (u.role !== "owner") store.setRole(u.id, "owner");
}

function attachUser(req, _res, next) {
  const raw = req.cookies?.[SID];
  req.user = raw ? store.sessionUser(hash(raw)) : null;
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "signed_out" });
  return res.redirect("/login");
}
const canEdit = u => u && (u.role === "owner" || u.role === "editor");
function requireEditor(req, res, next) { return canEdit(req.user) ? next() : res.status(403).json({ error: "view_only" }); }
function requireOwner(req, res, next) { return req.user?.role === "owner" ? next() : res.status(403).json({ error: "owner_only" }); }

function routes(app) {
  app.get("/auth/google", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("bd_state", state, cookieOpts(10 * 60 * 1000));
    res.redirect(google.generateAuthUrl({ scope: ["openid", "email", "profile"], state, prompt: "select_account" }));
  });

  app.get("/auth/google/callback", async (req, res) => {
    try {
      if (!req.query.state || req.query.state !== req.cookies?.bd_state) return res.redirect("/login?e=state");
      res.clearCookie("bd_state", { path: "/" });
      const { tokens } = await google.getToken(String(req.query.code || ""));
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p?.email || !p.email_verified) return res.redirect("/login?e=email");
      const user = store.userByEmail(p.email);
      if (!user) return res.redirect("/login?e=noaccess&email=" + encodeURIComponent(p.email));
      store.markLogin(user.id, p.name || p.email, p.picture || null);
      const raw = crypto.randomBytes(32).toString("hex");
      store.createSession(hash(raw), user.id, SESSION_DAYS);
      store.pruneSessions();
      res.cookie(SID, raw, cookieOpts(SESSION_DAYS * 864e5));
      res.redirect("/");
    } catch (e) {
      console.error("sign-in failed", e.message);
      res.redirect("/login?e=failed");
    }
  });

  app.get("/auth/logout", (req, res) => {
    const raw = req.cookies?.[SID];
    if (raw) store.deleteSession(hash(raw));
    res.clearCookie(SID, { path: "/" });
    res.redirect("/login");
  });
}

module.exports = { attachUser, requireUser, requireEditor, requireOwner, canEdit, routes, ensureOwner };
