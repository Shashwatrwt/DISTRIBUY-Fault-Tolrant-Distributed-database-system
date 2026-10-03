# OS + DBMS Project: Distributed, Fault-Tolerant PostgreSQL E-Commerce System

A distributed, fault-tolerant e-commerce system using PostgreSQL as the storage engine for each node. The partitioning, Coordinator, replication orchestration, distributed transactions, failure detection, and recovery logic are built by this project.

## Current Status

All core MVP components are implemented and have been verified live against a real 3-node PostgreSQL cluster:

- **3 independent PostgreSQL clusters** (node1/5433, node2/5434, node3/5435), each with its own data directory, each owning one business domain's table.
- **`core/src/main.cpp`** — a per-node process using `libpqxx` to connect to its own node's PostgreSQL database (not an in-memory placeholder). Started as `./main 1`, `./main 2`, or `./main 3`.
- **`core/src/coordinator.cpp`** — the real Coordinator. It connects to all 3 nodes simultaneously and provides:
  - request routing by domain, with **automatic failover**: if a domain's primary node is unreachable, reads are transparently served from the node holding its replicated copy instead.
  - **real Two-Phase Commit** (`PREPARE TRANSACTION` / `COMMIT PREPARED` / `ROLLBACK PREPARED`) for placing an order across the Orders and Products nodes — both the commit path and the abort path (e.g. insufficient stock, or a dead node) have been tested and leave no partial state.
  - **continuous heartbeat monitoring** (`./coordinator --watch`): pings every node on an interval and detects both failure and recovery without the Coordinator being restarted.
- **PostgreSQL logical replication** is live in the ring topology described below (Users → node2, Products → node3, Orders → node1), set up via `scripts/setup_replication.sh`. Verified: an insert on a source table appears on its replica within seconds, and a node's data survives that node being killed.
- **`api/server.js`** — a Node.js/Express REST API (`/health`, `/users`, `/products`, `/orders`) implementing the same routing, failover, and 2PC logic as the C++ Coordinator, with CORS enabled for browser access. All endpoints tested live, including placing a real order over HTTP.
- **`frontend/index.html`** — a React dashboard (cluster health, live tables, a 2PC-backed order form) that calls the REST API directly, tested in-browser including a live kill-a-node failover demo.

What's not yet built: WAL-based crash recovery logic beyond what PostgreSQL itself provides, and any of the stretch goals (leader election, dynamic sharding, multi-machine deployment) — these remain out of scope unless time permits, per the MVP/Stretch split below.

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
- recovery: PostgreSQL replays its WAL when a node restarts; the Coordinator checks replication status, syncs missed updates, and only then returns the node to service

This complete lifecycle has been demonstrated live: killing node2's PostgreSQL cluster mid-session causes the Coordinator's heartbeat loop to detect it within seconds, reads automatically fail over to node3 (which holds the replicated Products data), writes correctly refuse to go through the dead primary, and restarting node2 is automatically detected as a recovery.

## OS concepts reflected in the project

| OS topic | Where it appears |
|---|---|
| Processes | each node, coordinator, and API server is a separate process |
| Threads | nodes handle multiple client requests concurrently |
| Synchronization | mutexes/locks prevent race conditions |
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
│       └── cluster.h         # shared topology/replica-map definitions
├── api/
│   ├── server.js             # Express REST API (health, users, products, orders)
│   └── package.json
├── frontend/
│   └── index.html            # React dashboard (CDN-based, no build step)
├── scripts/
│   └── setup_replication.sh  # reproducible logical replication ring setup
├── docs/                     # planned architecture and design notes
└── .gitignore
```

## Current local build and run

Everything below runs through WSL2/Ubuntu, against 3 local PostgreSQL clusters on ports 5433/5434/5435 (`wal_level = logical` and `max_prepared_transactions > 0` must be set on all 3, per `scripts/setup_replication.sh`'s prerequisites).

**Per-node process** (mainly for demonstrating the per-node connection in isolation):
```bash
g++ -Wall -Wextra core/src/main.cpp -o core/src/main -lpqxx -lpq
./core/src/main 1   # Users node
./core/src/main 2   # Products & Inventory node
./core/src/main 3   # Orders & Payments node
```

**Coordinator** (the real distributed-systems core — connects to all 3 nodes, routes, fails over, runs 2PC):
```bash
g++ -Wall -Wextra core/src/coordinator.cpp -o core/src/coordinator -lpqxx -lpq
./core/src/coordinator           # one-shot: health check, routed queries, a 2PC order demo
./core/src/coordinator --watch   # continuous heartbeat monitoring (Ctrl+C to stop)
```

**REST API + frontend** (the demoable, browser-facing layer):
```bash
cd api && npm install && node server.js   # http://localhost:4000
```
Then open `frontend/index.html` directly in a browser (no build step required).

## Development roadmap

1. ✅ define node and cluster topology
2. ✅ implement sharding model (domain-based partitioning: each table lives on exactly one primary node)
3. ✅ connect the Coordinator to PostgreSQL-backed nodes (via `libpqxx`, over TCP)
4. ✅ add ring replication and replication-status monitoring
5. ✅ add distributed transactions with PostgreSQL 2PC
6. ✅ add concurrency control (via Postgres row-level locking, `FOR UPDATE`), failure detection, failover, and recovery
7. ✅ build the REST API and connect it to the Coordinator's logic
8. ✅ build the frontend and core e-commerce flows (browse, place order)
9. remaining: admin-dashboard polish, written partitioning documentation, and any stretch goals as time permits

## License

No license has been selected yet.

## Contributing

Contributions are welcome as the project grows. For now, the work is focused on learning by building the system incrementally and validating each step with small code changes.

