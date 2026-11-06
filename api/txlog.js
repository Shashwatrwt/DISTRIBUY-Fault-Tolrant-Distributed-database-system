const crypto = require('crypto');
const cluster = require('./cluster');

const inflight = new Set();
const RECOVERY_GRACE_MS = Number(process.env.RECOVERY_GRACE_MS || 5000);
const FAULTS_ENABLED = process.env.DISTRIBUY_ALLOW_FAULTS === '1';

function fault(point) {
  if (FAULTS_ENABLED && process.env.DISTRIBUY_FAULT === point) {
    cluster.logEvent('fault_injected_crash', { point }, 'error');
    process.kill(process.pid, 'SIGKILL');
  }
}
function participantFaulty(name) {
  return FAULTS_ENABLED && process.env.DISTRIBUY_FAULT === `participant_down:${name}`;
}

class TxLogUnavailable extends Error {
  constructor(msg) { super(`transaction log unavailable: ${msg}`); this.status = 503; }
}

function logPool() {
  const node = cluster.primaryNode('users');
  if (!cluster.isHealthy(node)) throw new TxLogUnavailable(`Users primary ${node} is down`);
  return cluster.primaryPool('users');
}

async function logExec(sql, params) {
  try { return await logPool().query(sql, params); }
  catch (e) { throw e instanceof TxLogUnavailable ? e : new TxLogUnavailable(e.message); }
}

async function begin(txnId, participants, payload) {
  await logExec(
    `INSERT INTO txn_log (txn_id, state, participants, payload) VALUES ($1, 'INITIATED', $2, $3)`,
    [txnId, JSON.stringify(participants), JSON.stringify(payload)]);
  inflight.add(txnId);
}
const setState = (txnId, state, error) => logExec(
  `UPDATE txn_log SET state = $2::text, updated_at = now(), last_error = COALESCE($3::text, last_error),
          completed_at = CASE WHEN $2::text IN ('COMMITTED','ABORTED') THEN now() ELSE completed_at END
    WHERE txn_id = $1`, [txnId, state, error || null]);
async function decide(txnId, decision) {
  const r = await logExec(
    `UPDATE txn_log SET decision = $2, updated_at = now() WHERE txn_id = $1 AND decision IS NULL RETURNING decision`, [txnId, decision]);
  if (r.rows.length) return r.rows[0].decision;
  return (await logExec('SELECT decision FROM txn_log WHERE txn_id = $1', [txnId])).rows[0].decision;
}
const end = (txnId) => inflight.delete(txnId);

async function safeRollback(client) {
  try { await client.query('ROLLBACK'); } catch { }
}

async function placeOrder({ user_id, product_id, quantity, delivery_address }) {
  const ordersNode = cluster.primaryNode('orders');
  const productsNode = cluster.primaryNode('products');
  if (!cluster.isHealthy(ordersNode) || !cluster.isHealthy(productsNode)) {
    return { http: 503, body: { error: '2PC requires both the Orders and Products primary nodes to be reachable' } };
  }
  const txnId = `order_${crypto.randomUUID()}`;
  const gid = { orders: `${txnId}_orders`, products: `${txnId}_products` };
  const participants = {
    orders:   { node: ordersNode,   gid: gid.orders },
    products: { node: productsNode, gid: gid.products },
  };

  try { await begin(txnId, participants, { user_id, product_id, quantity }); }
  catch (e) { return { http: e.status || 500, body: { error: e.message } }; }

  let ordersClient, productsClient;
  let ordersPrepared = false, productsPrepared = false, failure = null;
  try {
    ordersClient = await cluster.pools[ordersNode].connect();
    productsClient = await cluster.pools[productsNode].connect();
    await setState(txnId, 'PREPARING');

    try {
      if (participantFaulty('products')) throw new Error('simulated: products participant unreachable');
      await productsClient.query('BEGIN');
      const s = await productsClient.query('SELECT stock, price FROM products WHERE id = $1 FOR UPDATE', [product_id]);
      if (s.rows.length === 0) throw new Error('product not found');
      const { stock, price } = s.rows[0];
      if (stock < quantity) throw new Error(`insufficient stock (have ${stock}, need ${quantity})`);
      await productsClient.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, product_id]);
      await productsClient.query(`PREPARE TRANSACTION '${gid.products}'`);
      productsPrepared = true;

      try {
        if (participantFaulty('orders')) throw new Error('simulated: orders participant unreachable');
        await ordersClient.query('BEGIN');
        await ordersClient.query(
          'INSERT INTO orders (user_id, product_id, quantity, status, delivery_address, payment_method, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [user_id, product_id, quantity, 'pending', delivery_address || null, 'COD', price]);
        await ordersClient.query(`PREPARE TRANSACTION '${gid.orders}'`);
        ordersPrepared = true;
      } catch (e) {
        failure = failure || e.message;
        await safeRollback(ordersClient);
      }
    } catch (e) {
      failure = failure || e.message;
      if (!productsPrepared) await safeRollback(productsClient);
    }
    fault('after_prepare');

    let decision;
    if (ordersPrepared && productsPrepared) {
      await setState(txnId, 'PREPARED');
      fault('after_prepared_record');
      decision = await decide(txnId, 'COMMIT');
      fault('after_decision');
    } else {
      decision = await decide(txnId, 'ABORT');
    }

    if (decision === 'COMMIT') {
      await ordersClient.query(`COMMIT PREPARED '${gid.orders}'`);
      fault('after_first_commit');
      await productsClient.query(`COMMIT PREPARED '${gid.products}'`);
      await setState(txnId, 'COMMITTED');
      return { http: 201, body: { status: 'committed', txn_id: txnId, message: 'Order placed successfully (Cash on Delivery)' } };
    }
    for (const [prepared, client, g] of [[ordersPrepared, ordersClient, gid.orders], [productsPrepared, productsClient, gid.products]]) {
      if (prepared) await client.query(`ROLLBACK PREPARED '${g}'`);
    }
    await setState(txnId, 'ABORTED', failure);
    return { http: 409, body: { status: 'aborted', txn_id: txnId, message: `Order could not be placed: ${failure || 'unknown reason'}` } };
  } catch (e) {
    cluster.logEvent('2pc_interrupted', { txn_id: txnId, error: e.message }, 'error');
    let decided = null;
    try { decided = (await logExec('SELECT decision FROM txn_log WHERE txn_id = $1', [txnId])).rows[0]?.decision; } catch { }
    if (decided === 'COMMIT') {
      return { http: 202, body: { status: 'in_doubt', txn_id: txnId, message: 'Order accepted; completion is pending recovery' } };
    }
    return { http: 503, body: { status: 'failed', txn_id: txnId, error: `Order was not completed (${e.message}); any partial work will be rolled back by recovery` } };
  } finally {
    if (ordersClient) ordersClient.release();
    if (productsClient) productsClient.release();
    end(txnId);
  }
}

