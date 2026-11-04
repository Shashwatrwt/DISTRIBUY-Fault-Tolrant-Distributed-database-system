const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD;

const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 2000);
const FAILOVER_MISS_THRESHOLD = Number(process.env.FAILOVER_MISS_THRESHOLD || 3);
const FAILOVER_MAX_LAG_BYTES = Number(process.env.FAILOVER_MAX_LAG_BYTES || 1048576);
const SEQUENCE_GAP = Number(process.env.SEQUENCE_GAP || 100);
const RESYNC_TIMEOUT_MS = Number(process.env.RESYNC_TIMEOUT_MS || 60000);
const EVENT_LOG = process.env.CLUSTER_EVENT_LOG || path.join(__dirname, 'logs', 'cluster-events.jsonl');

const NODES = {
  users:    { host: '127.0.0.1', port: 5433 },
  products: { host: '127.0.0.1', port: 5434 },
  orders:   { host: '127.0.0.1', port: 5435 },
};
const NODE_KEYS = Object.keys(NODES);
const MAJORITY = Math.floor(NODE_KEYS.length / 2) + 1;

const DOMAINS = {
  users:    { owner: 'users',    replica: 'products', table: 'users',    seq: 'users_id_seq',    tables: ['users', 'txn_log'] },
  products: { owner: 'products', replica: 'orders',   table: 'products', seq: 'products_id_seq', tables: ['products'] },
  orders:   { owner: 'orders',   replica: 'users',    table: 'orders',   seq: 'orders_id_seq',   tables: ['orders'] },
};
const DOMAIN_KEYS = Object.keys(DOMAINS);
const GUARDED_TABLES = [['users', 'users'], ['products', 'products'], ['orders', 'orders'], ['txn_log', 'users']];

const pools = {};
for (const [node, cfg] of Object.entries(NODES)) {
  pools[node] = new Pool({
    host: cfg.host, port: cfg.port, user: PG_USER, password: PG_PASSWORD,
    database: 'postgres', max: 5, connectionTimeoutMillis: 2000, query_timeout: 8000,
  });
  pools[node].on('error', () => {});
}
const q = (node, sql, params) => pools[node].query(sql, params);

const recentEvents = [];
try {
  if (fs.existsSync(EVENT_LOG)) {
    const lines = fs.readFileSync(EVENT_LOG, 'utf8').trim().split('\n').slice(-100);
    for (const l of lines) { try { recentEvents.push(JSON.parse(l)); } catch { } }
  }
} catch { }

function logEvent(event, fields = {}, level = 'info') {
  const rec = { ts: new Date().toISOString(), level, event, ...fields };
  recentEvents.push(rec);
  if (recentEvents.length > 200) recentEvents.shift();
  const line = JSON.stringify(rec);
  (level === 'error' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(path.dirname(EVENT_LOG), { recursive: true });
    fs.appendFileSync(EVENT_LOG, line + '\n');
  } catch { }
}

const roles = {};
let rolesVerified = false;
const health = {};
for (const n of NODE_KEYS) health[n] = { up: null, misses: 0, downSince: null, upTicks: 0, lastOk: null };
const lag = {};
const blocked = {};
const resyncing = {};
const switching = {};
let tickHook = null;

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const connVal = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const connString = (node) =>
  `host=${NODES[node].host} port=${NODES[node].port} dbname=postgres user=${connVal(PG_USER)} password=${connVal(PG_PASSWORD)}`;

const toMeta = (r) => ({
  domain: r.domain, primary: r.primary_node, replica: r.replica_node || null,
  pending_replica: r.pending_replica || null, epoch: Number(r.epoch), state: r.state, note: r.note || null,
  updated_at: r.updated_at ? new Date(r.updated_at).getTime() : 0,
});
const isNewer = (a, b) => !b || a.epoch > b.epoch || (a.epoch === b.epoch && a.updated_at > b.updated_at);
const upNodes = () => NODE_KEYS.filter((n) => health[n].up);

