# Partitioning Strategy

This document describes how data is partitioned across the 3 nodes in this project, and why this scheme was chosen over alternatives.

## Scheme: domain-based (functional) partitioning

Each node owns exactly one business domain's table in full — not a range or hash of rows within a shared table.

| Node | Port | Owns (table) |
|---|---|---|
| Node 1 | 5433 | `users` |
| Node 2 | 5434 | `products` |
| Node 3 | 5435 | `orders` |

There is no overlap: a given row lives on exactly one primary node. `users` rows never exist outside node1 (except as a replicated copy on node2, described in the replication section of the main README), and the same applies to `products` on node2 and `orders` on node3.

This is enforced structurally, not by application logic: each node's PostgreSQL cluster only has the one table it owns created on it (plus, after replication is configured, one additional table it holds as a replica for its ring-neighbour's domain). There is no mechanism — and no need for one — to accidentally write `users` data to node2 or node3, because those nodes' primary tables for that domain simply don't exist.

## Why domain-based partitioning, instead of range or hash partitioning

A more "classic" partitioning scheme would split a single large table by key range (e.g. `users` 1-1000 on node1, 1001-2000 on node2) or by a hash of the primary key. Both were considered and rejected for this project, for reasons specific to its scope and goals:

- **Query locality.** Almost every real query in an e-commerce system is domain-scoped: "get this user," "list these products," "create this order." Range/hash partitioning would mean a single logical query (e.g. "show user Alice's order history") might need to touch multiple nodes just to read one entity type, adding complexity for no benefit at this scale. Domain-based partitioning means a single-entity read is always a single-node read.
- **Natural write locality for 2PC.** The one operation in this system that genuinely spans domains — placing an order — only ever touches exactly two nodes (Orders and Products), known in advance, regardless of which user or which product is involved. Range/hash partitioning would make the set of nodes involved in a given write unpredictable and potentially larger.
- **Simpler failure story.** With domain-based partitioning, "node2 died" has one clear meaning: "Products data is temporarily served from its replica." With range partitioning, "node2 died" would mean "an arbitrary slice of every domain is temporarily degraded," which is harder to reason about and harder to demonstrate clearly.
- **Matches the project's scale.** Range/hash partitioning exists to split a single table too large or too hot for one node. This project's tables are small by design — the goal is to demonstrate the orchestration layer (coordination, 2PC, replication, failover), not to solve a data-volume problem. Domain-based partitioning is the natural fit for a system partitioned by *service boundary* rather than by *data volume*.

## Trade-offs this scheme accepts

- **No cross-node foreign keys.** `orders.user_id` and `orders.product_id` are plain integers, not foreign keys, because Postgres cannot enforce a foreign key across separate database instances. Referential integrity across domains is the Coordinator's responsibility (or, in a production system, an application-level concern), not the database's. This is a standard, well-known trade-off in domain-partitioned (and microservice-style) architectures, not an oversight.
- **Uneven growth is not rebalanced.** If `products` grew far larger than `users` or `orders`, domain-based partitioning would not rebalance that — a single node would simply carry a bigger table. Addressing this would require range or hash partitioning *within* a domain, layered on top of this scheme. This is explicitly out of scope for the MVP (see "Stretch Goals: dynamic sharding" in the main README).
- **A domain's write availability is still bound to one primary node.** Partitioning plus replication means a domain's *reads* survive that node dying (served from the replica), but *writes* to that domain still require its primary node to be reachable — the replica is read-only, as PostgreSQL logical replication does not support multi-master writes. This is why `place_order()` in the Coordinator explicitly refuses to attempt 2PC when either required primary is down, rather than silently writing to a replica.

## Summary

Partitioning in this project is a direct reflection of the three business domains the application layer needs (Users, Products & Inventory, Orders & Payments), not a generic data-sharding mechanism bolted on afterward. This keeps the partitioning scheme, the replication ring, and the 2PC write path all describable in the same terms — which domain, which node — making the system's behaviour under failure easy to predict and easy to demonstrate.
