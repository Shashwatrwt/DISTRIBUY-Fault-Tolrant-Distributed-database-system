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

    std::cout << "\n=== Coordinator finished ===\n";

    std::cout.flush();
    _exit(0); // avoids the libpqxx static-destructor crash seen earlier
}
