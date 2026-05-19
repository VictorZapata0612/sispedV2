const express = require('express');
const cors = require('cors');
const path = require('path');
const { openDatabase } = require('./db');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRangeBounds(range) {
  const end = new Date();
  const start = new Date(end);

  if (range === 'week') {
    start.setDate(start.getDate() - 7);
  } else if (range === 'month') {
    start.setMonth(start.getMonth() - 1);
  } else {
    start.setDate(start.getDate() - 1);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function buildStats(db, range) {
  const { start, end } = getRangeBounds(range);
  const query = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'entregado' THEN 1 ELSE 0 END) AS delivered_orders,
      SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END) AS cancelled_orders,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(AVG(total), 0) AS average_ticket
    FROM orders
    WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
  `).get(start, end);

  const productQuery = db.prepare(`
    SELECT p.name, SUM(oi.quantity) AS qty
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN products p ON p.id = oi.product_id
    WHERE datetime(o.created_at) BETWEEN datetime(?) AND datetime(?)
    GROUP BY p.id
    ORDER BY qty DESC, p.name ASC
    LIMIT 1
  `).get(start, end);

  const driverQuery = db.prepare(`
    SELECT d.name, COUNT(*) AS total_assigned
    FROM orders o
    INNER JOIN drivers d ON d.id = o.driver_id
    WHERE o.driver_id IS NOT NULL AND datetime(o.created_at) BETWEEN datetime(?) AND datetime(?)
    GROUP BY d.id
    ORDER BY total_assigned DESC, d.name ASC
    LIMIT 1
  `).get(start, end);

  return {
    range,
    start,
    end,
    totalOrders: query.total_orders || 0,
    deliveredOrders: query.delivered_orders || 0,
    cancelledOrders: query.cancelled_orders || 0,
    totalSales: query.total_sales || 0,
    averageTicket: query.average_ticket || 0,
    topProduct: productQuery ? productQuery.name : 'Sin datos',
    topDriver: driverQuery ? driverQuery.name : 'Sin datos'
  };
}

function createRouteSuggestion(db, orderId) {
  const order = db.prepare(`
    SELECT o.*, c.name AS client_name, d.name AS driver_name
    FROM orders o
    INNER JOIN clients c ON c.id = o.client_id
    LEFT JOIN drivers d ON d.id = o.driver_id
    WHERE o.id = ?
  `).get(orderId);

  if (!order) {
    return null;
  }

  const siblingOrders = db.prepare(`
    SELECT id, barrio, address, total, status
    FROM orders
    WHERE id != ? AND status IN ('listo para salir', 'en ruta')
    ORDER BY barrio ASC, datetime(created_at) ASC
    LIMIT 5
  `).all(orderId);

  const route = [
    {
      label: 'Restaurante Shadday Wok',
      barrio: 'Punto base'
    },
    ...siblingOrders.map((item) => ({
      label: `Pedido #${item.id}`,
      barrio: item.barrio,
      address: item.address,
      status: item.status
    }))
  ];

  const suggestion = db.prepare(`
    INSERT INTO route_suggestions (order_id, driver_id, barrio_group, route_json, distance_km, eta_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    order.id,
    order.driver_id,
    order.barrio,
    JSON.stringify(route),
    Math.max(route.length - 1, 1) * 2.4,
    Math.max(route.length - 1, 1) * 8
  );

  return {
    id: suggestion.lastInsertRowid,
    orderId: order.id,
    route,
    driver: order.driver_name,
    barrio: order.barrio,
    distanceKm: Math.max(route.length - 1, 1) * 2.4,
    etaMinutes: Math.max(route.length - 1, 1) * 8
  };
}

async function startServer() {
  const db = await openDatabase();
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'renderer')));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, app: 'Shadday Wok' });
  });

  app.get('/api/clients', (request, response) => {
    const search = String(request.query.q || '').trim();
    const clients = search
      ? db.prepare(`
          SELECT c.*, COUNT(a.id) AS address_count
          FROM clients c
          LEFT JOIN client_addresses a ON a.client_id = c.id
          WHERE c.name LIKE ? OR c.phone LIKE ?
          GROUP BY c.id
          ORDER BY c.updated_at DESC
        `).all(`%${search}%`, `%${normalizePhone(search)}%`)
      : db.prepare(`
          SELECT c.*, COUNT(a.id) AS address_count
          FROM clients c
          LEFT JOIN client_addresses a ON a.client_id = c.id
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT 20
        `).all();

    response.json(clients.map((client) => ({
      ...client,
      primaryAddress: db.prepare(`
        SELECT * FROM client_addresses
        WHERE client_id = ?
        ORDER BY is_primary DESC, created_at DESC
        LIMIT 1
      `).get(client.id) || null
    })));
  });

  app.post('/api/clients/resolve', (request, response) => {
    const name = String(request.body.name || '').trim();
    const phone = normalizePhone(request.body.phone);
    const address = String(request.body.address || '').trim();
    const barrio = String(request.body.barrio || '').trim();
    const reference = String(request.body.reference || '').trim();
    const notes = String(request.body.notes || '').trim();

    if (!name || !phone) {
      return response.status(400).json({ message: 'Nombre y telefono son obligatorios.' });
    }

    const existing = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
    const saveClient = existing
      ? db.prepare('UPDATE clients SET name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      : db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)');

    let clientId = existing ? existing.id : null;

    if (existing) {
      saveClient.run(name, notes, existing.id);
    } else {
      const result = saveClient.run(name, phone, notes);
      clientId = result.lastInsertRowid;
    }

    if (address) {
      if (request.body.setPrimaryAddress !== false) {
        db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(clientId);
      }

      db.prepare(`
        INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(clientId, request.body.label || 'principal', address, barrio, reference, request.body.setPrimaryAddress === false ? 0 : 1);
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    const primaryAddress = db.prepare(`
      SELECT * FROM client_addresses WHERE client_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1
    `).get(clientId) || null;

    response.json({
      client,
      primaryAddress
    });
  });

  app.get('/api/products', (_request, response) => {
    response.json(db.prepare('SELECT * FROM products ORDER BY active DESC, category ASC, name ASC').all());
  });

  app.post('/api/products', (request, response) => {
    const name = String(request.body.name || '').trim();
    const category = String(request.body.category || 'General').trim();
    const price = toNumber(request.body.price);
    const comboItems = JSON.stringify(Array.isArray(request.body.comboItems) ? request.body.comboItems : []);

    if (!name) {
      return response.status(400).json({ message: 'El nombre del producto es obligatorio.' });
    }

    const result = db.prepare(`
      INSERT INTO products (name, category, price, combo_items, active)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, category, price, comboItems, request.body.active === false ? 0 : 1);

    response.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid));
  });

  app.get('/api/drivers', (_request, response) => {
    response.json(db.prepare('SELECT * FROM drivers ORDER BY active DESC, name ASC').all());
  });

  app.post('/api/drivers', (request, response) => {
    const name = String(request.body.name || '').trim();
    const phone = normalizePhone(request.body.phone);
    const vehicle = String(request.body.vehicle || 'Moto').trim();
    const zone = String(request.body.zone || '').trim();

    if (!name) {
      return response.status(400).json({ message: 'El nombre del domiciliario es obligatorio.' });
    }

    const result = db.prepare(`
      INSERT INTO drivers (name, phone, vehicle, zone, active, current_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, phone, vehicle, zone, request.body.active === false ? 0 : 1, 'disponible');

    response.status(201).json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(result.lastInsertRowid));
  });

  app.patch('/api/drivers/:id/active', (request, response) => {
    const active = request.body.active ? 1 : 0;
    db.prepare('UPDATE drivers SET active = ?, current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(active, active ? 'disponible' : 'inactivo', request.params.id);
    response.json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(request.params.id));
  });

  app.get('/api/orders', (_request, response) => {
    const orders = db.prepare(`
      SELECT o.*, c.name AS client_name, c.phone AS client_phone, d.name AS driver_name
      FROM orders o
      INNER JOIN clients c ON c.id = o.client_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      ORDER BY datetime(o.created_at) DESC
      LIMIT 100
    `).all();

    const itemsByOrder = db.prepare(`
      SELECT oi.*
      FROM order_items oi
      ORDER BY oi.id DESC
    `).all().reduce((accumulator, item) => {
      if (!accumulator[item.order_id]) {
        accumulator[item.order_id] = [];
      }
      accumulator[item.order_id].push(item);
      return accumulator;
    }, {});

    response.json(orders.map((order) => ({
      ...order,
      items: itemsByOrder[order.id] || []
    })));
  });

  app.post('/api/orders', (request, response) => {
    const clientData = request.body.client || {};
    const items = Array.isArray(request.body.items) ? request.body.items : [];
    const paymentMethod = String(request.body.paymentMethod || 'Efectivo').trim();
    const status = String(request.body.status || 'nuevo').trim();
    const driverId = request.body.driverId ? Number(request.body.driverId) : null;

    const resolved = request.body.clientId
      ? { client: db.prepare('SELECT * FROM clients WHERE id = ?').get(request.body.clientId), primaryAddress: null }
      : (() => {
          const result = db.prepare(`
            SELECT c.*
            FROM clients c
            WHERE c.phone = ?
          `).get(normalizePhone(clientData.phone));
          if (result) {
            const resolvedClient = db.prepare('UPDATE clients SET name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(String(clientData.name || '').trim() || result.name, String(clientData.notes || '').trim(), result.id);
            const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.id);
            return { client, primaryAddress: null };
          }
          const insertClient = db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)');
          const insertAddress = db.prepare('INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary) VALUES (?, ?, ?, ?, ?, ?)');
          const clientResult = insertClient.run(String(clientData.name || '').trim(), normalizePhone(clientData.phone), String(clientData.notes || '').trim());
          if (clientData.address) {
            insertAddress.run(clientResult.lastInsertRowid, 'principal', String(clientData.address || '').trim(), String(clientData.barrio || '').trim(), String(clientData.reference || '').trim(), 1);
          }
          return {
            client: db.prepare('SELECT * FROM clients WHERE id = ?').get(clientResult.lastInsertRowid),
            primaryAddress: null
          };
        })();

    if (!resolved.client) {
      return response.status(400).json({ message: 'No fue posible resolver el cliente.' });
    }

    const normalizedItems = items
      .filter((item) => item.productId)
      .map((item) => ({
        productId: Number(item.productId),
        quantity: Math.max(1, Number(item.quantity) || 1)
      }));

    if (normalizedItems.length === 0) {
      return response.status(400).json({ message: 'Debes agregar al menos un producto.' });
    }

    const productLookup = db.prepare('SELECT * FROM products WHERE id = ?');
    const transaction = db.transaction(() => {
      const total = normalizedItems.reduce((sum, item) => {
        const product = productLookup.get(item.productId);
        if (!product) {
          throw new Error(`Producto no encontrado: ${item.productId}`);
        }
        return sum + (Number(product.price) * item.quantity);
      }, 0);

      const orderResult = db.prepare(`
        INSERT INTO orders (client_id, driver_id, status, payment_method, barrio, address, reference, notes, total, route_zone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolved.client.id,
        driverId,
        status,
        paymentMethod,
        String(clientData.barrio || '').trim(),
        String(clientData.address || '').trim(),
        String(clientData.reference || '').trim(),
        String(clientData.notes || '').trim(),
        total,
        String(clientData.zone || String(clientData.barrio || '')).trim()
      );

      normalizedItems.forEach((item) => {
        const product = productLookup.get(item.productId);
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, name_snapshot, quantity, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(orderResult.lastInsertRowid, product.id, product.name, item.quantity, product.price, product.price * item.quantity);
      });

      if (driverId) {
        db.prepare('UPDATE drivers SET current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('en ruta', driverId);
      }

      const createdOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderResult.lastInsertRowid);
      return createdOrder;
    });

    try {
      const createdOrder = transaction();
      const routeSuggestion = createRouteSuggestion(db, createdOrder.id);
      response.status(201).json({ order: createdOrder, routeSuggestion });
    } catch (error) {
      response.status(400).json({ message: error.message });
    }
  });

  app.get('/api/routes/suggest', (request, response) => {
    const driverId = request.query.driverId ? Number(request.query.driverId) : null;
    const orders = db.prepare(`
      SELECT o.id, o.barrio, o.address, o.status, o.total, c.name AS client_name
      FROM orders o
      INNER JOIN clients c ON c.id = o.client_id
      WHERE o.status IN ('listo para salir', 'en ruta')
      ORDER BY o.barrio ASC, datetime(o.created_at) ASC
    `).all();

    const grouped = orders.reduce((accumulator, order) => {
      const key = order.barrio || 'Sin barrio';
      if (!accumulator[key]) {
        accumulator[key] = [];
      }
      accumulator[key].push(order);
      return accumulator;
    }, {});

    response.json({
      driverId,
      grouped,
      sequence: Object.entries(grouped).flatMap(([barrio, barrioOrders]) => barrioOrders.map((order) => ({ ...order, barrio })))
    });
  });

  app.get('/api/stats', (request, response) => {
    const range = ['day', 'week', 'month'].includes(String(request.query.range || 'day'))
      ? String(request.query.range || 'day')
      : 'day';
    response.json(buildStats(db, range));
  });

  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  });

  const server = app.listen(0, '127.0.0.1');

  return new Promise((resolve) => {
    server.on('listening', () => {
      resolve({
        app,
        db,
        server,
        port: server.address().port
      });
    });
  });
}

module.exports = {
  startServer
};

if (require.main === module) {
  startServer().then((info) => {
    console.log(`Servidor listo en http://127.0.0.1:${info.port}`);
  });
}
