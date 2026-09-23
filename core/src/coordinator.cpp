#include <iostream>
#include <string>
#include <unordered_map>
#include <memory>
#include <pqxx/pqxx>
#include <unistd.h>
#include "cluster.h"

// The Coordinator is the "brain" described in the README: the application
// layer talks only to this process, never to a node directly. It holds a
// live connection to every node at once, routes each request to the node
// that owns the relevant domain, and — as of this version — automatically
// redirects reads to a replica node when the primary is unreachable.

class NodeConnection {
public:
    NodeConnection(const NodeConfig& config, const std::string& user, const std::string& password)
        : config_(config) {
        std::string conn_str =
            "host=" + config.host +
            " port=" + std::to_string(config.port) +
            " user=" + user +
            " password=" + password +
            " dbname=postgres";
        try {
            conn_ = std::make_unique<pqxx::connection>(conn_str);
        } catch (const std::exception& e) {
            std::cerr << "  [WARN] Could not connect to node " << config_.node_id
                      << " (" << domain_name(config_.domain) << ") at "
                      << config_.endpoint() << ": " << e.what() << '\n';
        }
    }

    bool is_alive() const {
        return conn_ && conn_->is_open();
    }

    const NodeConfig& config() const {
        return config_;
    }

    pqxx::connection& raw_connection() {
        return *conn_;
    }

    // Queries a specific table on this connection. Generalized (rather than
    // always querying this node's OWN domain table) so a replica node's
    // connection can also be used to read another domain's replicated data
    // during failover.
    std::size_t query_table(const std::string& table) {
        if (!is_alive()) {
            std::cerr << "  [ERROR] Node " << config_.node_id << " is not connected.\n";
            return 0;
        }
        try {
            pqxx::work txn(*conn_);
            pqxx::result r = txn.exec("SELECT * FROM " + table + ";");
            for (const auto& row : r) {
                std::string line;
                for (const auto& field : row) {
                    line += field.c_str();
                    line += " | ";
                }
                std::cout << "    " << line << '\n';
            }
            return r.size();
        } catch (const std::exception& e) {
            std::cerr << "  [ERROR] Query failed on node " << config_.node_id
                       << ": " << e.what() << '\n';
            return 0;
        }
    }

    std::size_t query_domain_table() {
        return query_table(table_for_domain(config_.domain));
    }

private:
    NodeConfig config_;
    std::unique_ptr<pqxx::connection> conn_;
};

class Coordinator {
public:
    explicit Coordinator(const ClusterMetadata& metadata)
        : replica_map_(build_replica_map()) {
        for (const auto& node_config : metadata.nodes) {
            connections_.emplace(
                node_config.domain,
                std::make_unique<NodeConnection>(node_config, PG_USER, PG_PASSWORD)
            );
        }
    }

    // Routes a request to the node that owns the given domain. If that
    // node is unreachable, automatically falls back to the node that
    // holds a replicated copy of this domain's data (per the ring
    // topology), so a single node failure doesn't make the data
    // unavailable for reads — only writes still require the real owner.
    void route_and_query(NodeDomain domain) {
        auto it = connections_.find(domain);
        if (it == connections_.end()) {
            std::cerr << "No node registered for domain " << domain_name(domain) << '\n';
            return;
        }
        NodeConnection& primary = *it->second;
        std::cout << "Routing to " << domain_name(domain) << " node ("
                   << primary.config().endpoint() << ")\n";

        if (primary.is_alive()) {
            std::cout << "  Status: reachable (primary)\n";
            std::size_t rows = primary.query_domain_table();
            std::cout << "  Rows returned: " << rows << '\n';
            return;
        }

        // --- Primary is down: attempt automatic failover to the replica ---
        std::cout << "  Status: PRIMARY UNREACHABLE - attempting failover...\n";

        auto replica_domain_it = replica_map_.find(domain);
        if (replica_domain_it == replica_map_.end()) {
            std::cout << "  No replica configured for " << domain_name(domain) << ". Read failed.\n";
            return;
        }

        NodeDomain replica_domain = replica_domain_it->second;
        auto replica_conn_it = connections_.find(replica_domain);
        if (replica_conn_it == connections_.end() || !replica_conn_it->second->is_alive()) {
            std::cout << "  Replica node (" << domain_name(replica_domain)
                       << "'s node) is ALSO unreachable. Read failed - no surviving copy.\n";
            return;
        }

        NodeConnection& replica = *replica_conn_it->second;
        std::cout << "  FAILOVER: serving from replica on " << domain_name(replica_domain)
                   << "'s node (" << replica.config().endpoint() << "), "
                   << "which holds a replicated copy of " << domain_name(domain) << " data\n";
        std::size_t rows = replica.query_table(table_for_domain(domain));
        std::cout << "  Rows returned (from replica): " << rows << '\n';
    }