async function recoverOne(row) {
  const t = row.txn_id;
  let decision = row.decision;
  if (!decision) {
    decision = await decide(t, 'ABORT');
    cluster.logEvent('2pc_recovery_decided_abort', { txn_id: t, previous_state: row.state, reason: 'coordinator crashed before a decision was logged' }, 'warn');
  }
  const verb = decision === 'COMMIT' ? 'COMMIT' : 'ROLLBACK';
  const unreachable = [];
  for (const [name, p] of Object.entries(row.participants)) {
    if (!cluster.isHealthy(p.node)) { unreachable.push(`${name}@${p.node}`); continue; }
    try {
      const has = await cluster.q(p.node, 'SELECT 1 FROM pg_prepared_xacts WHERE gid = $1', [p.gid]);
      if (has.rows.length) {
        await cluster.q(p.node, `${verb} PREPARED '${p.gid.replace(/'/g, "''")}'`);
        cluster.logEvent('2pc_recovery_applied', { txn_id: t, participant: name, node: p.node, action: `${verb} PREPARED`, decision }, 'warn');
      }
    } catch (e) { unreachable.push(`${name}@${p.node} (${e.message})`); }
  }
  if (unreachable.length) {
    await logExec('UPDATE txn_log SET last_error = $2, updated_at = now() WHERE txn_id = $1', [t, `in doubt: waiting for ${unreachable.join(', ')}`]);
    cluster.logEvent('2pc_recovery_pending', { txn_id: t, decision, waiting_for: unreachable }, 'warn');
    return 'pending';
  }
  await setState(t, decision === 'COMMIT' ? 'COMMITTED' : 'ABORTED');
  cluster.logEvent('2pc_recovery_completed', { txn_id: t, decision }, 'warn');
  return 'done';
}

let recovering = false;
async function recover() {
  if (recovering) return;
  if (!cluster.isHealthy(cluster.primaryNode('users'))) return;
  recovering = true;
  try {
    const rows = (await logExec(
      `SELECT * FROM txn_log WHERE state NOT IN ('COMMITTED','ABORTED')
          AND updated_at < now() - make_interval(secs => $1) ORDER BY created_at`, [RECOVERY_GRACE_MS / 1000])).rows;
    for (const row of rows) {
      if (inflight.has(row.txn_id)) continue;
      try { await recoverOne(row); }
      catch (e) { cluster.logEvent('2pc_recovery_error', { txn_id: row.txn_id, error: e.message }, 'error'); }
    }
  } catch (e) {
    cluster.logEvent('2pc_recovery_scan_failed', { error: e.message }, 'warn');
  } finally { recovering = false; }
}

async function inDoubtReport() {
  const out = { in_doubt: [], orphan_prepared: [] };
  try {
    out.in_doubt = (await logExec(
      `SELECT txn_id, state, decision, last_error, created_at FROM txn_log WHERE state NOT IN ('COMMITTED','ABORTED') ORDER BY created_at`)).rows;
  } catch (e) { out.log_error = e.message; return out; }
  const known = new Set((await logExec('SELECT txn_id FROM txn_log')).rows.map((r) => r.txn_id));
  for (const node of cluster.NODE_KEYS) {
    if (!cluster.isHealthy(node)) continue;
    try {
      const r = await cluster.q(node, "SELECT gid, prepared FROM pg_prepared_xacts WHERE gid LIKE 'order\\_%'");
      for (const { gid, prepared } of r.rows) {
        if (!known.has(gid.replace(/_(orders|products)$/, ''))) out.orphan_prepared.push({ node, gid, prepared });
      }
    } catch { }
  }
  return out;
}

module.exports = { placeOrder, recover, inDoubtReport, TxLogUnavailable };
