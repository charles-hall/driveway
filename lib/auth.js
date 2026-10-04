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

// The site admin (OWNER_EMAIL) can always sign in, creates households and
// assigns each one's first owner. Admin rights don't include seeing a
// household's records; that still takes a membership in it.
const ADMIN = () => (process.env.OWNER_EMAIL || "").trim().toLowerCase();
function ensureOwner() { if (ADMIN()) store.ensureUser(ADMIN(), null); }
const isAdmin = u => !!u && !!ADMIN() && u.email.toLowerCase() === ADMIN();

// Who is this, which households can they use, and which one is active?
function attachUser(req, _res, next) {
  req.user = null; req.household = null; req.households = [];
  const raw = req.cookies?.[SID];
  const s = raw ? store.session(hash(raw)) : null;
  if (s) {
    const households = store.membershipsFor(s.user.id);
    const admin = isAdmin(s.user);
    if (households.length || admin) {
      req.user = { ...s.user, isAdmin: admin };
      req.households = households;
      req.sessionKey = hash(raw);
      req.household = households.find(h => h.id === s.householdId) || households[0] || null;
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "signed_out" });
  return res.redirect("/login");
}
function requireHousehold(req, res, next) {
  return req.household ? next() : res.status(409).json({ error: "You aren't a member of any household yet." });
}
const canEdit = h => !!h && (h.role === "owner" || h.role === "editor");
function requireEditor(req, res, next) { return canEdit(req.household) ? next() : res.status(403).json({ error: "You have view-only access to this household." }); }
function requireOwner(req, res, next) { return req.household?.role === "owner" ? next() : res.status(403).json({ error: "Only a household owner can do that." }); }
function requireAdmin(req, res, next) { return req.user?.isAdmin ? next() : res.status(403).json({ error: "Only the site admin can do that." }); }

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
      if (!user || (!isAdmin(user) && !store.membershipsFor(user.id).length)) return res.redirect("/login?e=noaccess&email=" + encodeURIComponent(p.email));
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

module.exports = { attachUser, requireUser, requireHousehold, requireEditor, requireOwner, requireAdmin, canEdit, isAdmin, ADMIN, routes, ensureOwner };
