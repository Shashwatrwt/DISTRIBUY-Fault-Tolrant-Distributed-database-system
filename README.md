# OS + DBMS Project: Distributed, Fault-Tolerant PostgreSQL E-Commerce System

A distributed, fault-tolerant e-commerce system using PostgreSQL as the storage engine for each node. The partitioning, Coordinator, replication orchestration, distributed transactions, failure detection, and recovery logic are built by this project.

## Current Status

The project is functionally complete against its MVP: a working distributed, fault-tolerant e-commerce backend with a customer storefront and an admin dashboard, verified live against a real 3-node PostgreSQL cluster.

**Distributed database layer**

- **3 independent PostgreSQL clusters** (node1/5433 Users, node2/5434 Products, node3/5435 Orders), each owning one business domain's table.
- **Coordinator** (`core/src/coordinator.cpp`, C++ / `libpqxx`): routes requests by domain, reports quorum-based cluster health, runs **real Two-Phase Commit** (`PREPARE TRANSACTION` / `COMMIT PREPARED` / `ROLLBACK PREPARED`) for orders across the Orders and Products nodes (commit and abort paths both verified), **fails reads over to the replica node** when a primary is unreachable, and does **continuous heartbeat monitoring** (`--watch`) that detects both failure and recovery without a restart.
- **PostgreSQL logical replication ring** (Users to node2, Products to node3, Orders to node1), set up by `scripts/setup_replication.sh`.
- **Per-node process** (`core/src/main.cpp`): connects to its own node's database via `libpqxx`.

**Application layer**

- **REST API** (`api/server.js`, Node.js/Express): the same routing, failover and 2PC logic over HTTP, plus real authentication (consumer sign-up/login with bcrypt-hashed passwords, a separate admin login, token sessions) and server-side authorization. Consumers can only read their own orders; admin-only routes are enforced on the server, not just hidden in the UI.
- **Storefront** (`frontend/`): login page (Consumer / Admin), product search, cart, checkout with a delivery address (Cash on Delivery), and a "My Orders" view with live status (placed / shipped / delivered / cancelled).
- **Admin dashboard**: Overview (stats, including an order-value total computed by joining Orders and Products across two nodes, plus live cluster health), and Products / Orders / Users management (add, edit and delete products; update order status; delete users).

Not built, by design: see **Known limitations** and the stretch goals below.

## The core problem you're solving

A normal e-commerce app looks like this:

```text
Users → One Server → One Database(cannot handle when the users becomes large)
```

This works for a college demo with 10 users, but it has one fatal flaw: if that database crashes, the entire website goes down. This is a single point of failure.

The answer is to split data across multiple independent PostgreSQL-backed nodes and make copies of important data so if one node dies, another can immediately take over.

## The two layers of the system

### 1. Application Layer

This is what users see and use:

- browse products, search, and filter
- add to cart and checkout
- login and register
- view order history
- admin dashboard to manage products, orders, and system health

### 2. Distributed Database Layer

This is the actual engineering core of the project:

- multiple PostgreSQL-backed nodes running independently
- data split across nodes
- copies of data for safety
- a coordinator routing every request to the correct place
- transaction handling so operations do not leave data half-broken
- automatic detection of dead nodes and recovery when they return

## Core concepts

### Nodes

A node is an independent process with its own PostgreSQL database that owns a slice of data. In the finalized design, each node owns a full business domain, not a numeric key range:

| Node | Owns |
|---|---|
| Node 1 | Users |
| Node 2 | Products & Inventory |
| Node 3 | Orders & Payments |

The prototype models these nodes with localhost endpoints on ports 5433, 5434, and 5435, matching the PostgreSQL clusters for node 1, node 2, and node 3 running locally.

### Partitioning

Instead of one giant table spanning one machine, each table lives on one node. This spreads storage and request load, and a problemin one domain does not bring down the entire system.

### Replication

Partitioning alone is risky. If one node fails, data becomes unreachable. PostgreSQL logical replication copies each node's data toanother node in a ring:

```text
Node 1 (Users) → replicated to → Node 2
Node 2 (Products) → replicated to → Node 3
Node 3 (Orders) → replicated to → Node 1
```

If Node 2 fails, Node 3 already has a copy of Products data and can take over.

### Query Coordinator

