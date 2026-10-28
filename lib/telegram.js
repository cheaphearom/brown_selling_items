function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendOrderToTelegram(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const itemLines = order.items
    .map(i => `• ${esc(i.name)} x${i.qty} — ${i.total}`)
    .join('\n');

  const text =
    `🛒 <b>New order</b>\n` +
    `Ref: <code>${esc(order.ref)}</code>\n` +
    `Name: ${esc(order.name)}\n` +
    `Phone: ${esc(order.phone || '-')}\n` +
    `Card: ${esc(order.loyalty)}\n\n` +
    `${itemLines}\n\n` +
    `<b>Total: ${order.total}</b>`;

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(5000)
  });

  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

module.exports = { sendOrderToTelegram };