function primaryNode(domain) { return roles[domain] ? roles[domain].primary : DOMAINS[domain].owner; }
function replicaNode(domain) { return roles[domain] ? roles[domain].replica : DOMAINS[domain].replica; }
function primaryPool(domain) {
  if (!rolesVerified) {
    const err = new Error('cluster roles are unverified (fewer than a majority of nodes reachable at last check); refusing to route writes');
    err.status = 503;
    throw err;
  }
  return pools[primaryNode(domain)];
}
async function isAlive(node) {
  try { await q(node, 'SELECT 1'); return true; } catch { return false; }
}

async function routedQuery(domain, { where = '', params = [] } = {}) {
  const table = DOMAINS[domain].table;
  const sql = `SELECT * FROM ${table}${where ? ' WHERE ' + where : ''}`;
  const p = primaryNode(domain);
  if (await isAlive(p)) {
    const result = await q(p, sql, params);
    return { source: 'primary', node: p, rows: result.rows };
  }
  const r = replicaNode(domain);
  if (r && (await isAlive(r))) {
    const result = await q(r, sql, params);
    return { source: 'replica', node: r, rows: result.rows };
  }
  throw new Error(`${domain} is unreachable and no in-service replica was found`);
}

const GUARD_FN = `
CREATE OR REPLACE FUNCTION distribuy_write_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE me TEXT; owner TEXT; ep BIGINT;
BEGIN
  SELECT node_key INTO me FROM cluster_self LIMIT 1;
  SELECT primary_node, epoch INTO owner, ep FROM cluster_meta WHERE domain = TG_ARGV[0];
  IF me IS NOT NULL AND owner IS NOT NULL AND owner <> me THEN
    RAISE EXCEPTION 'distribuy: node % is not the primary for % (primary=%, epoch=%): write rejected', me, TG_ARGV[0], owner, ep;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSIF TG_OP = 'TRUNCATE' THEN RETURN NULL; ELSE RETURN NEW; END IF;
END $fn$;`;

const TXN_LOG_DDL = `
CREATE TABLE IF NOT EXISTS txn_log (
  txn_id       TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('INITIATED','PREPARING','PREPARED','COMMITTED','ABORTED')),
  decision     TEXT CHECK (decision IN ('COMMIT','ABORT')),
  participants JSONB NOT NULL,
  payload      JSONB,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
)`;

async function ensureNodeSchema(node) {
  await q(node, 'CREATE TABLE IF NOT EXISTS cluster_self (node_key TEXT PRIMARY KEY)');
  await q(node, 'INSERT INTO cluster_self (node_key) VALUES ($1) ON CONFLICT DO NOTHING', [node]);
  await q(node, `CREATE TABLE IF NOT EXISTS cluster_meta (
    domain TEXT PRIMARY KEY, primary_node TEXT NOT NULL, replica_node TEXT, pending_replica TEXT,
    epoch BIGINT NOT NULL, state TEXT NOT NULL, note TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
  for (const d of DOMAIN_KEYS) {
    const m = roles[d] || { primary: DOMAINS[d].owner, replica: DOMAINS[d].replica, pending_replica: null, epoch: 1, state: 'normal', note: 'initial' };
    await q(node, `INSERT INTO cluster_meta (domain, primary_node, replica_node, pending_replica, epoch, state, note)
                   VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (domain) DO NOTHING`,
      [d, m.primary, m.replica, m.pending_replica, m.epoch, m.state, m.note]);
  }
  if (!(await q(node, "SELECT to_regclass('txn_log') AS t")).rows[0].t) await q(node, TXN_LOG_DDL);
  await q(node, GUARD_FN);
  for (const [table, domain] of GUARDED_TABLES) {
    const exists = (await q(node, 'SELECT to_regclass($1) AS t', [table])).rows[0].t;
    if (!exists) continue;
    const have = new Set((await q(node,
      `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [table])).rows.map((r) => r.tgname));
    const ddl = [];
    if (!have.has('distribuy_guard_row')) {
      ddl.push(`CREATE TRIGGER distribuy_guard_row BEFORE INSERT OR UPDATE OR DELETE ON ${table}
                FOR EACH ROW EXECUTE FUNCTION distribuy_write_guard(${lit(domain)})`);
    }
    if (!have.has('distribuy_guard_truncate')) {
      ddl.push(`CREATE TRIGGER distribuy_guard_truncate BEFORE TRUNCATE ON ${table}
                FOR EACH STATEMENT EXECUTE FUNCTION distribuy_write_guard(${lit(domain)})`);
    }
    for (const stmt of ddl) {
      const client = await pools[node].connect();
      try {
        await client.query("SET lock_timeout = '3s'");
        await client.query(stmt);
      } finally { client.release(true); }
    }
  }
}

