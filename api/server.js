// server.js
//
// REST API layer for the ShardCore distributed e-commerce backend.
//
// This implements the same Coordinator responsibilities as core/src/coordinator.cpp
// (routing by domain, automatic failover to a replica when a primary node is
// down, and 2PC for cross-node writes) but as a persistent Node.js/Express
// process, since a web frontend needs a long-running server to talk to over
// HTTP rather than a one-shot C++ binary. The routing/failover/2PC logic
// mirrors the C++ Coordinator's design intentionally, so both pieces of the
// project agree on the same architecture.

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// --- Cluster topology (mirrors core/src/cluster.h) ---
const NODES = {
  users:    { host: '127.0.0.1', port: 5433, table: 'users' },
  products: { host: '127.0.0.1', port: 5434, table: 'products' },
  orders:   { host: '127.0.0.1', port: 5435, table: 'orders' },
};

// Ring replication map (mirrors build_replica_map() in cluster.h):
// if a domain's primary node is down, its data can still be read from
// the node that owns the domain this map points to.
const REPLICA_OF = {
  users: 'products',
  products: 'orders',
  orders: 'users',
};

const PG_USER = 'postgres';
const PG_PASSWORD = 'kvara';

// One connection pool per node, so each node's connection state
// (up/down) is tracked independently, same as the C++ Coordinator's
// per-node NodeConnection objects.
const pools = {};
for (const [domain, cfg] of Object.entries(NODES)) {
  pools[domain] = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: PG_USER,
    password: PG_PASSWORD,
    database: 'postgres',
    max: 5,
    connectionTimeoutMillis: 2000,
  });
  // Prevent unhandled 'error' events (e.g. when a node is down) from
  // crashing the whole API process — a dead node should degrade that
  // one route, not take down the server.
  pools[domain].on('error', () => {});
}

// A real liveness check: actually queries the node rather than trusting
// a cached connection state, same principle as NodeConnection::ping()
// in the C++ Coordinator.
async function isAlive(domain) {
  try {
    await pools[domain].query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// Routes a read to the domain's primary node; falls back to the replica
// node if the primary is unreachable. Mirrors route_and_query() in
// coordinator.cpp.
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

// --- Health endpoint ---
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
  res.json({
    nodes: status,
    reachable: `${aliveCount}/${total}`,
    quorum,
    cluster_available: aliveCount >= quorum,
  });
});

// --- Users ---
app.get('/users', async (req, res) => {
  try {
    const result = await routedQuery('users');
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/users', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const result = await pools.users.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Products ---
app.get('/products', async (req, res) => {
  try {
    const result = await routedQuery('products');
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/products', async (req, res) => {
  const { name, price, stock } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  try {
    const result = await pools.products.query(
      'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *',
      [name, price, stock ?? 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Orders (read side uses routedQuery like the others) ---
app.get('/orders', async (req, res) => {
  try {
    const result = await routedQuery('orders');
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// --- Place order: real 2PC across the Orders and Products nodes ---
// Mirrors Coordinator::place_order() in coordinator.cpp exactly: both
// nodes PREPARE, and only if BOTH succeed do we COMMIT PREPARED on both;
// otherwise we ROLLBACK PREPARED on whichever one did succeed, so no
// half-finished order is ever left behind.
app.post('/orders', async (req, res) => {
  const { user_id, product_id, quantity } = req.body;
  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ error: 'user_id, product_id and quantity are required' });
  }

  if (!(await isAlive('orders')) || !(await isAlive('products'))) {
    return res.status(503).json({
      error: '2PC requires both the Orders and Products primary nodes to be reachable ' +
             '(a replica cannot be written to)',
    });
  }

  const ordersClient = await pools.orders.connect();
  const productsClient = await pools.products.connect();

  const txnId = `order_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const txnOrders = `${txnId}_orders`;
  const txnProducts = `${txnId}_products`;

  let ordersPrepared = false;
  let productsPrepared = false;

  try {
    // --- Phase 1: PREPARE ---
    try {
      await ordersClient.query('BEGIN');
      await ordersClient.query(
        'INSERT INTO orders (user_id, product_id, quantity, status) VALUES ($1, $2, $3, $4)',
        [user_id, product_id, quantity, 'pending']
      );
      await ordersClient.query(`PREPARE TRANSACTION '${txnOrders}'`);
      ordersPrepared = true;
    } catch (e) {
      console.error('Orders PREPARE failed:', e.message);
    }

    try {
      await productsClient.query('BEGIN');
      const stockResult = await productsClient.query(
        'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
        [product_id]
      );
      if (stockResult.rows.length === 0) {
        throw new Error('product not found');
      }
      const stock = stockResult.rows[0].stock;
      if (stock < quantity) {
        throw new Error(`insufficient stock (have ${stock}, need ${quantity})`);
      }
      await productsClient.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [quantity, product_id]
      );
      await productsClient.query(`PREPARE TRANSACTION '${txnProducts}'`);
      productsPrepared = true;
    } catch (e) {
      console.error('Products PREPARE failed:', e.message);
    }

    // --- Phase 2: COMMIT or ABORT ---
    if (ordersPrepared && productsPrepared) {
      await ordersClient.query(`COMMIT PREPARED '${txnOrders}'`);
      await productsClient.query(`COMMIT PREPARED '${txnProducts}'`);
      res.status(201).json({ status: 'committed', message: 'Order placed successfully' });
    } else {
      if (ordersPrepared) {
        await ordersClient.query(`ROLLBACK PREPARED '${txnOrders}'`);
      }
      if (productsPrepared) {
        await productsClient.query(`ROLLBACK PREPARED '${txnProducts}'`);
      }
      res.status(409).json({
        status: 'aborted',
        message: 'Order could not be placed - no partial changes were made',
      });
    }
  } finally {
    ordersClient.release();
    productsClient.release();
  }
});

app.listen(PORT, () => {
  console.log(`ShardCore API listening on http://localhost:${PORT}`);
});
