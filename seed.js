// Run once after schema.sql: DATABASE_URL=... node seed.js
const fs = require('fs');
const { getPool } = require('./lib/db');
(async () => {
  const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
  const rows = data.result.data;
  const db = getPool();
  for (const item of rows) {
    const stock = Math.max(0, Math.floor(Number(item.menu_stock) || 0));
    await db.query('INSERT INTO products(id_menu,payload,stock) VALUES($1,$2,$3) ON CONFLICT(id_menu) DO NOTHING', [String(item.id_menu), JSON.stringify(item), stock]);
  }
  console.log('Imported product definitions (existing stock preserved):', rows.length);
  await db.end();
})().catch(e => { console.error(e); process.exitCode = 1; });
