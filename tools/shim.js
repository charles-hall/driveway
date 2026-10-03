/* Server bridge: gives the app the same small data API it used inside Claude
   (collection/doc, onSnapshot, set/update/delete), backed by this server's /api.
   Changes from other people show up within about 20 seconds, or right away
   when the app is reopened. */
(function () {
  const COLS = ["vehicles", "parts", "history"];
  const listeners = { vehicles: [], parts: [], history: [] };
  let cache = null, version = null, me = null;

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { location.href = "/login"; throw { code: "signed_out", message: "Signed out" }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 403 ? "invalid_argument" : "unavailable", message: j.error || r.statusText };
    return j;
  }

  function emit(col) {
    const docs = (cache?.[col] || []).map(d => { const { id, ...b } = d; return { id, exists: true, data: () => b }; });
    listeners[col].forEach(l => {
      let ds = docs;
      if (l.order) ds = [...docs].sort((a, b) => (a.data()[l.order] ?? Infinity) - (b.data()[l.order] ?? Infinity));
      try { l.next({ docs: ds, size: ds.length, empty: !ds.length }); } catch (e) { console.error(e); }
    });
  }

  async function refresh(force) {
    try {
      if (!force && cache) { const v = await api("GET", "/api/version"); if (v.version === version) return; }
      const s = await api("GET", "/api/state");
      version = s.version; cache = s;
      COLS.forEach(emit);
    } catch (e) { if (e.code !== "signed_out") console.warn("refresh failed", e); }
  }

  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      async set(body) { await api("PUT", `/api/${col}/${encodeURIComponent(id)}`, body); await refresh(true); },
      async update(body) {
        const cur = (cache?.[col] || []).find(d => d.id === id);
        if (!cur) throw { code: "invalid_argument", message: "Not found" };
        const { id: _, ...b } = cur; await this.set({ ...b, ...body });
      },
      async delete() { await api("DELETE", `/api/${col}/${encodeURIComponent(id)}`); await refresh(true); },
      async get() { const d = (cache?.[col] || []).find(x => x.id === id); const { id: _, ...b } = d || {}; return { id, exists: !!d, data: () => (d ? b : undefined) }; },
    };
  }

  function collection(col) {
    const base = {
      _order: null,
      orderBy(f) { const n = Object.create(base); n._order = f; return n; },
      doc(id) { return docRef(col, id || rid()); },
      onSnapshot(next) {
        const l = { next, order: this._order };
        listeners[col].push(l);
        if (cache) setTimeout(() => emit(col), 0);
        return () => { listeners[col] = listeners[col].filter(x => x !== l); };
      },
    };
    return base;
  }

  const db = { collection, doc(path) { const [c, id] = path.split("/"); return docRef(c, id); } };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return { status: "saved" };
    },
  };

  const ready = Promise.all([api("GET", "/api/me").then(m => { me = m; }), refresh(true)]);

  setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(false); });

  window.claude = {
    async use(name) {
      if (name === "db") { await ready; return db; }
      if (name === "user") { await ready; return { can: async () => me.role !== "viewer", isOwner: () => me.role === "owner" }; }
      if (name === "downloads") return downloads;
      return null;
    },
  };
  window.DRIVEWAY = { get me() { return me; }, set me(v) { me = v; }, api, refresh, ready };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(e => console.warn("service worker", e));
})();
