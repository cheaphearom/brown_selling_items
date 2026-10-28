
const { getPool } = require('../lib/db');
const { json } = require('../lib/http');
const { sendOrderToTelegram } = require('../lib/telegram');
const {
  validateCredentials,
  cardFingerprint
} = require('../lib/loyalty');

const DUPLICATE_MESSAGE =
  'This loyalty card has already been used to place an order. Only one order per card is allowed.';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return json(res, 405, {
      error: 'Method not allowed'
    });
  }

  const data = req.body || {};

  const name = String(data.name || '').trim();
  const phone = String(data.phone || '').trim();
  const ref = String(data.ref || '').trim();

  // Validate loyalty credentials
  const credentials = validateCredentials(
    data.card_number,
    data.serial_number
  );

  if (!credentials) {
    return json(res, 400, {
      error: 'Card number and serial number are required or invalid.'
    });
  }

  const cardNumber = credentials.card;

  // Only staff loyalty cards are allowed
  if (!cardNumber.startsWith('999')) {
    return json(res, 400, {
      error: 'Invalid loyalty card. Only staff cards starting with 999 are allowed.'
    });
  }

  const loyalty = '•••• ' + cardNumber.slice(-4);

  // Validate customer and order details
  const incoming = data.items;

  if (
    !name ||
    name.length > 60 ||
    phone.length > 20 ||
    !/^[a-f0-9-]{8,64}$/i.test(ref) ||
    !Array.isArray(incoming) ||
    incoming.length !== 1
  ) {
    return json(res, 400, {
      error: 'Invalid order details. Exactly one item per order is required.'
    });
  }

  // Only one product, quantity exactly 1
  const item = incoming[0];

  const productId = String(item?.id_menu || '').trim();
  const qty = Number(item?.qty);

  if (
    !productId ||
    productId.length > 100 ||
    !Number.isInteger(qty) ||
    qty !== 1
  ) {
    return json(res, 400, {
      error: 'Only one product with quantity 1 is allowed.'
    });
  }

  let client;

  try {
    client = await getPool().connect();
  } catch (e) {
    console.error('Order database connection:', e);

    return json(res, 500, {
      error: 'Order service unavailable.'
    });
  }

  let transactionStarted = false;

  try {
    const loyaltyKey = cardFingerprint(cardNumber);

    await client.query('BEGIN');
    transactionStarted = true;

    // 1. Lock product to prevent overselling
    const productResult = await client.query(
      `SELECT id_menu, payload, stock
       FROM products
       WHERE id_menu = $1
       FOR UPDATE`,
      [productId]
    );

    // 2. Check whether the card has already ordered
    const used = await client.query(
      `SELECT ref
       FROM shop_orders
       WHERE card_number = $1
          OR loyalty_key = $2
       LIMIT 1`,
      [cardNumber, loyaltyKey]
    );

    if (used.rowCount > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      // Retry of the same order reference
      if (used.rows[0].ref === ref) {
        const existing = await client.query(
          'SELECT * FROM shop_orders WHERE ref = $1',
          [ref]
        );

        if (existing.rowCount > 0) {
          return json(res, 200, {
            order: format(existing.rows[0]),
            duplicate: true
          });
        }
      }

      return json(res, 409, {
        available: false,
        error: DUPLICATE_MESSAGE
      });
    }

    // 3. Check reused order reference
    const existingRef = await client.query(
      'SELECT ref FROM shop_orders WHERE ref = $1',
      [ref]
    );

    if (existingRef.rowCount > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return json(res, 409, {
        error: 'This order reference has already been used.'
      });
    }

    // 4. Check product exists
    if (productResult.rowCount === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return json(res, 409, {
        error: 'Product is no longer available. Please refresh the menu.'
      });
    }

    const product = productResult.rows[0];
    const payload = product.payload || {};

    const isInactive = Number(payload.status) === 0;

    const isDeleted =
      payload.deleted_date &&
      !String(payload.deleted_date).startsWith('1900');

    if (isInactive || isDeleted) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return json(res, 409, {
        error: 'This product is no longer available.'
      });
    }

    // 5. Check stock
    if (product.stock < qty) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return json(res, 409, {
        error: `${payload.menu_name || 'Item'} is out of stock. Please refresh the menu.`
      });
    }

    // 6. Calculate price from database
    const base = Math.round(
      Number(payload.menu_price) * 100
    );

    const discount = Math.min(
      100,
      Math.max(0, Number(payload.menu_discount) || 0)
    );

    if (
      !Number.isSafeInteger(base) ||
      base < 0 ||
      !Number.isFinite(discount)
    ) {
      throw new Error('Invalid configured product price');
    }

    const unitCents = Math.round(
      base * (100 - discount) / 100
    );

    const totalCents = unitCents * qty;

    const lines = [
      {
        id_menu: product.id_menu,
        name: payload.menu_name,
        qty: 1,
        unit: unitCents / 100,
        total: totalCents / 100
      }
    ];

    // 7. Deduct stock
    const stockUpdate = await client.query(
      `UPDATE products
       SET stock = stock - $1,
           updated_at = NOW()
       WHERE id_menu = $2
         AND stock >= $1
       RETURNING stock`,
      [qty, productId]
    );

    if (stockUpdate.rowCount === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return json(res, 409, {
        error: 'Insufficient stock. Please refresh the menu.'
      });
    }

    // 8. Save order with actual card number
    await client.query(
      `INSERT INTO shop_orders (
        ref,
        customer_name,
        phone,
        loyalty,
        card_number,
        items,
        total_cents,
        loyalty_key,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )`,
      [
        ref,
        name,
        phone,
        loyalty,
        cardNumber,
        JSON.stringify(lines),
        totalCents,
        loyaltyKey,
        'placed'
      ]
    );

    // 9. Commit stock and order together
    await client.query('COMMIT');
    transactionStarted = false;

    const order = {
      ref,
      at: Date.now(),
      name,
      phone,
      loyalty,
      items: lines,
      total: totalCents / 100
    };

    // Telegram must never break the order, so errors are only logged
    try {
      await sendOrderToTelegram(order);
    } catch (tgError) {
      console.error('Telegram notify failed:', tgError);
    }

    return json(res, 201, {
      success: true,
      message: 'Order placed successfully.',
      order
    });

  } catch (e) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Order rollback:', rollbackError);
      }
    }

    // Unique constraint: card number or card fingerprint
    if (
      e.code === '23505' &&
      (
        e.constraint === 'shop_orders_card_number_unique' ||
        e.constraint === 'shop_orders_loyalty_key_unique'
      )
    ) {
      return json(res, 409, {
        available: false,
        error: DUPLICATE_MESSAGE
      });
    }

    // Unique order reference
    if (e.code === '23505') {
      return json(res, 409, {
        error: 'Duplicate order reference. Please refresh and try again.'
      });
    }

    console.error('Order error:', e);

    return json(res, 500, {
      error: 'Order could not be saved. Please retry.'
    });

  } finally {
    client.release();
  }
};

function format(row) {
  return {
    ref: row.ref,
    at: new Date(row.created_at).getTime(),
    name: row.customer_name,
    phone: row.phone,
    loyalty: row.loyalty,
    card_number: row.card_number,
    items: row.items,
    total: row.total_cents / 100
  };
}