The frontend and application layer never talk directly to nodes. They talk only to the Coordinator.

The coordinator:

- knows which node owns which data
- routes requests to the right node
- runs distributed transactions across multiple nodes
- sends heartbeat checks
- triggers failover when a node dies

This hides the complexity from the application layer, and is now implemented in `core/src/coordinator.cpp` (routing, failover, 2PC, heartbeat monitoring) and mirrored in `api/server.js` for HTTP access.

## Concurrency control

A key issue is the last-item-in-stock problem.

Without protection:

```text
Both read stock = 1
Both think it is available
Both buy
Stock becomes -1
```

The solution is Two-Phase Locking (2PL): whoever touches the row first acquires a lock; others wait until it is released.

## Transactions

Placing an order is not one operation. It is multiple steps, such as:

- create order
- reduce stock
- process payment

These must succeed together or fail together. The implementation uses BEGIN → ... → COMMIT and ROLLBACK when necessary.

## Distributed transactions and 2PC

Because an order may span multiple nodes, a single purchase can involve multiple nodes. Two-Phase Commit (2PC) ensures both nodes agree before finalization:

### Phase 1: Prepare

The coordinator asks each node if it is ready to commit.

### Phase 2: Commit or Abort

If all say yes, the coordinator tells them to commit. If any says no, everyone rolls back.

This prevents half-finished updates.

## Failure detection, failover, and recovery

- **Detection:** the API's monitor probes every node each second (configurable) and declares a node down after 3 consecutive misses. The C++ Coordinator's heartbeat (`--watch`) observes the same nodes.
- **Automatic promotion:** if a primary is down and its replica is eligible, the replica is promoted and routing switches to it, for reads *and* writes.
- **Fencing / split-brain prevention:** every role change is recorded with a higher *epoch* on a majority (2 of 3) of nodes, and a write-guard trigger on every table rejects writes on any node that is not the primary for that data.
- **Recovery:** a returning old primary is fenced, never auto-promoted, its data is archived and overwritten from the current primary, verified, and it rejoins as a replica.
- **Distributed transactions:** every order is recorded in a durable `txn_log`; after a crash, recovery follows the logged decision.

Details, setup and tests: see **Automatic failover and recovery** below.

## OS concepts reflected in the project

| OS topic | Where it appears |
|---|---|
| Processes | each node, coordinator, and API server is a separate process |
| Threads / concurrency | concurrent requests are handled by the API's async event loop and by PostgreSQL's per-connection backend processes; the C++ Coordinator itself is single-threaded |
| Synchronization | PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) prevent race conditions such as overselling the last item |
| IPC | nodes and coordinator communicate via TCP sockets |
| Deadlock | could arise when transactions wait for locks |
| File management | each PostgreSQL node persists tables and WAL in its own data directory |

## Tech stack

