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

- detection: the coordinator pings nodes using heartbeats
- failover: traffic is redirected to the replica of a failed node
- recovery: PostgreSQL replays its WAL when a node restarts and logical replication catches it up on its own; the Coordinator's heartbeat notices the node answering again and resumes routing to it (it does not itself measure replication lag)

This complete lifecycle has been demonstrated live: killing node2's PostgreSQL cluster mid-session causes the Coordinator's heartbeat loop to detect it within seconds, reads automatically fail over to node3 (which holds the replicated Products data), writes correctly refuse to go through the dead primary, and restarting node2 is automatically detected as a recovery.

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
ShardCore/
├── README.md
├── core/
│   └── src/
│       ├── main.cpp          # per-node process (libpqxx connection to its own DB)
│       ├── coordinator.cpp   # Coordinator: routing, failover, 2PC, heartbeat monitoring
│       └── cluster.h         # shared topology / replica-map definitions
├── api/
│   ├── server.js             # Express REST API: auth, routing, failover, 2PC
│   └── package.json
├── frontend/
│   ├── index.html            # shell; loads the files below
│   ├── css/styles.css
│   └── js/                   # api.js, auth.js, components.js, app.js (React via CDN, no build step)
├── scripts/
│   ├── setup_replication.sh  # first-time setup of the logical replication ring
│   ├── reset_catalog.sh      # replaces ALL products with 22 sample items
│   └── seed_products.sh      # adds a few extra sample products
├── docs/
│   └── partitioning.md       # partitioning strategy and trade-offs
└── .gitignore
```

## Current local build and run

Everything runs on WSL2/Ubuntu against three local PostgreSQL clusters on ports 5433, 5434 and 5435.

### Prerequisites (one-time)

- Packages: `postgresql`, `build-essential`, `libpqxx-dev`, `nodejs`, `npm`, `python3`.
- Three clusters (for example `sudo pg_createcluster 18 node1 -p 5433`, then node2 on 5434 and node3 on 5435), each with `wal_level = logical` and `max_prepared_transactions` greater than 0 in its `postgresql.conf`, then restarted.
- The `postgres` user on each node uses the password `kvara` (local development only, see Known limitations).
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

**Accounts:** the admin login is `admin` / `admin123`. Consumers create their own account with **Sign Up**.

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

- **Authentication is deliberately basic.** Real server-side checks exist (bcrypt-hashed passwords, admin-only routes enforced by the API, consumers limited to their own orders, `GET /users` admin-only and free of password hashes). But sessions are random tokens held in the API process's memory, so they are lost when the API restarts and never expire; tokens are kept in the browser's `localStorage`; the admin credentials and the database password are hardcoded in the source for local development; and there is no HTTPS, rate limiting, password-strength rule or password reset.
- **The Coordinator/API is a single point of failure.** The database nodes are fault-tolerant; the process that coordinates them is not. If the API dies between `PREPARE TRANSACTION` and `COMMIT PREPARED`, a prepared transaction can be left in doubt (visible in `pg_prepared_xacts`), and nothing resolves it automatically. A recovery sweep on startup would fix this and is out of scope.
- **Failover is read-only.** A dead node's data can still be read from its replica, but writes to that domain are refused until its primary returns (replicas are read-only subscribers), so placing an order requires both the Orders and Products primaries. There is no leader election or replica promotion.
- **Replica schemas are maintained by hand.** Logical replication copies data, not schema changes. If a column is added to a primary table, add it to the replica table with `ALTER TABLE`; re-running `setup_replication.sh` does not fix a mismatch and would tear down healthy replication.
- **No cross-node referential integrity.** `orders.user_id` and `orders.product_id` are not foreign keys (Postgres cannot enforce them across separate instances; see `docs/partitioning.md`), so deleting a user or product leaves historical orders pointing at an id that no longer exists.
- **Recovery relies on PostgreSQL.** A restarted node replays its own WAL and logical replication catches it up; the Coordinator's heartbeat notices the node answering again and resumes routing to it, but does not itself measure replication lag.
- **Scope of testing.** Built and verified as a single-machine demo with three PostgreSQL instances; it has not been load-tested or run across multiple machines.
- **Storefront cosmetics.** The crossed-out "original price" and "12% off" are computed from the real price for display only; there is no discount logic. The cart lives in the browser and is lost on refresh. Payment is Cash on Delivery only.

## License

No license has been selected yet.

## Contributing

Contributions are welcome as the project grows. For now, the work is focused on learning by building the system incrementally and validating each step with small code changes.
