# QueueFlow (Cloudflare Workers + D1)
Run these in this folder (needs Node 18+ and a free Cloudflare account):

    npm i -g wrangler && wrangler login
    wrangler d1 create queueflow-db          # copy the database_id into wrangler.toml
    wrangler d1 execute queueflow-db --remote --file=schema.sql
    wrangler secret put SECRET               # type any long random string
    wrangler deploy

Open the *.workers.dev URL it prints. First request creates the starter accounts + service catalog.
Starter logins (password Queue#2026): owner@queueflow.ph, ana@queueflow.ph, ben@queueflow.ph, carla@queueflow.ph
Local test: wrangler d1 execute queueflow-db --local --file=schema.sql && wrangler dev
