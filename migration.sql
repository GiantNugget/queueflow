-- QueueFlow — MIGRATION for your EXISTING database (keeps all current data)
-- Run ONCE:  npx wrangler d1 execute queueflow-db --remote --file=migration.sql
-- If a line says "duplicate column name", that column was already added earlier — that is fine, just remove that ALTER line and run again.

CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY,name TEXT NOT NULL,setup INTEGER NOT NULL,monthly INTEGER NOT NULL,max_staff INTEGER NOT NULL,milestones INTEGER NOT NULL,alerts INTEGER NOT NULL,analytics INTEGER NOT NULL,perks TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shops(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,plan_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'trial',started_at INTEGER NOT NULL,next_billing INTEGER NOT NULL,parent_id INTEGER);

INSERT OR IGNORE INTO plans(id,name,setup,monthly,max_staff,milestones,alerts,analytics,perks) VALUES
 (1,'Starter / Pilot',5000,999,0,0,0,0,'Live queue dashboard|1 administrator account|Simple queue flow: In queue → In progress → Completed|Standard system uptime support'),
 (2,'Standard Workshop',10000,2499,5,1,1,0,'Everything in Starter|Up to 5 technician accounts|Repair milestone tracking (Diagnosing, Awaiting parts, Testing)|SMS / push alerts to customers'),
 (3,'Enterprise / Multi-Branch',20000,4999,-1,1,1,1,'Everything in Standard|Unlimited administrator & technician accounts|Multi-branch analytics|Priority 99.99% uptime support & maintenance');

INSERT OR IGNORE INTO shops(id,name,plan_id,status,started_at,next_billing) VALUES(1,'Demo Shop',2,'active',CAST(strftime('%s','now') AS INTEGER)*1000,(CAST(strftime('%s','now') AS INTEGER)+2592000)*1000);

ALTER TABLE users ADD COLUMN shop_id INTEGER;
ALTER TABLE services ADD COLUMN shop_id INTEGER;
ALTER TABLE tickets ADD COLUMN shop_id INTEGER;

-- Everything that exists today becomes part of "Demo Shop"
UPDATE users SET role='owner' WHERE role='admin' AND email!='admin@flowrescent.ph';
UPDATE users SET shop_id=1 WHERE role IN ('owner','technician') AND shop_id IS NULL;
UPDATE services SET shop_id=1 WHERE shop_id IS NULL;
UPDATE tickets SET shop_id=1 WHERE shop_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_t_shop ON tickets(shop_id,status);
CREATE INDEX IF NOT EXISTS idx_s_shop ON services(shop_id);
CREATE INDEX IF NOT EXISTS idx_u_shop ON users(shop_id);