    bool place_order(int user_id, int product_id, int quantity) {
        auto orders_it = connections_.find(NodeDomain::Orders);
        auto products_it = connections_.find(NodeDomain::Products);

        if (orders_it == connections_.end() || products_it == connections_.end()) {
            std::cout << "  [2PC] Missing node registration for Orders or Products.\n";
            return false;
        }

        NodeConnection& orders_conn = *orders_it->second;
        NodeConnection& products_conn = *products_it->second;

        if (!orders_conn.is_alive() || !products_conn.is_alive()) {
            std::cout << "  [2PC] Aborting: one or more required nodes are unreachable "
                       << "(Orders: " << (orders_conn.is_alive() ? "up" : "DOWN")
                       << ", Products: " << (products_conn.is_alive() ? "up" : "DOWN") << "). "
                       << "2PC requires writing to the real owner node - a replica cannot "
                       << "be written to, only read from.\n";
            return false;
        }

        static int txn_counter = 0;
        ++txn_counter;
        std::string txn_orders = "order_" + std::to_string(txn_counter) + "_orders";
        std::string txn_products = "order_" + std::to_string(txn_counter) + "_products";

        bool orders_prepared = false;
        bool products_prepared = false;

        std::cout << "\n[2PC] Phase 1: PREPARE\n";

        try {
            pqxx::work txn(orders_conn.raw_connection());
            txn.exec(
                "INSERT INTO orders (user_id, product_id, quantity, status) VALUES (" +
                std::to_string(user_id) + ", " + std::to_string(product_id) + ", " +
                std::to_string(quantity) + ", 'pending')"
            );
            txn.exec("PREPARE TRANSACTION '" + txn_orders + "'");
            orders_prepared = true;
            std::cout << "  Orders node: PREPARE succeeded\n";
        } catch (const std::exception& e) {
            std::cout << "  Orders node: PREPARE failed (" << e.what() << ")\n";
        }

        try {
            pqxx::work txn(products_conn.raw_connection());
            pqxx::result r = txn.exec(
                "SELECT stock FROM products WHERE id = " + std::to_string(product_id) + " FOR UPDATE"
            );
            if (r.empty()) {
                throw std::runtime_error("product not found");
            }
            int stock = r[0][0].as<int>();
            if (stock < quantity) {
                throw std::runtime_error("insufficient stock (have " + std::to_string(stock) +
                                          ", need " + std::to_string(quantity) + ")");
            }
            txn.exec(
                "UPDATE products SET stock = stock - " + std::to_string(quantity) +
                " WHERE id = " + std::to_string(product_id)
            );
            txn.exec("PREPARE TRANSACTION '" + txn_products + "'");
            products_prepared = true;
            std::cout << "  Products node: PREPARE succeeded\n";
        } catch (const std::exception& e) {
            std::cout << "  Products node: PREPARE failed (" << e.what() << ")\n";
        }

        std::cout << "[2PC] Phase 2: " << ((orders_prepared && products_prepared) ? "COMMIT" : "ABORT") << "\n";

        if (orders_prepared && products_prepared) {
            pqxx::nontransaction n1(orders_conn.raw_connection());
            n1.exec("COMMIT PREPARED '" + txn_orders + "'");
            pqxx::nontransaction n2(products_conn.raw_connection());
            n2.exec("COMMIT PREPARED '" + txn_products + "'");
            std::cout << "  Order placed successfully.\n";
            return true;
        } else {
            if (orders_prepared) {
                pqxx::nontransaction n1(orders_conn.raw_connection());
                n1.exec("ROLLBACK PREPARED '" + txn_orders + "'");
                std::cout << "  Rolled back Orders node.\n";
            }
            if (products_prepared) {
                pqxx::nontransaction n2(products_conn.raw_connection());
                n2.exec("ROLLBACK PREPARED '" + txn_products + "'");
                std::cout << "  Rolled back Products node.\n";
            }
            std::cout << "  Order aborted: no partial changes were made.\n";
            return false;
        }
    }

    void print_cluster_health() {
        std::size_t alive_count = 0;
        std::cout << "\nCluster health:\n";
        for (const auto& [domain, conn] : connections_) {
            bool alive = conn->is_alive();
            alive_count += alive ? 1 : 0;
            std::cout << "  " << domain_name(domain) << " node ("
                       << conn->config().endpoint() << "): "
                       << (alive ? "UP" : "DOWN") << '\n';
        }
        std::size_t total = connections_.size();
        std::size_t quorum = total / 2 + 1;
        std::cout << "  " << alive_count << "/" << total << " nodes reachable "
                   << "(quorum " << quorum << "): "
                   << (alive_count >= quorum ? "AVAILABLE" : "UNAVAILABLE") << "\n\n";
    }

private:
    std::unordered_map<NodeDomain, std::unique_ptr<NodeConnection>> connections_;
    std::unordered_map<NodeDomain, NodeDomain> replica_map_;
};

int main() {
    std::cout << "=== ShardCore Coordinator starting ===\n";
    ClusterMetadata metadata = build_cluster_metadata();

    std::cout << "Connecting to all nodes...\n";
    Coordinator coordinator(metadata);

    coordinator.print_cluster_health();

    std::cout << "--- Demo: routing one query per domain (with automatic failover) ---\n";
    coordinator.route_and_query(NodeDomain::Users);
    coordinator.route_and_query(NodeDomain::Products);
    coordinator.route_and_query(NodeDomain::Orders);

    std::cout << "\n--- Demo: placing an order via 2PC ---\n";
    coordinator.place_order(/*user_id=*/1, /*product_id=*/1, /*quantity=*/1);

    std::cout << "\n=== Coordinator finished ===\n";

    std::cout.flush();
    _exit(0);
}
