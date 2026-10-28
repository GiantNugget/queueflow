// QueueFlow API — Cloudflare Worker + D1. Passwords: PBKDF2. Sessions: HMAC-signed tokens.
const enc = new TextEncoder();
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const fail = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ACTIVE = "('waiting','diagnosing','awaiting_parts','testing')";
const DAY30 = 30 * 864e5;
const FLOW = { waiting: ['diagnosing', 'cancelled'], diagnosing: ['awaiting_parts', 'testing', 'cancelled'], awaiting_parts: ['diagnosing', 'cancelled'], testing: ['completed', 'diagnosing', 'cancelled'] };

async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: ub64(salt), iterations: 100000, hash: 'SHA-256' }, k, 256));
}
async function hmac(s, secret) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', k, enc.encode(s)));
}
const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
const dayStart = () => Math.floor((Date.now() + 288e5) / 864e5) * 864e5 - 288e5; // Manila (UTC+8)

const SERVICES = [
  ['Smartphone', 'Screen replacement', 60, 2500], ['Smartphone', 'Battery replacement', 30, 1200], ['Smartphone', 'Charging port repair', 45, 900], ['Smartphone', 'Software fix / diagnostics', 30, 500],
  ['Laptop', 'Diagnostics & cleaning', 45, 600], ['Laptop', 'Screen replacement', 90, 3500], ['Laptop', 'OS reinstall', 60, 800], ['Laptop', 'Keyboard / battery swap', 60, 1800],
  ['Desktop', 'Diagnostics', 30, 500], ['Desktop', 'Parts swap (PSU, RAM, drive)', 45, 700], ['Desktop', 'Build / upgrade', 90, 1000],
  ['Tablet', 'Screen replacement', 75, 2800], ['Tablet', 'Battery replacement', 45, 1500],
  ['Console', 'HDMI / port repair', 90, 1800], ['Console', 'Cleaning & thermal paste', 60, 900],
  ['Smartwatch', 'Battery replacement', 45, 1000], ['Other', 'General diagnostics', 30, 400]
];
const STARTER = { waiting: ['diagnosing', 'cancelled'], diagnosing: ['completed', 'cancelled'] };
const ACCOUNTS = [['Shop Owner', 'owner@queueflow.ph', 'owner'], ['Ana Lopez', 'ana@queueflow.ph', 'customer'], ['Ben Cruz', 'ben@queueflow.ph', 'customer'], ['Carla Santos', 'carla@queueflow.ph', 'customer']];
const svcInsert = (env, sid) => SERVICES.map(s => env.DB.prepare('INSERT INTO services(device_type,name,minutes,price,shop_id) VALUES(?,?,?,?,?)').bind(...s, sid));
let seeded = false;
async function seed(env) {
  if (seeded) return;
  if (!await env.DB.prepare("SELECT 1 FROM users WHERE role='admin'").first()) { // Flowrescent system admin
    const salt = newSalt();
    await env.DB.prepare("INSERT INTO users(name,email,role,salt,pw) VALUES('Flowrescent Admin','admin@flowrescent.ph','admin',?,?)").bind(salt, await hashPw(env.ADMIN_PASSWORD || 'Flowrescent#2026', salt)).run();
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role!='admin'").first();
  if (!n) {
    const st = [];
    for (const [name, email, role] of ACCOUNTS) { const salt = newSalt(); st.push(env.DB.prepare('INSERT INTO users(name,email,role,salt,pw,shop_id) VALUES(?,?,?,?,?,?)').bind(name, email, role, salt, await hashPw('Queue#2026', salt), role === 'owner' ? 1 : null)); }
    await env.DB.batch([...st, ...svcInsert(env, 1)]);
  }
  seeded = true;
}
const shopInfo = (env, id) => env.DB.prepare('SELECT s.*,p.name plan_name,p.setup,p.monthly,p.max_staff,p.milestones,p.alerts,p.analytics,p.perks FROM shops s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').bind(id).first();
async function live(env, id) { const sh = await shopInfo(env, id); if (!sh) fail('Shop not found', 404); if (sh.status === 'suspended') fail('This shop’s subscription is suspended. Contact Flowrescent.', 403); if (sh.status === 'trial' && sh.next_billing < Date.now()) fail('This shop’s free trial has ended. Contact Flowrescent to activate a plan.', 403); return sh; }
const flowOf = sh => sh.milestones ? FLOW : { ...FLOW, ...STARTER };

async function board(env, shopId) { // live queue positions + waiting-time estimates, per shop
  const { results } = await env.DB.prepare(`SELECT * FROM tickets WHERE status IN ${ACTIVE} AND shop_id=? ORDER BY id`).bind(shopId).all();
  let ahead = 0; const map = {};
  results.forEach((t, i) => { map[t.id] = { position: i + 1, wait: ahead }; if (t.status !== 'awaiting_parts') ahead += t.est_minutes; });
  return { map, length: results.length };
}
async function estimate(env, svc) {
  const r = await env.DB.prepare("SELECT COUNT(*) c, AVG(done_at-started_at)/60000.0 a FROM tickets WHERE service_id=? AND status='completed' AND started_at IS NOT NULL").bind(svc.id).first();
  return r.c >= 3 && r.a >= 5 ? Math.round(r.a) : svc.minutes;
}
async function createTicket(env, o) {
  const svc = await env.DB.prepare('SELECT * FROM services WHERE id=? AND active=1').bind(o.service_id).first();
  if (!svc || (o.shop_id && svc.shop_id !== o.shop_id)) fail('Pick a service');
  if (!o.device?.trim()) fail('Enter the device brand and model');
  await live(env, svc.shop_id);
  const { n } = await env.DB.prepare('SELECT COUNT(*) n FROM tickets WHERE created_at>=? AND shop_id=?').bind(dayStart(), svc.shop_id).first();
  const code = 'Q-' + String(n + 1).padStart(3, '0'), est = await estimate(env, svc);
  const r = await env.DB.prepare('INSERT INTO tickets(code,user_id,customer_name,service_id,service_name,device_type,device,issue,price,source,est_minutes,created_at,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(code, o.user_id, o.customer_name, svc.id, svc.name, svc.device_type, o.device.trim(), (o.issue || '').trim().slice(0, 500), svc.price, o.source, est, Date.now(), svc.shop_id).run();
  return { id: r.meta.last_row_id, code };
}

async function api(req, env, u) {
  await seed(env);
  const m = req.method, p = u.pathname.slice(4), secret = env.SECRET || 'dev-secret-change-me';
  const b = m === 'POST' || m === 'PATCH' ? await req.json().catch(() => ({})) : {};
  const issue = async id => { const exp = Date.now() + 12 * 36e5, pl = btoa(JSON.stringify({ id, exp })); return pl + '.' + await hmac(pl, secret); };
  const authed = async () => {
    const [pl, sig] = (req.headers.get('authorization') || '').replace('Bearer ', '').split('.');
    if (!pl || sig !== await hmac(pl, secret)) fail('Please sign in', 401);
    const t = JSON.parse(atob(pl)); if (t.exp < Date.now()) fail('Session expired — sign in again', 401);
    const user = await env.DB.prepare('SELECT id,name,email,phone,role,shop_id FROM users WHERE id=?').bind(t.id).first();
    return user || fail('Please sign in', 401);
  };

  if (p === '/login' && m === 'POST') {
    const row = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind((b.email || '').trim().toLowerCase()).first();
    if (!row || row.pw !== await hashPw(b.password || '', row.salt)) fail('Wrong email or password', 401);
    return J({ token: await issue(row.id), user: { id: row.id, name: row.name, email: row.email, role: row.role, shop_id: row.shop_id } });
  }
  if (p === '/register' && m === 'POST') {
    const email = (b.email || '').trim().toLowerCase();
    if (!b.name?.trim() || !/^\S+@\S+\.\S+$/.test(email) || (b.password || '').length < 8) fail('Enter your name, a valid email and a password of 8+ characters');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) fail('That email already has an account', 409);
    const salt = newSalt();
    const r = await env.DB.prepare("INSERT INTO users(name,email,phone,role,salt,pw) VALUES(?,?,?, 'customer',?,?)").bind(b.name.trim(), email, b.phone || null, salt, await hashPw(b.password, salt)).run();
    return J({ token: await issue(r.meta.last_row_id), user: { id: r.meta.last_row_id, name: b.name.trim(), email, role: 'customer' } });
  }
  if (p === '/services' && m === 'GET') { // public: active services of ONE shop (?shop=ID)
    const sid = +u.searchParams.get('shop') || 0;
    return J((await env.DB.prepare("SELECT s.id,s.device_type,s.name,s.minutes,s.price,s.shop_id FROM services s JOIN shops h ON h.id=s.shop_id WHERE s.shop_id=? AND s.active=1 AND h.status!='suspended' ORDER BY s.device_type,s.name").bind(sid).all()).results);
  }

  const me = await authed();
  const staff = () => ['owner', 'technician'].includes(me.role) || fail('Shop staff only', 403);
  const owner = () => me.role === 'owner' || fail('Shop owner access only', 403);
  const sa = () => me.role === 'admin' || fail('Flowrescent admin only', 403);
  if (p === '/me') return J(me);

  if (p === '/tickets/mine' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT t.*,s.name shop_name,p.milestones ms,p.alerts al FROM tickets t LEFT JOIN shops s ON s.id=t.shop_id LEFT JOIN plans p ON p.id=s.plan_id WHERE t.user_id=? ORDER BY t.id DESC LIMIT 100').bind(me.id).all();
    const { results: shops } = await env.DB.prepare(`SELECT s.id,s.name,p.alerts,p.milestones,(SELECT COUNT(*) FROM tickets t WHERE t.shop_id=s.id AND t.status IN ${ACTIVE}) queue FROM shops s JOIN plans p ON p.id=s.plan_id WHERE s.status!='suspended' AND NOT (s.status='trial' AND s.next_billing<?) ORDER BY s.name`).bind(Date.now()).all();
    const maps = {}; for (const id of new Set(results.map(t => t.shop_id))) maps[id] = (await board(env, id)).map;
    return J({ shops, tickets: results.map(({ ms, al, ...t }) => ({ ...t, alerts: !!al, milestones: ms === null ? true : !!ms, ...(maps[t.shop_id]?.[t.id] || {}) })) });
  }
  if (p === '/tickets' && m === 'POST') {
    const walk = me.role !== 'customer';
    if (me.role === 'admin') fail('Admins do not book repairs', 403);
    if (walk && !b.customer_name?.trim()) fail('Enter the customer name');
    return J(await createTicket(env, { ...b, shop_id: walk ? me.shop_id : null, user_id: walk ? null : me.id, customer_name: walk ? b.customer_name.trim() : me.name, source: walk ? 'walk-in' : 'app' }), 201);
  }
  const tm = p.match(/^\/tickets\/(\d+)\/cancel$/);
  if (tm && m === 'POST') {
    const t = await env.DB.prepare('SELECT * FROM tickets WHERE id=?').bind(tm[1]).first();
    const isStaff = ['owner', 'technician'].includes(me.role) && t?.shop_id === me.shop_id;
    if (!t || (!isStaff && t.user_id !== me.id)) fail('Ticket not found', 404);
    if (!isStaff && t.status !== 'waiting') fail('The shop already started this repair — call the shop to cancel');
    if (!FLOW[t.status]) fail('This ticket is already closed');
    await env.DB.prepare("UPDATE tickets SET status='cancelled',done_at=? WHERE id=?").bind(Date.now(), t.id).run();
    return J({ ok: true });
  }

  // ---- Shop owner / technician ----
  if (p === '/admin/queue' && m === 'GET') {
    staff();
    const ds = dayStart(), sid = me.shop_id;
    const { results } = await env.DB.prepare(`SELECT * FROM tickets WHERE shop_id=? AND (status IN ${ACTIVE} OR created_at>=? OR done_at>=?) ORDER BY id`).bind(sid, ds, ds).all();
    const bd = await board(env, sid), today = results.filter(t => t.done_at >= ds || t.created_at >= ds);
    const done = today.filter(t => t.status === 'completed');
    const avg = done.filter(t => t.started_at).map(t => (t.done_at - t.started_at) / 6e4);
    return J({
      sub: await shopInfo(env, sid),
      tickets: results.map(t => ({ ...t, ...(bd.map[t.id] || {}) })),
      stats: { active: bd.length, completed: done.length, cancelled: today.filter(t => t.status === 'cancelled').length, revenue: done.reduce((s, t) => s + t.price, 0), avgMinutes: avg.length ? Math.round(avg.reduce((a, c) => a + c, 0) / avg.length) : null }
    });
  }
  if (p === '/admin/services' && m === 'GET') { staff(); return J((await env.DB.prepare('SELECT * FROM services WHERE shop_id=? ORDER BY device_type,name').bind(me.shop_id).all()).results); }
  if (p === '/admin/analytics' && m === 'GET') { // Enterprise only: per-branch analytics (head office + its branches)
    owner(); const sh = await shopInfo(env, me.shop_id);
    if (!sh.analytics) fail('Multi-branch analytics is part of the Enterprise plan. Ask Flowrescent to upgrade.', 403);
    const since = Date.now() - 30 * 864e5, wk = dayStart() - 6 * 864e5;
    const { results: branches } = await env.DB.prepare(`SELECT s.id,s.name,
      (SELECT COUNT(*) FROM tickets t WHERE t.shop_id=s.id AND t.status='completed' AND t.done_at>=?) done,
      (SELECT COALESCE(SUM(t.price),0) FROM tickets t WHERE t.shop_id=s.id AND t.status='completed' AND t.done_at>=?) revenue,
      (SELECT COUNT(*) FROM tickets t WHERE t.shop_id=s.id AND t.status IN ${ACTIVE}) active,
      (SELECT AVG(t.done_at-t.started_at)/60000.0 FROM tickets t WHERE t.shop_id=s.id AND t.status='completed' AND t.started_at IS NOT NULL AND t.done_at>=?) avg_min
      FROM shops s WHERE s.id=? OR s.parent_id=? ORDER BY s.id`).bind(since, since, since, me.shop_id, me.shop_id).all();
    const ids = branches.map(x => x.id), ph = ids.map(() => '?').join(',');
    const daily = (await env.DB.prepare(`SELECT CAST((done_at+28800000)/86400000 AS INTEGER) d, COUNT(*) n, SUM(price) revenue FROM tickets WHERE status='completed' AND done_at>=? AND shop_id IN (${ph}) GROUP BY d ORDER BY d`).bind(wk, ...ids).all()).results;
    const top = (await env.DB.prepare(`SELECT service_name name, COUNT(*) n, SUM(price) revenue FROM tickets WHERE status='completed' AND done_at>=? AND shop_id IN (${ph}) GROUP BY service_name ORDER BY n DESC LIMIT 5`).bind(since, ...ids).all()).results;
    return J({ branches: branches.map(x => ({ ...x, avg_min: x.avg_min ? Math.round(x.avg_min) : null })), daily, top });
  }
  const rm = p.match(/^\/admin\/staff\/(\d+)\/remove$/);
  if (rm && m === 'POST') { owner(); await env.DB.prepare("DELETE FROM users WHERE id=? AND shop_id=? AND role='technician'").bind(rm[1], me.shop_id).run(); return J({ ok: true }); }
  if (p === '/admin/subscription' && m === 'GET') {
    owner();
    const sub = await shopInfo(env, me.shop_id);
    return J({ sub, plans: (await env.DB.prepare('SELECT * FROM plans ORDER BY monthly').all()).results, staff: (await env.DB.prepare("SELECT id,name,email FROM users WHERE shop_id=? AND role='technician' ORDER BY id").bind(me.shop_id).all()).results });
  }
  if (p === '/admin/staff' && m === 'POST') {
    owner(); const sh = await live(env, me.shop_id), email = (b.email || '').trim().toLowerCase();
    if (!b.name?.trim() || !/^\S+@\S+\.\S+$/.test(email) || (b.password || '').length < 8) fail('Enter a name, a valid email and a password of 8+ characters');
    const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE shop_id=? AND role='technician'").bind(me.shop_id).first();
    if (sh.max_staff >= 0 && n >= sh.max_staff) fail(sh.max_staff ? `Your ${sh.plan_name} plan allows ${sh.max_staff} technician accounts. Ask Flowrescent to upgrade.` : `The ${sh.plan_name} plan has no technician accounts. Ask Flowrescent to upgrade.`, 403);
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) fail('That email already has an account', 409);
    const salt = newSalt();
    await env.DB.prepare("INSERT INTO users(name,email,role,salt,pw,shop_id) VALUES(?,?,'technician',?,?,?)").bind(b.name.trim(), email, salt, await hashPw(b.password, salt), me.shop_id).run();
    return J({ ok: true }, 201);
  }
  const pm = p.match(/^\/admin\/tickets\/(\d+)$/);
  if (pm && m === 'PATCH') {
    staff(); const sh = await live(env, me.shop_id);
    const t = await env.DB.prepare('SELECT * FROM tickets WHERE id=? AND shop_id=?').bind(pm[1], me.shop_id).first();
    if (!t) fail('Ticket not found', 404);
    if (!(flowOf(sh)[t.status] || []).includes(b.status)) fail('That status change is not allowed on your plan');
    const now = Date.now();
    await env.DB.prepare('UPDATE tickets SET status=?,started_at=COALESCE(started_at,?),done_at=? WHERE id=?')
      .bind(b.status, b.status === 'diagnosing' ? now : null, b.status === 'completed' || b.status === 'cancelled' ? now : null, t.id).run();
    return J({ ok: true });
  }
  if (p === '/admin/services' && m === 'POST') {
    owner(); await live(env, me.shop_id); if (!b.name?.trim() || !b.device_type || !(b.minutes > 0) || !(b.price >= 0)) fail('Fill in every service field');
    await env.DB.prepare('INSERT INTO services(device_type,name,minutes,price,shop_id) VALUES(?,?,?,?,?)').bind(b.device_type, b.name.trim(), +b.minutes, +b.price, me.shop_id).run();
    return J({ ok: true }, 201);
  }
  const sm = p.match(/^\/admin\/services\/(\d+)$/);
  if (sm && m === 'PATCH') {
    owner(); await live(env, me.shop_id);
    await env.DB.prepare('UPDATE services SET minutes=COALESCE(?,minutes),price=COALESCE(?,price),active=COALESCE(?,active) WHERE id=? AND shop_id=?').bind(b.minutes ?? null, b.price ?? null, b.active ?? null, sm[1], me.shop_id).run();
    return J({ ok: true });
  }

  // ---- Flowrescent system admin ----
  if (p === '/sa/overview' && m === 'GET') {
    sa();
    const { results: shops } = await env.DB.prepare(`SELECT s.*,p.name plan_name,p.monthly,(SELECT email FROM users u WHERE u.shop_id=s.id AND u.role='owner' LIMIT 1) owner_email,(SELECT COUNT(*) FROM users u WHERE u.shop_id=s.id AND u.role='technician') staff,(SELECT COUNT(*) FROM tickets t WHERE t.shop_id=s.id) tickets FROM shops s JOIN plans p ON p.id=s.plan_id ORDER BY s.id`).all();
    return J({ shops, plans: (await env.DB.prepare('SELECT * FROM plans ORDER BY monthly').all()).results, mrr: shops.filter(s => s.status === 'active' && !s.parent_id).reduce((a, s) => a + s.monthly, 0) });
  }
  if (p === '/sa/shops' && m === 'POST') {
    sa(); const email = (b.owner_email || '').trim().toLowerCase();
    if (!b.name?.trim() || !b.owner_name?.trim() || !/^\S+@\S+\.\S+$/.test(email) || (b.owner_password || '').length < 8) fail('Enter the shop name, owner name, a valid owner email and a password of 8+ characters');
    let planId = +b.plan_id, parentId = null;
    if (b.parent_id) { // a branch shares its head office's Enterprise plan
      const par = await env.DB.prepare('SELECT s.id,s.plan_id,s.parent_id,p.analytics FROM shops s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').bind(b.parent_id).first();
      if (!par || !par.analytics || par.parent_id) fail('A branch can only be added under an Enterprise head-office shop');
      planId = par.plan_id; parentId = par.id;
    }
    if (!await env.DB.prepare('SELECT 1 FROM plans WHERE id=?').bind(planId).first()) fail('Pick a plan');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) fail('That email already has an account', 409);
    const now = Date.now();
    const r = await env.DB.prepare('INSERT INTO shops(name,plan_id,status,started_at,next_billing,parent_id) VALUES(?,?,?,?,?,?)').bind(b.name.trim(), planId, b.trial ? 'trial' : 'active', now, now + DAY30, parentId).run();
    const sid = r.meta.last_row_id, salt = newSalt();
    await env.DB.batch([env.DB.prepare("INSERT INTO users(name,email,role,salt,pw,shop_id) VALUES(?,?,'owner',?,?,?)").bind(b.owner_name.trim(), email, salt, await hashPw(b.owner_password, salt), sid), ...svcInsert(env, sid)]);
    return J({ ok: true, id: sid }, 201);
  }
  const hm = p.match(/^\/sa\/shops\/(\d+)$/);
  if (hm && m === 'PATCH') {
    sa(); const sh = await env.DB.prepare('SELECT * FROM shops WHERE id=?').bind(hm[1]).first();
    if (!sh) fail('Shop not found', 404);
    if (b.plan_id && !await env.DB.prepare('SELECT 1 FROM plans WHERE id=?').bind(b.plan_id).first()) fail('Pick a plan');
    if (b.status && !['trial', 'active', 'suspended'].includes(b.status)) fail('Invalid status');
    const nb = b.renew ? Math.max(Date.now(), sh.next_billing) + DAY30 : sh.next_billing;
    const np = b.plan_id || sh.plan_id, ns = b.renew ? 'active' : b.status || sh.status;
    if (sh.parent_id && (b.plan_id || b.status || b.renew)) fail('Branches follow their head office — change the head-office shop instead');
    await env.DB.prepare('UPDATE shops SET plan_id=?,status=?,next_billing=? WHERE id=? OR parent_id=?').bind(np, ns, nb, sh.id, sh.id).run();
    return J({ ok: true });
  }
  fail('Not found', 404);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, u); } catch (e) { return J({ error: e.status ? e.message : 'Server error' }, e.status || 500); }
  }
};