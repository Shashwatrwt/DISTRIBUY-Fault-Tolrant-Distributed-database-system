#include <iostream>
#include <string>
#include <unordered_map>
#include <memory>
#include <pqxx/pqxx>
#include <unistd.h>
#include "cluster.h"

// The Coordinator is the "brain" described in the README: the application
// layer talks only to this process, never to a node directly. It holds a
// live connection to every node at once and routes each request to the
// node that owns the relevant domain.

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

    // Exposes the raw connection so the Coordinator can issue the
    // PREPARE TRANSACTION / COMMIT PREPARED / ROLLBACK PREPARED commands
    // needed for 2PC. These don't fit the simple execute()/query() helpers
    // because a prepared transaction is deliberately left "hanging" between
    // Phase 1 and Phase 2, rather than committed inside one call.
    pqxx::connection& raw_connection() {
        return *conn_;
    }

    // Runs a SELECT against this node's table and returns the row count,
    // printing each row for visibility during the demo.
    std::size_t query_domain_table() {
        if (!is_alive()) {
            std::cerr << "  [ERROR] Node " << config_.node_id << " is not connected.\n";
            return 0;
        }
        try {
            pqxx::work txn(*conn_);
            std::string table = table_for_domain(config_.domain);
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

private:
    NodeConfig config_;
    std::unique_ptr<pqxx::connection> conn_;
};

// The Coordinator's routing table: maps each domain to its live connection.
// This is the in-memory piece that answers "which node owns this data?"
// and "is that node currently reachable?" — the two questions every
// request has to answer before the Coordinator can act on it.
class Coordinator {
public:
    explicit Coordinator(const ClusterMetadata& metadata) {
        for (const auto& node_config : metadata.nodes) {
            connections_.emplace(
                node_config.domain,
                std::make_unique<NodeConnection>(node_config, PG_USER, PG_PASSWORD)
            );
        }
    }

    // Routes a request to the node that owns the given domain. This is
    // the core Coordinator behaviour described in the README: the caller
    // never needs to know which node_id or port serves a given domain.
    void route_and_query(NodeDomain domain) {
        auto it = connections_.find(domain);
        if (it == connections_.end()) {
            std::cerr << "No node registered for domain " << domain_name(domain) << '\n';
            return;
        }
        NodeConnection& conn = *it->second;
        std::cout << "Routing to " << domain_name(domain) << " node ("
                   << conn.config().endpoint() << ")\n";
        if (!conn.is_alive()) {
            std::cout << "  Status: UNREACHABLE\n";
            return;
        }
        std::cout << "  Status: reachable\n";
        std::size_t rows = conn.query_domain_table();
        std::cout << "  Rows returned: " << rows << '\n';
    }

    // A simple health summary across the whole cluster — the beginning
    // of the heartbeat/failure-detection logic the README describes.
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

    // --- Two-Phase Commit: place an order across the Orders node and the
    // --- Products node, so the two writes either both happen or neither does.
    //
    // Phase 1 (Prepare): insert the order row on the Orders node, and check
    // + decrement stock on the Products node, then PREPARE TRANSACTION on
    // whichever ones succeed.
    //
    // Phase 2 (Commit/Abort): if BOTH nodes prepared successfully, COMMIT
    // PREPARED on both. If either failed to prepare, ROLLBACK PREPARED on
    // whichever one did succeed, so we never end up with stock reduced but
    // no order recorded (or vice versa).
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
                       << ", Products: " << (products_conn.is_alive() ? "up" : "DOWN") << ")\n";
            return false;
        }

        // Unique transaction IDs per participant, as Postgres 2PC requires
        // a distinct name per prepared transaction per connection.
        static int txn_counter = 0;
        ++txn_counter;
        std::string txn_orders = "order_" + std::to_string(txn_counter) + "_orders";
        std::string txn_products = "order_" + std::to_string(txn_counter) + "_products";

        bool orders_prepared = false;
        bool products_prepared = false;

        std::cout << "\n[2PC] Phase 1: PREPARE\n";

        // --- Prepare on Orders node ---
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

        // --- Prepare on Products node (check stock, then decrement) ---
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

private:
    std::unordered_map<NodeDomain, std::unique_ptr<NodeConnection>> connections_;
};

int main() {
    std::cout << "=== ShardCore Coordinator starting ===\n";
    ClusterMetadata metadata = build_cluster_metadata();

    std::cout << "Connecting to all nodes...\n";
    Coordinator coordinator(metadata);

    coordinator.print_cluster_health();

    std::cout << "--- Demo: routing one query per domain ---\n";
    coordinator.route_and_query(NodeDomain::Users);
    coordinator.route_and_query(NodeDomain::Products);
    coordinator.route_and_query(NodeDomain::Orders);

    std::cout << "\n--- Demo: placing an order via 2PC ---\n";
    coordinator.place_order(/*user_id=*/1, /*product_id=*/1, /*quantity=*/1);

    std::cout << "\n=== Coordinator finished ===\n";

    std::cout.flush();
    _exit(0); // avoids the libpqxx static-destructor crash seen earlier
}
