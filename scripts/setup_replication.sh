#!/bin/bash
# setup_replication.sh
#
# Sets up PostgreSQL logical replication in a ring topology across the
# project's 3 nodes:
#   Node 1 (Users, port 5433)     -> replicated to -> Node 2 (port 5434)
#   Node 2 (Products, port 5434)  -> replicated to -> Node 3 (port 5435)
#   Node 3 (Orders, port 5435)    -> replicated to -> Node 1 (port 5433)
#
# Prerequisites (one-time, per node, requires a restart to take effect):
#   wal_level = logical   in each node's postgresql.conf
#
# Safe to re-run: publications/subscriptions are dropped and recreated,
# and destination tables use CREATE TABLE IF NOT EXISTS.
#
# Usage: ./setup_replication.sh

set -e

PG_USER="postgres"
PG_PASSWORD="kvara"

echo "=== Checking wal_level on all 3 nodes ==="
for node_port in 5433:node1 5434:node2 5435:node3; do
    port="${node_port%%:*}"
    name="${node_port##*:}"
    level=$(sudo -u postgres psql -p "$port" -tAc "SHOW wal_level;")
    echo "  $name (port $port): wal_level = $level"
    if [ "$level" != "logical" ]; then
        echo "  ERROR: $name needs wal_level = logical in its postgresql.conf, then a restart."
        echo "  See docs/replication-setup.md for the exact commands."
        exit 1
    fi
done

echo ""
echo "=== Leg 1: Users (node1, 5433) -> node2 (5434) ==="
sudo -u postgres psql -p 5433 -c "DROP PUBLICATION IF EXISTS users_pub;"
sudo -u postgres psql -p 5433 -c "CREATE PUBLICATION users_pub FOR TABLE users;"
sudo -u postgres psql -p 5434 -c "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT NOW());"
sudo -u postgres psql -p 5434 -c "DROP SUBSCRIPTION IF EXISTS users_sub;"
sudo -u postgres psql -p 5434 -c "CREATE SUBSCRIPTION users_sub CONNECTION 'host=127.0.0.1 port=5433 dbname=postgres user=$PG_USER password=$PG_PASSWORD' PUBLICATION users_pub;"

echo ""
echo "=== Leg 2: Products (node2, 5434) -> node3 (5435) ==="
sudo -u postgres psql -p 5434 -c "DROP PUBLICATION IF EXISTS products_pub;"
sudo -u postgres psql -p 5434 -c "CREATE PUBLICATION products_pub FOR TABLE products;"
sudo -u postgres psql -p 5435 -c "CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL, stock INT NOT NULL DEFAULT 0);"
sudo -u postgres psql -p 5435 -c "DROP SUBSCRIPTION IF EXISTS products_sub;"
sudo -u postgres psql -p 5435 -c "CREATE SUBSCRIPTION products_sub CONNECTION 'host=127.0.0.1 port=5434 dbname=postgres user=$PG_USER password=$PG_PASSWORD' PUBLICATION products_pub;"

echo ""
echo "=== Leg 3: Orders (node3, 5435) -> node1 (5433) ==="
sudo -u postgres psql -p 5435 -c "DROP PUBLICATION IF EXISTS orders_pub;"
sudo -u postgres psql -p 5435 -c "CREATE PUBLICATION orders_pub FOR TABLE orders;"
sudo -u postgres psql -p 5433 -c "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, user_id INT NOT NULL, product_id INT NOT NULL, quantity INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());"
sudo -u postgres psql -p 5433 -c "DROP SUBSCRIPTION IF EXISTS orders_sub;"
sudo -u postgres psql -p 5433 -c "CREATE SUBSCRIPTION orders_sub CONNECTION 'host=127.0.0.1 port=5435 dbname=postgres user=$PG_USER password=$PG_PASSWORD' PUBLICATION orders_pub;"

echo ""
echo "=== Replication ring setup complete ==="
echo "Verify with: SELECT * FROM pg_stat_subscription;  (run on any node)"