async function ensureTxnLogReplication() {
  const r = roles.users;
  if (!r || r.state !== 'normal' || !r.replica || !health[r.primary].up || !health[r.replica].up) return;
  const inPub = await q(r.primary, "SELECT 1 FROM pg_publication_tables WHERE pubname = 'users_pub' AND tablename = 'txn_log'");
  if (inPub.rows.length === 0) {
    await q(r.primary, 'ALTER PUBLICATION users_pub ADD TABLE txn_log');
    logEvent('txn_log_published', { node: r.primary });
  }
  const hasSub = await q(r.replica, "SELECT 1 FROM pg_subscription WHERE subname = 'users_sub'");
  if (hasSub.rows.length) {
    const subbed = await q(r.replica, "SELECT 1 FROM pg_subscription_rel sr JOIN pg_subscription s ON s.oid = sr.srsubid WHERE s.subname = 'users_sub' AND sr.srrelid = 'txn_log'::regclass");
    if (subbed.rows.length === 0) {
      await q(r.replica, 'ALTER SUBSCRIPTION users_sub REFRESH PUBLICATION WITH (copy_data = true)');
      logEvent('txn_log_subscribed', { node: r.replica });
    }
  }
}

async function readMeta(node) {
  return (await q(node, 'SELECT * FROM cluster_meta')).rows.map(toMeta);
}

async function loadRoles() {
  const best = {};
  let reachable = 0;
  for (const node of NODE_KEYS) {
    try {
      for (const m of await readMeta(node)) {
        if (isNewer(m, best[m.domain])) best[m.domain] = m;
      }
      reachable++;
    } catch { }
  }
  for (const d of DOMAIN_KEYS) if (best[d]) roles[d] = best[d];
  const verified = reachable >= MAJORITY;
  if (verified !== rolesVerified) logEvent(verified ? 'roles_verified' : 'roles_unverified', { reachable });
  rolesVerified = verified;
}

async function pushMetaTo(node, m) {
  await q(node, `INSERT INTO cluster_meta (domain, primary_node, replica_node, pending_replica, epoch, state, note, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, now())
                 ON CONFLICT (domain) DO UPDATE SET primary_node = EXCLUDED.primary_node, replica_node = EXCLUDED.replica_node,
                   pending_replica = EXCLUDED.pending_replica, epoch = EXCLUDED.epoch, state = EXCLUDED.state,
                   note = EXCLUDED.note, updated_at = now()
                 WHERE cluster_meta.epoch <= EXCLUDED.epoch`,
    [m.domain, m.primary, m.replica, m.pending_replica, m.epoch, m.state, m.note]);
}

async function pushMeta(m) {
  let acked = 0;
  for (const node of NODE_KEYS) {
    try { await pushMetaTo(node, m); acked++; } catch { }
  }
  if (acked < MAJORITY) throw new Error(`role change for ${m.domain} reached only ${acked}/${NODE_KEYS.length} nodes (majority ${MAJORITY} required)`);
  roles[m.domain] = m;
  return acked;
}

