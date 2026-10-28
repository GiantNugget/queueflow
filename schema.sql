-- QueueFlow — FULL schema for a brand-new database (plans, shops, users, services, tickets)
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY,name TEXT NOT NULL,setup INTEGER NOT NULL,monthly INTEGER NOT NULL,max_staff INTEGER NOT NULL,milestones INTEGER NOT NULL,alerts INTEGER NOT NULL,analytics INTEGER NOT NULL,perks TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shops(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,plan_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'trial',started_at INTEGER NOT NULL,next_billing INTEGER NOT NULL,parent_id INTEGER);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,role TEXT NOT NULL DEFAULT 'customer',salt TEXT NOT NULL,pw TEXT NOT NULL,shop_id INTEGER);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY AUTOINCREMENT,device_type TEXT NOT NULL,name TEXT NOT NULL,minutes INTEGER NOT NULL,price INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,shop_id INTEGER);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL,user_id INTEGER,customer_name TEXT NOT NULL,service_id INTEGER,service_name TEXT NOT NULL,device_type TEXT NOT NULL,device TEXT NOT NULL,issue TEXT,price INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'waiting',source TEXT NOT NULL DEFAULT 'app',est_minutes INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,done_at INTEGER,shop_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_t_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_t_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_t_shop ON tickets(shop_id,status);
CREATE INDEX IF NOT EXISTS idx_s_shop ON services(shop_id);
CREATE INDEX IF NOT EXISTS idx_u_shop ON users(shop_id);

-- Plans from the Product/Service Description (max_staff: 0 = none, -1 = unlimited)
INSERT OR IGNORE INTO plans(id,name,setup,monthly,max_staff,milestones,alerts,analytics,perks) VALUES
 (1,'Starter / Pilot',5000,999,0,0,0,0,'Live queue dashboard|1 administrator account|Simple queue flow: In queue → In progress → Completed|Standard system uptime support'),
 (2,'Standard Workshop',10000,2499,5,1,1,0,'Everything in Starter|Up to 5 technician accounts|Repair milestone tracking (Diagnosing, Awaiting parts, Testing)|SMS / push alerts to customers'),
 (3,'Enterprise / Multi-Branch',20000,4999,-1,1,1,1,'Everything in Standard|Unlimited administrator & technician accounts|Multi-branch analytics|Priority 99.99% uptime support & maintenance');

-- Sample shop (the app creates its accounts and services on first request)
INSERT OR IGNORE INTO shops(id,name,plan_id,status,started_at,next_billing) VALUES(1,'Demo Shop',2,'active',CAST(strftime('%s','now') AS INTEGER)*1000,(CAST(strftime('%s','now') AS INTEGER)+2592000)*1000);
