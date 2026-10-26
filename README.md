# BROWN Shop — live stock and order management

This version replaces browser-only order storage with PostgreSQL-backed Vercel API functions.

## Features
- Customer menu loads live product stock from `GET /api/menu`.
- `POST /api/orders` checks prices and stock on the server and atomically deducts stock, saving the order in the same database transaction. Orders with insufficient stock are rejected.
- `admin.html` allows staff to sign in with an admin token, view the latest 100 orders, and change product stock.
- Customer browser keeps a local order-history copy for convenience.
- Loyalty-card verification is **disabled** until connected to a secure backend. The previously exposed sample `loyalty_cards` array has been removed from public `data.json`.

## Deployment
1. Create a PostgreSQL database (e.g. Neon or Supabase Postgres), and obtain its connection string.
2. Execute `schema.sql` against the database with your database SQL editor.
3. Install Node.js, then from this directory run `npm install`.
4. Set environment variable `DATABASE_URL` to the PostgreSQL connection string locally. Run `npm run seed` **once** to import products from `data.json`. The seed preserves existing stock on repeated runs.
5. Set `DATABASE_URL` and a long random `ADMIN_TOKEN` in the Vercel project settings (Environment Variables) for Production (and Preview separately if needed).
6. Deploy/redeploy this project to Vercel, then test the menu and submit a small test order. Visit `/admin` or `/admin.html` to manage stock.

### Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (server-side only) |
| `ADMIN_TOKEN` | Long random private staff/admin token (server-side only) |

**Never put either secret in `app.js`, `data.json`, or GitHub.** The admin token is entered directly by authorized staff on the admin page. For multi-staff or public production use, replace the shared admin token with authenticated staff accounts and audit logs.

## Important behavior
- Stock decreases when an order is **placed**, not when payment is captured; there is no payment integration in this project.
- There is no order cancellation/restock workflow yet. Staff can manually correct stock in the admin page.
- Product names/prices are initially seeded from `data.json`, but subsequent edits to that file alone do not update the database. Edit your products in the database or extend the admin UI.
- The `MAX_ORDER_QTY` limit is 2, enforced both client- and server-side.
- Use HTTPS and configure suitable rate limiting / bot protection for public commerce. This example should be hardened (staff auth, server-side customer verification, payment handling, availability monitoring, audit logs) before real retail production use.
- The original `data.json` is still deployed as a reference but is **not** the live stock source.