const sameMeta = (a, b) => a.primary === b.primary && a.replica === b.replica &&
  a.pending_replica === b.pending_replica && a.epoch === b.epoch && a.state === b.state;

async function reconcileMeta() {
  for (const node of upNodes()) {
    try {
      const have = Object.fromEntries((await readMeta(node)).map((m) => [m.domain, m]));
      for (const d of DOMAIN_KEYS) {
        if (roles[d] && (!have[d] || !sameMeta(have[d], roles[d])) && (!have[d] || have[d].epoch <= roles[d].epoch)) {
          await pushMetaTo(node, roles[d]);
          if (have[d] && have[d].epoch < roles[d].epoch) {
            logEvent('node_fenced', { node, domain: d, stale_epoch: have[d].epoch, epoch: roles[d].epoch, stale_primary: have[d].primary, primary: roles[d].primary }, 'warn');
          }
        }
      }
    } catch (e) { logEvent('reconcile_failed', { node, error: e.message }, 'warn'); }
  }
}

async function probeNodes() {
  const results = await Promise.all(NODE_KEYS.map(async (node) => [node, await isAlive(node)]));
  const now = Date.now();
  for (const [node, ok] of results) {
    const h = health[node];
    if (ok) {
      const recovered = h.up === false;
      h.up = true; h.lastOk = now; h.upTicks = recovered ? 1 : h.upTicks + 1;
      if (recovered) {
        logEvent('node_recovered', { node, down_for_ms: h.downSince ? now - h.downSince : null });
        h.needsSchema = true;
      }
      h.misses = 0; h.downSince = null;
    } else {
      h.upTicks = 0;
      h.misses++;
      if (!h.downSince) h.downSince = now;
      if (h.misses === 1) logEvent('node_unreachable', { node }, 'warn');
      if (h.misses === FAILOVER_MISS_THRESHOLD) logEvent('node_declared_down', { node, misses: h.misses }, 'warn');
      if (h.misses >= 1) h.up = false;
    }
  }
}

async function sampleLag(domain) {
  const r = roles[domain];
  if (!r || !r.replica || !health[r.primary].up || !health[r.replica].up) return;
  try {
    const pri = await q(r.primary,
      `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn)::bigint AS bytes
         FROM pg_replication_slots s WHERE s.slot_name = $1`, [`${domain}_sub`]);
    const sub = await q(r.replica,
      `SELECT s.subenabled AS enabled,
              EXISTS (SELECT 1 FROM pg_stat_subscription ss WHERE ss.subname = s.subname AND ss.pid IS NOT NULL) AS worker
         FROM pg_subscription s WHERE s.subname = $1`, [`${domain}_sub`]);
    lag[domain] = {
      bytes: pri.rows.length ? Number(pri.rows[0].bytes) : null,
      slot_present: pri.rows.length > 0,
      subscription_present: sub.rows.length > 0,
      subscription_enabled: sub.rows.length ? sub.rows[0].enabled : false,
      worker_running: sub.rows.length ? sub.rows[0].worker : false,
      replica: r.replica, at: Date.now(),
    };
  } catch (e) { logEvent('lag_sample_failed', { domain, error: e.message }, 'warn'); }
}

function replicaIneligibility(domain) {
  const s = lag[domain];
  const reasons = [];
  if (!s) return ['no replication-lag sample was ever recorded'];
  const down = health[roles[domain].primary].downSince;
  if (s.replica !== roles[domain].replica) reasons.push('lag sample belongs to a different replica');
  if (down && down - s.at > 5 * HEALTH_INTERVAL_MS) reasons.push(`last lag sample is stale (${Math.round((down - s.at) / 1000)}s before the failure)`);
  if (!s.subscription_present) reasons.push('replica has no subscription');
  else if (!s.subscription_enabled) reasons.push('replica subscription is disabled');
  else if (!s.worker_running) reasons.push('replica apply worker was not running');
  if (!s.slot_present) reasons.push('replication slot is missing on the primary');
  else if (s.bytes === null || s.bytes > FAILOVER_MAX_LAG_BYTES) reasons.push(`replication lag ${s.bytes} bytes exceeds limit ${FAILOVER_MAX_LAG_BYTES}`);
  return reasons;
}

