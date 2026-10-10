const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const NODES = {
  users:    { host: '127.0.0.1', port: 5433, table: 'users' },
  products: { host: '127.0.0.1', port: 5434, table: 'products' },
  orders:   { host: '127.0.0.1', port: 5435, table: 'orders' },
};

const REPLICA_OF = {
  users: 'products',
  products: 'orders',
  orders: 'users',
};

const PG_USER = 'postgres';
const PG_PASSWORD = 'kvara';

const pools = {};
for (const [domain, cfg] of Object.entries(NODES)) {
  pools[domain] = new Pool({
    host: cfg.host, port: cfg.port, user: PG_USER, password: PG_PASSWORD,
    database: 'postgres', max: 5, connectionTimeoutMillis: 2000,
  });
  pools[domain].on('error', () => {});
}

async function isAlive(domain) {
  try { await pools[domain].query('SELECT 1'); return true; }
  catch { return false; }
}

async function routedQuery(domain) {
  const table = NODES[domain].table;
  if (await isAlive(domain)) {
    const result = await pools[domain].query(`SELECT * FROM ${table}`);
    return { source: 'primary', node: domain, rows: result.rows };
  }
  const replicaDomain = REPLICA_OF[domain];
  if (replicaDomain && (await isAlive(replicaDomain))) {
    const result = await pools[replicaDomain].query(`SELECT * FROM ${table}`);
    return { source: 'replica', node: replicaDomain, rows: result.rows };
  }
  throw new Error(`${domain} is unreachable and no live replica was found`);
}

// One-time migrations (safe to run repeatedly — IF NOT EXISTS).
(async () => {
  try {
    await pools.users.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;');
    await pools.orders.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;");
    await pools.orders.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'COD';");
  } catch (e) {
    console.error('Migration error:', e.message);
  }
})();

// --- Auth ---
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('admin123', 10);
const sessions = new Map();

