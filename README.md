# BROWN Shop (JSON only, no API)

A static page. There are **no API calls**. Everything comes from `data.json` or is saved in the visitor's browser.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure |
| `style.css` | Styles |
| `app.js` | All logic (cart, orders, loyalty check, receipt) |
| `data.json` | Menu items and loyalty cards (edit this) |
| `vercel.json` | Vercel settings |

## What runs where

- **Menu:** read from `data.json`.
- **Loyalty card:** checked against `loyalty_cards` in `data.json`.
- **Orders:** created in the browser and saved on the customer's device (localStorage) for 7 days.
- **Receipt:** an HTML file generated in the browser.

## Important limits (because there is no server)

- **The shop does not receive orders automatically.** Orders only exist on the customer's own device.
  To get orders, set `SHOP_WHATSAPP` in `app.js` (digits with country code, e.g. `'855123456789'`).
  The customer then gets a button that sends the order to your WhatsApp.
- **Stock is not tracked.** `menu_stock` only decides whether an item shows "Out of stock". Edit `data.json` and redeploy to change it.
- **No live order status.** There is no "preparing / ready" tracking.
- **`data.json` is public.** Anyone can open `/data.json`, including the `loyalty_cards` list (card numbers and serials). Do not put real members there.

## Edit the menu

Edit the rows in `result.data`:

```json
{
  "id_menu_group": "1",
  "group_name": "Coffee",
  "id_menu_category": "520161962052305249",
  "category_name": "Hot Drinks",
  "id_menu": "1001",
  "menu_name": "Hot Latte",
  "menu_price": "2.50",
  "menu_discount": 0,
  "menu_picture": "null",
  "index_number": 1,
  "status": 3,
  "menu_stock": 20,
  "deleted_date": "1900-01-01"
}
```

- `menu_picture`: a filename (uses `MENU_IMAGE_BASE` in `app.js`), a full `https://` URL, or `"null"` for the placeholder.
- `menu_discount`: percent off (20 = 20%).
- `menu_stock`: 0 or less shows "Out of stock".
- `status: 0` hides the item.

## Test locally

```bash
npx serve .
```

Opening `index.html` by double-click will not work, because browsers block `fetch('./data.json')` from `file://`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. Go to https://vercel.com/new and import the repository.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
4. Click **Deploy**.

Or from the folder: `npm i -g vercel` then `vercel --prod`.