function block(domain, reason) {
  if (blocked[domain] !== reason) {
    blocked[domain] = reason;
    logEvent('failover_blocked', { domain, primary: roles[domain].primary, reason }, 'error');
  }
}

async function maybeFailover(domain) {
  const r = roles[domain];
  if (!r) return;
  const P = r.primary;
  if (health[P].up !== false || health[P].misses < FAILOVER_MISS_THRESHOLD) { delete blocked[domain]; return; }
  if (r.state === 'resyncing') return;
  const R = r.replica;
  if (!R) return block(domain, `primary ${P} is down and no replica is in service for ${domain}`);
  if (!health[R].up) return block(domain, `primary ${P} and replica ${R} are both unreachable`);
  if (upNodes().length < MAJORITY) return block(domain, 'a majority of nodes is not reachable; refusing to promote');
  if (!rolesVerified) return block(domain, 'cluster roles are unverified');
  const why = replicaIneligibility(domain);
  if (why.length) return block(domain, `replica ${R} is not eligible: ${why.join('; ')}`);

  const started = Date.now();
  const sample = lag[domain];
  logEvent('failover_started', { domain, from: P, to: R, lag_bytes: sample.bytes, epoch: r.epoch + 1 }, 'warn');
  try {
    await pushMeta({ domain, primary: R, replica: null, pending_replica: P, epoch: r.epoch + 1, state: 'degraded', note: `failover from ${P} at ${new Date().toISOString()}` });
    await finishPromotion(domain);
    delete blocked[domain];
    logEvent('failover_completed', { domain, from: P, to: R, epoch: roles[domain].epoch, lag_bytes_at_failure: sample.bytes, duration_ms: Date.now() - started }, 'warn');
  } catch (e) {
    logEvent('failover_failed', { domain, from: P, to: R, error: e.message }, 'error');
  }
}

async function finishPromotion(domain) {
  const r = roles[domain];
  const node = r.primary;
  const sub = `${domain}_sub`;
  const has = await q(node, 'SELECT 1 FROM pg_subscription WHERE subname = $1', [sub]);
  if (has.rows.length === 0) return;
  await q(node, `ALTER SUBSCRIPTION ${sub} DISABLE`);
  await q(node, `ALTER SUBSCRIPTION ${sub} SET (slot_name = NONE)`);
  await q(node, `DROP SUBSCRIPTION ${sub}`);
  const d = DOMAINS[domain];
  const seq = await q(node,
    `SELECT setval($1::regclass, GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${d.table}), (SELECT last_value FROM ${d.seq})) + $2) AS v`,
    [d.seq, SEQUENCE_GAP]);
  logEvent('promotion_finalized', { domain, node, sequence: d.seq, next_id_floor: Number(seq.rows[0].v) });
}

async function tableFingerprint(node, table, cols) {
  const expr = cols.map((c) => `COALESCE("${c}"::text, '')`).join(" || '|' || ");
  const r = await q(node, `SELECT count(*)::int AS n, COALESCE(md5(string_agg(${expr}, E'\\n' ORDER BY ${expr})), '') AS h FROM ${table}`);
  return r.rows[0];
}

async function compareDomainTables(domain, A, B, attempts) {
  const mismatches = [];
  for (const t of DOMAINS[domain].tables) {
    const cols = (await q(A, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, [t])).rows.map((x) => x.column_name);
    let ok = false, a, b;
    for (let i = 0; i < attempts && !ok; i++) {
      [a, b] = await Promise.all([tableFingerprint(A, t, cols), tableFingerprint(B, t, cols)]);
      ok = a.n === b.n && a.h === b.h;
      if (!ok && i < attempts - 1) await new Promise((res) => setTimeout(res, 1000));
    }
    if (!ok) mismatches.push(`${t}: ${A} ${a.n} rows/${a.h.slice(0, 8)} vs ${B} ${b.n} rows/${b.h.slice(0, 8)}`);
  }
  return mismatches;
}