function issueToken(session) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, session);
  return token;
}
function getToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : null;
}
function requireAuth(req, res, next) {
  const token = getToken(req);
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

app.post('/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pools.users.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    );
    const user = result.rows[0];
    const token = issueToken({ role: 'consumer', userId: user.id });
    res.status(201).json({ token, role: 'consumer', user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const result = await pools.users.query('SELECT id, name, email, password FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueToken({ role: 'consumer', userId: user.id });
    res.json({ token, role: 'consumer', user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/admin-login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || !bcrypt.compareSync(password || '', ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = issueToken({ role: 'admin', userId: null });
  res.json({ token, role: 'admin' });
});

app.get('/auth/me', requireAuth, (req, res) => res.json({ role: req.session.role, userId: req.session.userId }));
app.post('/auth/logout', requireAuth, (req, res) => { sessions.delete(getToken(req)); res.json({ ok: true }); });

// --- Health ---
app.get('/health', async (req, res) => {
  const status = {};
  let aliveCount = 0;
  for (const domain of Object.keys(NODES)) {
    const alive = await isAlive(domain);
    status[domain] = alive ? 'UP' : 'DOWN';
    if (alive) aliveCount++;
  }
  const total = Object.keys(NODES).length;
  const quorum = Math.floor(total / 2) + 1;
  res.json({ nodes: status, reachable: `${aliveCount}/${total}`, quorum, cluster_available: aliveCount >= quorum });
});

// --- Users ---
// Admin-only, and only an explicit allow-list of columns is returned. This
// endpoint used to be public and ran SELECT *, so it exposed every user's
// email AND their bcrypt `password` hash to anyone who called it.
app.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await routedQuery('users');
    const rows = result.rows.map(({ id, name, email, created_at }) => ({ id, name, email, created_at }));
    res.json({ ...result, rows });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/users', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const result = await pools.users.query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email', [name, email]);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// --- Products (full CRUD for admin; read is public) ---
app.get('/products', async (req, res) => {
  try { res.json(await routedQuery('products')); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/products', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
  try {
    const result = await pools.products.query('INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *', [name, price, stock ?? 0]);
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, price, stock } = req.body;
  if (!name || price === undefined || stock === undefined) {
    return res.status(400).json({ error: 'name, price and stock are all required for an update' });
  }
  try {
    const result = await pools.products.query(
      'UPDATE products SET name = $1, price = $2, stock = $3 WHERE id = $4 RETURNING *',
      [name, price, stock, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pools.products.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    // Note: orders.product_id is intentionally not a foreign key (see
    // docs/partitioning.md — cross-node FKs aren't enforceable by Postgres
    // here), so existing orders referencing a deleted product are left as-is.
    res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Orders ---
// Requires login: an admin sees every order (needed for the Order Manager
// dashboard), but a consumer only ever sees their own orders — this also
// closes a previous gap where this endpoint was public and unauthenticated,
// exposing every customer's delivery address to anyone who called it.
app.get('/orders', requireAuth, async (req, res) => {
  try {
    const result = await routedQuery('orders');
    if (req.session.role === 'admin') {
      return res.json(result);
    }
    const ownOrders = result.rows.filter(o => o.user_id === req.session.userId);
    res.json({ source: result.source, node: result.node, rows: ownOrders });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/orders', requireAuth, async (req, res) => {
  const { product_id, quantity, delivery_address } = req.body;
  const user_id = req.session.role === 'admin' && req.body.user_id ? req.body.user_id : req.session.userId;

  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ error: 'product_id and quantity are required' });
  }
  // Admin's raw 2PC test form doesn't need a real delivery address.
  if (req.session.role !== 'admin' && !delivery_address) {
    return res.status(400).json({ error: 'delivery_address is required' });
  }
  if (!(await isAlive('orders')) || !(await isAlive('products'))) {
    return res.status(503).json({ error: '2PC requires both the Orders and Products primary nodes to be reachable' });
  }

  const ordersClient = await pools.orders.connect();
  const productsClient = await pools.products.connect();
  const txnId = `order_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const txnOrders = `${txnId}_orders`;
  const txnProducts = `${txnId}_products`;
  let ordersPrepared = false;
  let productsPrepared = false;

  try {
    try {
      await ordersClient.query('BEGIN');
      await ordersClient.query(
        'INSERT INTO orders (user_id, product_id, quantity, status, delivery_address, payment_method) VALUES ($1, $2, $3, $4, $5, $6)',
        [user_id, product_id, quantity, 'pending', delivery_address || null, 'COD']
      );
      await ordersClient.query(`PREPARE TRANSACTION '${txnOrders}'`);
      ordersPrepared = true;
    } catch (e) { console.error('Orders PREPARE failed:', e.message); }

    try {
      await productsClient.query('BEGIN');
      const stockResult = await productsClient.query('SELECT stock FROM products WHERE id = $1 FOR UPDATE', [product_id]);
      if (stockResult.rows.length === 0) throw new Error('product not found');
      const stock = stockResult.rows[0].stock;
      if (stock < quantity) throw new Error(`insufficient stock (have ${stock}, need ${quantity})`);
      await productsClient.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, product_id]);
      await productsClient.query(`PREPARE TRANSACTION '${txnProducts}'`);
      productsPrepared = true;
    } catch (e) { console.error('Products PREPARE failed:', e.message); }

    if (ordersPrepared && productsPrepared) {
      await ordersClient.query(`COMMIT PREPARED '${txnOrders}'`);
      await productsClient.query(`COMMIT PREPARED '${txnProducts}'`);
      res.status(201).json({ status: 'committed', message: 'Order placed successfully (Cash on Delivery)' });
    } else {
      if (ordersPrepared) await ordersClient.query(`ROLLBACK PREPARED '${txnOrders}'`);
      if (productsPrepared) await productsClient.query(`ROLLBACK PREPARED '${txnProducts}'`);
      res.status(409).json({ status: 'aborted', message: 'Order could not be placed - no partial changes were made' });
    }
  } finally {
    ordersClient.release();
    productsClient.release();
  }
});

// --- Order status management (admin-only) ---
// This is a single-node update (only the Orders node's own row changes),
// so it does NOT go through 2PC — unlike placing an order, which touches
// both Orders and Products and needs that atomicity guarantee. Updating
// a status field here never needs a second node to agree.
const VALID_ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];

app.patch('/orders/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!VALID_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_ORDER_STATUSES.join(', ')}` });
  }
  try {
    const result = await pools.orders.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- User deletion (admin-only) ---
app.delete('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pools.users.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    // Note: orders.user_id is not a foreign key (cross-node, same reasoning
    // as products — see docs/partitioning.md), so existing orders placed by
    // a deleted user are left as historical records, not cascaded.
    res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Admin dashboard stats: a genuine cross-node aggregation ---
// No single node has both order quantities (Orders node) and product
// prices (Products node), so computing "total order value" requires the
// API layer to pull from both and join them in memory — a small, honest
// example of the kind of work a Coordinator does that a single database
// instance wouldn't need to.
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [ordersResult, productsResult, usersResult] = await Promise.all([
      routedQuery('orders'),
      routedQuery('products'),
      routedQuery('users'),
    ]);

    const priceByProductId = {};
    for (const p of productsResult.rows) priceByProductId[p.id] = Number(p.price);

    let totalOrderValue = 0;
    const statusCounts = { pending: 0, shipped: 0, delivered: 0, cancelled: 0 };
    for (const o of ordersResult.rows) {
      const price = priceByProductId[o.product_id] || 0;
      totalOrderValue += price * o.quantity;
      if (statusCounts[o.status] !== undefined) statusCounts[o.status]++;
    }

    const lowStockCount = productsResult.rows.filter(p => p.stock > 0 && p.stock <= 3).length;
    const outOfStockCount = productsResult.rows.filter(p => p.stock <= 0).length;

    res.json({
      totalOrderValue: totalOrderValue.toFixed(2),
      orderCount: ordersResult.rows.length,
      userCount: usersResult.rows.length,
      productCount: productsResult.rows.length,
      lowStockCount,
      outOfStockCount,
      statusCounts,
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`ShardCore API listening on http://localhost:${PORT}`));
