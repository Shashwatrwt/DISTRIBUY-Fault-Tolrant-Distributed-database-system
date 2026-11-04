try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { }

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json());

const PORT = process.env.PORT || 4000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}. Set it in ../.env or your shell.`);
    process.exit(1);
  }
  return value;
}
requireEnv('PG_PASSWORD');

const cluster = require('./cluster');
const txlog = require('./txlog');
const { isAlive, routedQuery, primaryPool } = cluster;
cluster.setTickHook(txlog.recover);

function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message });
}

async function migrate() {
  const steps = [
    ['users',  'users',  'password',         'TEXT'],
    ['orders', 'orders', 'delivery_address', 'TEXT'],
    ['orders', 'orders', 'payment_method',   "TEXT DEFAULT 'COD'"],
    ['orders', 'orders', 'unit_price',       'NUMERIC(10,2)'],
  ];
  for (const [domain, table, column, ddl] of steps) {
    for (const node of [cluster.DOMAINS[domain].replica, cluster.DOMAINS[domain].owner]) {
      try {
        const t = await cluster.q(node, 'SELECT to_regclass($1) AS t', [table]);
        if (!t.rows[0].t) continue;
        const c = await cluster.q(node, 'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', ['public', table, column]);
        if (c.rows.length === 0) await cluster.q(node, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      } catch (e) { cluster.logEvent('migration_skipped', { node, table, column, error: e.message }, 'warn'); }
    }
  }
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(requireEnv('ADMIN_PASSWORD'), 10);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

function issueToken(session) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}, 10 * 60 * 1000).unref();

const attempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (attempts.get(req.ip) || []).filter(t => now - t < windowMs);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many attempts, try again later' });
  recent.push(now);
  attempts.set(req.ip, recent);
  next();
}
function getToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : null;
}
function requireAuth(req, res, next) {
  const token = getToken(req);
  const session = token && sessions.get(token);
  if (session && session.expiresAt <= Date.now()) sessions.delete(token);
  if (!session || session.expiresAt <= Date.now()) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

app.post('/auth/signup', loginLimiter, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await primaryPool('users').query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    );
    const user = result.rows[0];
    const token = issueToken({ role: 'consumer', userId: user.id });
    res.status(201).json({ token, role: 'consumer', user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    sendError(res, e);
  }
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const result = await primaryPool('users').query('SELECT id, name, email, password FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueToken({ role: 'consumer', userId: user.id });
    res.json({ token, role: 'consumer', user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { sendError(res, e); }
});

app.post('/auth/admin-login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || !bcrypt.compareSync(password || '', ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = issueToken({ role: 'admin', userId: null });
  res.json({ token, role: 'admin' });
});

app.get('/auth/me', requireAuth, (req, res) => res.json({ role: req.session.role, userId: req.session.userId }));
app.post('/auth/logout', requireAuth, (req, res) => { sessions.delete(getToken(req)); res.json({ ok: true }); });

app.get('/health', async (req, res) => {
  const status = {};
  let aliveCount = 0;
  for (const node of cluster.NODE_KEYS) {
    const alive = await isAlive(node);
    status[node] = alive ? 'UP' : 'DOWN';
    if (alive) aliveCount++;
  }
  const total = cluster.NODE_KEYS.length;
  const quorum = Math.floor(total / 2) + 1;
  const cs = cluster.status();
  const roles = {};
  for (const [node, n] of Object.entries(cs.nodes)) {
    roles[node] = { primary_of: n.primary_of, replica_of: n.replica_of, out_of_service_for: n.out_of_service_for };
  }
  res.json({ ready: cs.roles_verified, nodes: status, roles, reachable: `${aliveCount}/${total}`, quorum, cluster_available: aliveCount >= quorum });
});

app.get('/cluster/status', requireAdmin, async (req, res) => {
  try { res.json({ ...cluster.status(), ...(await txlog.inDoubtReport()) }); }
  catch (e) { sendError(res, e); }
});
app.post('/cluster/switchover/:domain', requireAdmin, async (req, res) => {
  if (!cluster.DOMAIN_KEYS.includes(req.params.domain)) return res.status(404).json({ error: 'unknown domain' });
  try { res.json(await cluster.switchover(req.params.domain)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/cluster/resync/:domain', requireAdmin, async (req, res) => {
  if (!cluster.DOMAIN_KEYS.includes(req.params.domain)) return res.status(404).json({ error: 'unknown domain' });
  try { res.json(await cluster.retryResync(req.params.domain)); }
  catch (e) { res.status(409).json({ error: e.message }); }
});

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
    const result = await primaryPool('users').query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email', [name, email]);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    sendError(res, e);
  }
});

app.get('/products', async (req, res) => {
  try { res.json(await routedQuery('products')); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/products', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
  try {
    const result = await primaryPool('products').query('INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *', [name, price, stock ?? 0]);
    res.status(201).json(result.rows[0]);
  } catch (e) { sendError(res, e); }
});

app.put('/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, price, stock } = req.body;
  if (!name || price === undefined || stock === undefined) {
    return res.status(400).json({ error: 'name, price and stock are all required for an update' });
  }
  try {
    const result = await primaryPool('products').query(
      'UPDATE products SET name = $1, price = $2, stock = $3 WHERE id = $4 RETURNING *',
      [name, price, stock, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (e) { sendError(res, e); }
});

app.delete('/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await primaryPool('products').query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) { sendError(res, e); }
});

app.get('/orders', requireAuth, async (req, res) => {
  try {
    const result = req.session.role === 'admin'
      ? await routedQuery('orders')
      : await routedQuery('orders', { where: 'user_id = $1', params: [req.session.userId] });
    res.json(result);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/orders', requireAuth, async (req, res) => {
  const { product_id, quantity, delivery_address } = req.body;
  const user_id = req.session.role === 'admin' && req.body.user_id ? req.body.user_id : req.session.userId;

  if (![user_id, product_id, quantity].every(Number.isInteger) || user_id < 1 || product_id < 1 || quantity < 1) {
    return res.status(400).json({ error: 'user_id, product_id and quantity must be positive integers' });
  }
  if (req.session.role !== 'admin' && !delivery_address) {
    return res.status(400).json({ error: 'delivery_address is required' });
  }
  const { http, body } = await txlog.placeOrder({ user_id, product_id, quantity, delivery_address });
  res.status(http).json(body);
});

const VALID_ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];

app.patch('/orders/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!VALID_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_ORDER_STATUSES.join(', ')}` });
  }
  try {
    const result = await primaryPool('orders').query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (e) { sendError(res, e); }
});

app.delete('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await primaryPool('users').query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) { sendError(res, e); }
});

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
      const price = o.unit_price != null ? Number(o.unit_price) : (priceByProductId[o.product_id] || 0);
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

app.listen(PORT, (err) => {
  if (err) {
    console.error(`Cannot listen on port ${PORT}: ${err.message}. Is another API instance already running?`);
    process.exit(1);
  }
  console.log(`Distribuy API listening on http://localhost:${PORT}`);
});
(async () => {
  try {
    await cluster.start();
    await migrate();
    setTimeout(() => txlog.recover(), 1000).unref();
  } catch (e) {
    cluster.logEvent('startup_error', { error: e.message }, 'error');
  }
})();