async function waitForSync(node, sub) {
  const deadline = Date.now() + RESYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await q(node, `SELECT count(*)::int AS total, count(*) FILTER (WHERE srsubstate = 'r')::int AS ready
                               FROM pg_subscription_rel sr JOIN pg_subscription s ON s.oid = sr.srsubid WHERE s.subname = $1`, [sub]);
    if (r.rows[0].total > 0 && r.rows[0].total === r.rows[0].ready) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`initial table sync did not finish within ${RESYNC_TIMEOUT_MS}ms`);
}

async function resync(domain) {
  const r = roles[domain];
  const O = r.pending_replica;
  const R = r.primary;
  const d = DOMAINS[domain];
  const sub = `${domain}_sub`;
  const pub = `${domain}_pub`;
  const started = Date.now();
  logEvent('resync_started', { domain, node: O, from_primary: R, epoch: r.epoch }, 'warn');
  try {
    const oMeta = (await readMeta(O)).find((m) => m.domain === domain);
    if (!oMeta || oMeta.epoch !== r.epoch || oMeta.primary !== R) throw new Error(`node ${O} is not fenced at epoch ${r.epoch} yet`);
    await pushMeta({ ...r, state: 'resyncing' });

    const subExists = (await q(O, 'SELECT 1 FROM pg_subscription WHERE subname = $1', [sub])).rows.length > 0;
    const archives = [];
    if (!subExists) {
      await q(O, `DROP PUBLICATION IF EXISTS ${pub}`);
      await q(O, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1 AND NOT active`, [sub]);
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      const client = await pools[O].connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role = replica");
        for (const t of d.tables) {
          const n = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
          if (n > 0) {
            const arch = `${t}_divergent_${stamp}`;
            await client.query(`CREATE TABLE ${arch} AS TABLE ${t}`);
            archives.push({ table: arch, rows: n });
          }
          await client.query(`TRUNCATE ${t}`);
        }
        await client.query('COMMIT');
      } catch (e) { try { await client.query('ROLLBACK'); } catch { } throw e; }
      finally { client.release(); }
      await q(R, `DROP PUBLICATION IF EXISTS ${pub}`);
      await q(R, `CREATE PUBLICATION ${pub} FOR TABLE ${d.tables.join(', ')}`);
      await q(O, `CREATE SUBSCRIPTION ${sub} CONNECTION ${lit(connString(R))} PUBLICATION ${pub} WITH (copy_data = true)`);
    }
    await waitForSync(O, sub);

    const mismatches = await compareDomainTables(domain, R, O, 6);
    if (mismatches.length) throw new Error(`consistency check failed: ${mismatches.join('; ')}`);

    await pushMeta({ ...roles[domain], replica: O, pending_replica: null, state: 'normal', note: `resynced ${O} at ${new Date().toISOString()}` });
    logEvent('resync_completed', { domain, node: O, primary: R, archives, duration_ms: Date.now() - started }, 'warn');
  } catch (e) {
    try { await pushMeta({ ...roles[domain], state: 'quarantined', note: `resync failed: ${e.message}` }); } catch { }
    logEvent('resync_failed', { domain, node: O, error: e.message }, 'error');
  }
}

function maybeResync(domain) {
  const r = roles[domain];
  if (!r || !r.pending_replica || resyncing[domain]) return;
  if (r.state !== 'degraded' && r.state !== 'resyncing') return;
  const O = r.pending_replica;
  if (!health[O].up || health[O].upTicks < 2 || !health[r.primary].up) return;
  resyncing[domain] = true;
  resync(domain).finally(() => { resyncing[domain] = false; });
}

async function switchover(domain) {
  const r = roles[domain];
  if (!r) throw new Error(`unknown domain ${domain}`);
  if (!rolesVerified) throw new Error('cluster roles are unverified');
  if (r.state !== 'normal' || !r.replica || r.pending_replica) throw new Error(`${domain} must be in state normal with an in-service replica (is ${r.state})`);
  if (resyncing[domain]) throw new Error('a resync is in progress');
  const P = r.primary, T = r.replica;
  if (!health[P].up || !health[T].up) throw new Error('both nodes must be up');
  for (const node of [P, T]) {
    const prep = await q(node, "SELECT count(*)::int AS n FROM pg_prepared_xacts");
    if (prep.rows[0].n > 0) throw new Error(`node ${node} has in-doubt prepared transactions; resolve them before switching over`);
  }
  const started = Date.now();
  if (switching[domain]) throw new Error('a switchover is already running');
  switching[domain] = true;
  try {
  logEvent('switchover_started', { domain, from: P, to: T, epoch: r.epoch + 1 }, 'warn');
  const fenced = { domain, primary: T, replica: null, pending_replica: P, epoch: r.epoch + 1, state: 'switching', note: `planned switchover from ${P} at ${new Date().toISOString()}` };
  await pushMeta(fenced);
  const mismatches = await compareDomainTables(domain, P, T, 20);
  if (mismatches.length) {
    await pushMeta({ domain, primary: P, replica: T, pending_replica: null, epoch: r.epoch + 2, state: 'normal', note: `switchover aborted: ${mismatches.join('; ')}` });
    logEvent('switchover_aborted', { domain, reason: mismatches }, 'error');
    throw new Error(`switchover aborted, copies did not converge: ${mismatches.join('; ')}`);
  }
  await pushMeta({ ...fenced, state: 'degraded', note: `${fenced.note}; target verified identical` });
  await finishPromotion(domain);
  logEvent('switchover_completed', { domain, from: P, to: T, epoch: roles[domain].epoch, duration_ms: Date.now() - started }, 'warn');
  return { ok: true, primary: T, resync_of: P };
  } finally { switching[domain] = false; }
}

async function resolveStuckSwitchover(domain) {
  const r = roles[domain];
  const P = r.pending_replica, T = r.primary;
  if (!health[P].up || !health[T].up) return;
  const mismatches = await compareDomainTables(domain, P, T, 3);
  if (mismatches.length === 0) {
    await pushMeta({ ...r, state: 'degraded', note: `${r.note}; completed after interruption` });
    logEvent('switchover_resumed', { domain, to: T }, 'warn');
  } else {
    await pushMeta({ domain, primary: P, replica: T, pending_replica: null, epoch: r.epoch + 1, state: 'normal', note: `interrupted switchover reverted: ${mismatches.join('; ')}` });
    logEvent('switchover_reverted', { domain, reason: mismatches }, 'error');
  }
}

async function retryResync(domain) {
  const r = roles[domain];
  if (!r || !r.pending_replica) throw new Error(`nothing to resync for ${domain}`);
  await pushMeta({ ...r, state: 'degraded', note: 'operator requested resync retry' });
  return { ok: true };
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await probeNodes();
    for (const node of NODE_KEYS) {
      if (health[node].up && health[node].needsSchema) {
        try { await ensureNodeSchema(node); health[node].needsSchema = false; }
        catch (e) { logEvent('schema_init_failed', { node, error: e.message }, 'warn'); }
      }
    }
    await loadRolesIfNeeded();
    for (const d of DOMAIN_KEYS) await sampleLag(d);
    await reconcileMeta();
    for (const d of DOMAIN_KEYS) {
      if (roles[d] && health[roles[d].primary].up) {
        try { await finishPromotion(d); } catch (e) { logEvent('promotion_finalize_failed', { domain: d, error: e.message }, 'error'); }
      }
    }
    for (const d of DOMAIN_KEYS) {
      if (roles[d] && roles[d].state === 'switching' && !switching[d]) {
        try { await resolveStuckSwitchover(d); } catch (e) { logEvent('switchover_resolve_failed', { domain: d, error: e.message }, 'error'); }
      }
    }
    for (const d of DOMAIN_KEYS) await maybeFailover(d);
    for (const d of DOMAIN_KEYS) maybeResync(d);
    try { await ensureTxnLogReplication(); } catch (e) { logEvent('txn_log_replication_failed', { error: e.message }, 'warn'); }
    if (tickHook) { try { await tickHook(); } catch (e) { logEvent('tick_hook_failed', { error: e.message }, 'error'); } }
  } catch (e) {
    logEvent('tick_failed', { error: e.message }, 'error');
  } finally { ticking = false; }
}

async function loadRolesIfNeeded() {
  if (upNodes().length >= MAJORITY) {
    const before = JSON.stringify(summarizeRoles());
    await loadRoles();
    if (before !== JSON.stringify(summarizeRoles())) logEvent('roles_changed', { roles: summarizeRoles() });
  } else if (rolesVerified) {
    rolesVerified = false;
    logEvent('roles_unverified', { reachable: upNodes().length }, 'warn');
  }
}

function summarizeRoles() {
  return Object.fromEntries(DOMAIN_KEYS.map((d) => [d, roles[d] ? {
    primary: roles[d].primary, replica: roles[d].replica, pending_replica: roles[d].pending_replica,
    epoch: roles[d].epoch, state: roles[d].state,
  } : null]));
}

async function start() {
  await probeNodes();
  for (const node of NODE_KEYS) {
    if (!health[node].up) continue;
    try { await ensureNodeSchema(node); } catch (e) { logEvent('schema_init_failed', { node, error: e.message }, 'error'); }
  }
  await loadRoles();
  logEvent('cluster_started', { roles: summarizeRoles(), roles_verified: rolesVerified, health: Object.fromEntries(NODE_KEYS.map((n) => [n, health[n].up])) });
  setInterval(tick, HEALTH_INTERVAL_MS).unref();
}

function status() {
  const nodes = {};
  for (const n of NODE_KEYS) {
    nodes[n] = {
      port: NODES[n].port, up: health[n].up, consecutive_misses: health[n].misses,
      down_since: health[n].downSince ? new Date(health[n].downSince).toISOString() : null,
      primary_of: DOMAIN_KEYS.filter((d) => roles[d] && roles[d].primary === n),
      replica_of: DOMAIN_KEYS.filter((d) => roles[d] && roles[d].replica === n),
      out_of_service_for: DOMAIN_KEYS.filter((d) => roles[d] && roles[d].pending_replica === n),
    };
  }
  const domains = {};
  for (const d of DOMAIN_KEYS) {
    const s = lag[d];
    domains[d] = {
      ...(roles[d] || {}),
      lag: s ? { bytes: s.bytes, subscription_enabled: s.subscription_enabled, worker_running: s.worker_running, sampled_at: new Date(s.at).toISOString() } : null,
      failover_blocked_reason: blocked[d] || null,
      resync_in_progress: !!resyncing[d],
    };
  }
  return {
    roles_verified: rolesVerified, majority_required: MAJORITY,
    settings: { health_interval_ms: HEALTH_INTERVAL_MS, miss_threshold: FAILOVER_MISS_THRESHOLD, max_lag_bytes: FAILOVER_MAX_LAG_BYTES },
    nodes, domains, events: recentEvents.slice(-50),
  };
}

module.exports = {
  NODES, NODE_KEYS, DOMAINS, DOMAIN_KEYS, pools, q,
  primaryNode, replicaNode, primaryPool, isAlive, routedQuery,
  start, status, tick, retryResync, switchover, logEvent,
  setTickHook: (fn) => { tickHook = fn; },
  isHealthy: (node) => health[node].up === true,
};