- C++ (Coordinator, per-node process), using `libpqxx` for PostgreSQL connections
- TCP sockets (both the Postgres wire protocol used by `libpqxx`, and PostgreSQL's own logical replication traffic between nodes)
- PostgreSQL (per-node storage, 2PC, row-level locking, logical replication)
- Node.js/Express + the `pg` driver (REST API)
- React, loaded via CDN as a single static HTML file, no build tooling (frontend)

## Why this project is valuable

This project touches the same skills backend and infrastructure interviews test:

- distributed systems
- concurrency
- networking
- transaction management
- fault tolerance
- failover design

## MVP and Stretch Goals

### MVP

The core MVP is:

- 3 PostgreSQL-backed nodes: Users, Products & Inventory, and Orders & Payments
- Coordinator
- TCP communication
- partitioning by business domain
- ring replication using PostgreSQL logical replication
- distributed transactions using PostgreSQL 2PC
- concurrency control using PostgreSQL locking, understood through 2PL
- heartbeat-based failure detection and failover
- recovery and reintegration of restarted nodes

### Stretch Goals

These are intentionally deferred until the MVP is complete and should be implemented only if time permits:

- automatic leader election
- dynamic sharding
- multi-machine deployment

## Scope Boundaries

Complex recovery optimizations remain optional and can be considered after the MVP and stretch goals.

## Repository structure

```text
Distribuy/
├── README.md
├── core/
│   └── src/
│       ├── main.cpp          # per-node process (libpqxx connection to its own DB)
│       ├── coordinator.cpp   # Coordinator: routing, failover, 2PC, heartbeat monitoring
│       └── cluster.h         # shared topology / replica-map definitions
├── api/
│   ├── server.js             # Express REST API: auth, routes, admin/cluster endpoints
│   ├── cluster.js            # roles/epochs, health monitor, failover, fencing, resync, switchover
│   ├── txlog.js              # durable 2PC log, order placement, crash recovery
│   └── package.json
├── frontend/
│   ├── index.html            # shell; loads the files below
│   ├── css/styles.css
│   └── js/                   # api.js, auth.js, components.js, app.js (React via CDN, no build step)
├── scripts/
│   ├── setup_replication.sh  # first-time setup of the logical replication ring
│   ├── reset_catalog.sh      # replaces ALL products with 22 sample items
│   └── tests/                # failure-scenario tests (2PC recovery, failover, split-brain, consistency)
└── .gitignore
```

## Current local build and run

Everything runs on WSL2/Ubuntu against three local PostgreSQL clusters on ports 5433, 5434 and 5435.

### Prerequisites (one-time)

- Packages: `postgresql`, `build-essential`, `libpqxx-dev`, `nodejs`, `npm`, `python3`.
- Three clusters (for example `sudo pg_createcluster 18 node1 -p 5433`, then node2 on 5434 and node3 on 5435), each with `wal_level = logical` and `max_prepared_transactions` greater than 0 in its `postgresql.conf`, then restarted.
- Each node's `postgres` password is supplied via the `PG_PASSWORD` environment variable; it is no longer hardcoded.
- The base tables, one per node:

```sql
-- node1 (5433)
CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(), password TEXT);
-- node2 (5434)
CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL,
                       stock INT NOT NULL DEFAULT 0);
-- node3 (5435)
CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT NOT NULL, product_id INT NOT NULL,
                     quantity INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                     created_at TIMESTAMP DEFAULT NOW(), delivery_address TEXT,
                     payment_method TEXT DEFAULT 'COD');
```

- The replication ring: run `scripts/setup_replication.sh` once, for first-time setup only. It drops and recreates every publication and subscription, so do not re-run it on a cluster whose replication is already healthy (the script's header explains this).

### Run

**1. Coordinator** (C++): one-shot demo, or continuous monitoring.

```bash
g++ -Wall -Wextra core/src/coordinator.cpp -o core/src/coordinator -lpqxx -lpq
./core/src/coordinator           # health check, routed queries, a 2PC order demo
./core/src/coordinator --watch   # continuous heartbeat monitoring (Ctrl+C to stop)
```

**2. REST API** (http://localhost:4000):

```bash
cd api && npm install && node server.js
```

**3. Frontend** (http://localhost:8080). The page loads separate JS/CSS files, so it must be served over HTTP; opening `index.html` directly from disk will not work.

```bash
cd frontend && python3 -m http.server 8080
```

After changing a frontend file, hard-refresh the browser (Ctrl+Shift+R), otherwise it may keep showing the cached old version.

**4. Sample catalog** (optional): `./scripts/reset_catalog.sh` replaces all products with 22 sample items. It truncates the `products` table first.

**Accounts:** the admin login uses `ADMIN_USERNAME` / `ADMIN_PASSWORD` from your `.env`. Consumers create their own account with **Sign Up**. Start the API with `cd api && npm start` (reads `../.env`).

### Failover demo

With the API and frontend running, log in as admin and open **Overview**, then in a terminal:

```bash
sudo pg_ctlcluster 18 node2 stop     # kill the Products node
```

Within a few seconds the Products node shows **DOWN**, while the cluster stays **AVAILABLE** (2 of 3 nodes, quorum 2). The storefront still lists products, now served from node3's replicated copy (the admin tables are tagged "served from replica"), but checkout is refused, because 2PC needs the Products primary. Then:

```bash
sudo pg_ctlcluster 18 node2 start    # bring it back
```

Health returns to all UP and normal routing resumes. `./core/src/coordinator --watch` prints the same DOWN and RECOVERED transitions in the terminal.

## Automatic failover and recovery

### Why this is not "pg_promote()"
Replication here is PostgreSQL **logical** replication (one publication/subscription per table). A logical subscriber is an ordinary writable table, not a physical standby, so there is nothing to `pg_promote()`. Three consequences drove the design:

1. **Promotion is our own protocol:** drop the replica's subscription, repair sequences (logical replication does not replicate them: the replica's `products_id_seq` was still at 1 with 22 rows, so the first insert would have collided), flip the role.
2. **Lag is unknowable once the primary is dead,** so the monitor records replication lag *while the primary is alive*; promotion requires a fresh-enough sample showing an enabled, running subscription and lag within `FAILOVER_MAX_LAG_BYTES`.
3. **Nothing stopped a second writer,** so we added epoch-based fencing (below).

Existing replication (the ring, `setup_replication.sh`) is unchanged; the new layer sits on top of it.

### Architecture

```text
                 +--------------------+            +--------------------------+
 Browser ------> |  REST API (Node)   |            |  C++ Coordinator         |
 (React)         |  - routes by role  |            |  - OBSERVES roles/health |
                 |  - failover manager|            |  - role-aware routing    |
                 |  - 2PC + txn_log   |            |  - logged 2PC + recovery |
                 +----+----+----+-----+            +------------+-------------+
                      |    |    |   cluster_meta (roles+epoch) |
          +-----------+    |    +-----------+  written to a MAJORITY of nodes
          v                v                v
   +-------------+  +-------------+  +-------------+
   | node1 :5433 |  | node2 :5434 |  | node3 :5435 |   each: cluster_self, cluster_meta,
   | users  (P)  |  | products(P) |  | orders (P)  |   write-guard triggers, txn_log (users domain)
   | orders copy |  | users copy  |  | products cp |
   +------+------+  +------+------+  +------+------+
          ^   logical replication ring (async)  |
          +--------------------<-----------------+
   P = primary for that data.  After a failover the replica's copy becomes P and the
   old primary returns as a replica (subscribing to the new primary).
```

**Roles and epochs.** `cluster_meta(domain, primary_node, replica_node, pending_replica, epoch, state)` exists on every node. The highest epoch wins; a role change only counts when a majority acknowledged it, so an API that can see only one node can never promote anything (`roles_verified` goes false and writes answer 503).

**Write guard.** A `BEFORE INSERT/UPDATE/DELETE/TRUNCATE` trigger on every domain table raises `node X is not the primary for Y` unless the node is the primary per its own `cluster_meta`. The logical-replication apply worker bypasses ordinary triggers, so replicas stay in sync but reject direct writes.

**Domain states:** `normal` -> (primary down) -> `degraded` (promoted, no replica yet) -> `resyncing` -> `normal`; `quarantined` if resync verification fails (node stays out of service; `POST /cluster/resync/:domain` retries); `switching` during a planned switchover.

**Failover steps** (`api/cluster.js`): confirm N misses -> majority reachable -> replica eligible (subscription enabled + worker running + recorded lag within limit + fresh sample) -> **fence** (new epoch on a majority) -> promote (drop subscription, fix sequences) -> routing updated -> event logged. Anything not satisfied produces a `failover_blocked` event with the reason and **no promotion**.

**Resync of a returning node:** detect recovery -> fence it (overwrite its stale "I am primary" row) -> archive its current rows to `<table>_divergent_<timestamp>` (so unreplicated writes are never silently destroyed) -> clear its old publication/slot -> truncate -> `CREATE SUBSCRIPTION ... copy_data = true` from the new primary -> wait for sync -> verify row counts and a content hash -> rejoin as replica. **There is no automatic failback.** The archive is a full snapshot of the returned node's table; diff it against the current primary to find writes that never replicated, then `DROP TABLE` it.

**Planned switchover** (`POST /cluster/switchover/:domain`, admin): fence the current primary first, wait until both copies are identical, promote the target, resync the old primary. Aborts and reverts if the copies do not converge. Run it at low traffic.

**Distributed transaction log** (`api/txlog.js`, table `txn_log`, lives with the Users data and is replicated with it):

| State | Meaning |
|---|---|
| INITIATED | row written (participants + global ids) before any participant is touched |
| PREPARING / PREPARED | phase 1 in progress / every participant prepared |
| decision `COMMIT`/`ABORT` | written durably **before** any phase-2 message |
| COMMITTED / ABORTED | terminal |

Recovery (at startup and every few seconds): decision `COMMIT` -> `COMMIT PREPARED` wherever still prepared; decision `ABORT` -> `ROLLBACK PREPARED`; **no decision** -> the coordinator died before deciding, no client was ever acknowledged, so ABORT is logged first and then applied; an unreachable participant leaves the transaction in doubt and is retried (nothing is assumed). Prepared transactions with no log row are only reported (`orphan_prepared`), never touched. The log lives on a non-participant, so it stays readable while Orders or Products is down; if the Users primary is down, new orders are refused rather than run without a log.

### Monitoring
- `GET /health` (public): per-node UP/DOWN plus which data each node is primary/replica for. The admin **Cluster Health** panel shows it.
- `GET /cluster/status` (admin): roles, epochs, states, lag, blocked-failover reasons, in-doubt transactions, orphan prepared transactions, last 50 events.
- Structured JSON events on stdout and in `api/logs/cluster-events.jsonl`: `node_declared_down`, `failover_started/completed/blocked`, `node_fenced`, `resync_started/completed/failed`, `2pc_recovery_*`, ...
- `./core/src/coordinator --watch` prints role changes (`[ROLES]`) and recovers in-doubt transactions.

### Configuration (environment, see `.env`)
`PG_USER`, `PG_PASSWORD`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (required), `HEALTH_INTERVAL_MS` (2000), `FAILOVER_MISS_THRESHOLD` (3), `FAILOVER_MAX_LAG_BYTES` (1048576), `SEQUENCE_GAP` (100), `RESYNC_TIMEOUT_MS` (60000), `RECOVERY_GRACE_MS` (5000), `CLUSTER_EVENT_LOG`. The C++ binaries read `PG_USER` / `PG_PASSWORD` from the shell: `set -a; source .env; set +a`.

### Database changes (all additive, applied automatically on API start)
On every node: tables `cluster_self`, `cluster_meta`, `txn_log`; function `distribuy_write_guard()`; triggers `distribuy_guard_row` / `distribuy_guard_truncate` on `users`, `products`, `orders`, `txn_log`. `txn_log` is added to `users_pub` and the Users subscription. `orders.unit_price` records the price at purchase. The older `txn_decisions` table on node3 is no longer used and can be dropped.

### Demonstrating it
Run the API (`cd api && npm start`) and the frontend, open **Overview**, then:

```bash
sudo pg_ctlcluster 18 node2 stop     # Products primary dies
```
Within about 6 seconds the API promotes node3 (watch the Cluster Health panel, or `GET /cluster/status` with an admin token): product reads *and writes* and checkout keep working. Then:

```bash
sudo pg_ctlcluster 18 node2 start    # old primary returns
```
It is fenced, resynced and shown as a replica; direct writes to it are rejected. To move Products back to node2: `POST /cluster/switchover/products` (admin token).

### Automated tests (`scripts/tests/`)
```bash
./scripts/tests/test_api_smoke.sh        # auth, authorization, validation, order flow, rate limiting      (57 checks)
./scripts/tests/test_2pc_recovery.sh     # Node API: coordinator crash at 4 protocol points + participant failure (41)
./scripts/tests/test_cpp_coordinator.sh  # C++ coordinator: commit, abort, 4 crash points, recovery grace period   (38)
./scripts/tests/test_failover.sh         # Tests 5, 1, 2, 6, 7 and a planned switchover                            (63)
./scripts/tests/measure_failover.sh      # failover timing under continuous traffic, latency, lost-write check
./scripts/divergence_report.sh           # read-only: rows that exist ONLY in a *_divergent_* archive (replay candidates)
NODE_CTL=pg_ctlcluster ./scripts/tests/test_failover.sh   # same failover suite with REAL node stop/start (prints the sudo commands)
```
Each script creates throwaway data and removes it (`KEEP=1` keeps it), starts its own API on its own port (4011-4014), and is role-aware where it matters. Stop other API instances first: a second instance on port 4000 now exits instead of running a competing failover monitor.

**Measured** (simulated outage, monitor interval 1 s x 3 misses): promotion about 2.5 s after the failure; clients saw about 2.4 s of write unavailability and no read failures (reads fall back to the replica copy); no acknowledged write lost; cross-node 2PC order latency p50 6 ms / p95 9 ms on a local machine. With the default 2 s interval expect roughly 6 s. A hung (not refused) connection takes longer to detect because of the 8 s query timeout.

**Real stop/start:** one real `pg_ctlcluster` stop/start of node2 was exercised by hand during development (failure detected, node3 promoted, an order placed through the storefront during the outage succeeded, node2 fenced and resynced). The full automated suite has only been run in simulated mode.

## Development roadmap

1. ✅ define node and cluster topology
2. ✅ implement sharding model (domain-based partitioning: each table lives on exactly one primary node)
3. ✅ connect the Coordinator to PostgreSQL-backed nodes (via `libpqxx`, over TCP)
4. ✅ add ring replication and replication-status monitoring
5. ✅ add distributed transactions with PostgreSQL 2PC
6. ✅ add concurrency control (Postgres row-level locking, `FOR UPDATE`), failure detection, failover, and recovery
7. ✅ build the REST API (with authentication and role-based authorization)
8. ✅ build the frontend: storefront (search, cart, checkout, order tracking) and admin dashboard
9. optional, only if time permits: the stretch goals above

## Known limitations

- **Authentication is deliberately basic.** Real server-side checks exist (bcrypt-hashed passwords, admin-only routes enforced by the API, consumers limited to their own orders, `GET /users` admin-only and free of password hashes). But sessions are random tokens held in the API process's memory, so they are lost when the API restarts; tokens are kept in the browser's `localStorage`; credentials come from `.env` (never hardcoded); sessions now expire after 8 hours and login endpoints are rate limited, but there is no HTTPS, password-strength rule or password reset.
- **The API (failover manager) is a single instance.** Failover decisions are made by one process; running two would let them race. If it is down, nodes are not promoted and in-doubt transactions wait (they are resolved on its next start). There is no leader election for the coordinator itself.
- **Replication is asynchronous, so failover can lose data.** A write acknowledged by the old primary but not yet replicated when it died is not on the promoted replica. Promotion is gated on recorded lag, and such rows survive in the `*_divergent_*` archive on the returned node, but they are not merged back automatically. Synchronous replication would remove this at the cost of availability when a replica is down; it is not implemented.
- **Pre-fencing window.** A returning old primary still believes it is primary until the monitor (about one tick) overwrites its role row. A client writing *directly* to it in that window is accepted (observed in the tests); the data is archived at resync, never silently lost. All application writes go through the API, which routes by role, so they are unaffected.
- **No replica while degraded.** After a failover the promoted node has no replica until the old primary is resynced; a second failure in that window loses that data. Node3 also carries two primaries (Orders + Products) until you switch back.
- **Tested outage mode.** The automated failover suite simulated outages with `ALLOW_CONNECTIONS false` plus session termination (the process kept running, so PostgreSQL's own crash recovery was not exercised). The same suite runs against real stop/start with `NODE_CTL=pg_ctlcluster`; that full run is still to be done.
- **Not covered:** simultaneous failure of two nodes (no majority, so by design nothing is promoted), partitions where the API reaches only some nodes, and multiple API instances. A simultaneous outage of the primary and its replica is covered (nothing is promoted, the problem is reported), but a three-way network partition is not.
- **Replica schemas are maintained by hand.** Logical replication copies data, not schema changes. If a column is added to a primary table, add it to the replica table with `ALTER TABLE`; re-running `setup_replication.sh` does not fix a mismatch and would tear down healthy replication.
- **No cross-node referential integrity.** `orders.user_id` and `orders.product_id` are not foreign keys because PostgreSQL cannot enforce foreign-key constraints across separate database instances. As a result, deleting a user or product can leave historical orders pointing to an ID that no longer exists.
- **Scope of testing.** Built and verified as a single-machine demo with three PostgreSQL instances; it has not been load-tested or run across multiple machines.
- **Storefront cosmetics.** The crossed-out "original price" and "12% off" are computed from the real price for display only; there is no discount logic. The cart lives in the browser and is lost on refresh. Payment is Cash on Delivery only.

## License

No license has been selected yet.

## Contributing

Contributions are welcome as the project grows. For now, the work is focused on learning by building the system incrementally and validating each step with small code changes.
