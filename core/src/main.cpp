#include <iostream>
#include <string>
#include <unordered_set>
#include <vector>
#include <unordered_map>
#include <ctime>
#include <cstdlib>
#include <unistd.h>
#include <pqxx/pqxx>
enum class NodeState { Starting, Ready };
enum class NodeDomain { Users, Products, Orders };
enum class TxState { Begin, Commit, Abort };
const char* state_name(NodeState state) {
    switch (state) {
        case NodeState::Starting:
            return "starting";
        case NodeState::Ready:
            return "ready";
    }
    return "unknown";
}

const char* domain_name(NodeDomain domain) {
    switch (domain) {
        case NodeDomain::Users:
            return "Users";
        case NodeDomain::Products:
            return "Products";
        case NodeDomain::Orders:
            return "Orders";
    }
    return "Unknown";
}

const char* tx_state_name(TxState state) {
    switch (state) {
        case TxState::Begin:
            return "begin";
        case TxState::Commit:
            return "commit";
        case TxState::Abort:
            return "abort";
    }
    return "unknown";
}

struct NodeConfig {
    int node_id;
    std::string host;
    int port;
    NodeDomain domain;

    bool is_valid() const {
        return node_id > 0 && !host.empty() && port > 0 && port <= 65535;
    }

    std::string endpoint() const {
        return host + ':' + std::to_string(port);
    }
};

const NodeConfig* find_peer(const std::vector<NodeConfig>& peers, int node_id) {
    for (const NodeConfig& peer : peers) {
        if (peer.node_id == node_id) {
            return &peer;
        }
    }
    return nullptr;
}

bool peers_are_valid(const NodeConfig& local,
                     const std::vector<NodeConfig>& peers) {
    std::unordered_set<int> peer_ids;
    for (const NodeConfig& peer : peers) {
        if (!peer.is_valid() || peer.node_id == local.node_id ||
            !peer_ids.insert(peer.node_id).second) {
            return false;
        }
    }
    return true;
}

struct LivenessInfo {
    long last_heartbeat_time = 0;
    bool has_heartbeat = false;

    void mark_alive(long now) {
        last_heartbeat_time = now;
        has_heartbeat = true;
    }
};

const long HEARTBEAT_TIMEOUT_SECONDS = 10;

bool is_alive(const LivenessInfo& liveness, long now) {
    if (!liveness.has_heartbeat) {
        return false;
    }
    return (now - liveness.last_heartbeat_time) <= HEARTBEAT_TIMEOUT_SECONDS;
}

struct Node {
    NodeConfig config;
    std::vector<NodeConfig> peers;

    bool is_valid() const {
        return config.is_valid() && peers_are_valid(config, peers);
    }

    std::vector<std::string> peer_endpoints() const {
        std::vector<std::string> endpoints;
        for (const auto& peer : peers) {
            endpoints.push_back(peer.endpoint());
        }
        return endpoints;
    }

    std::string summary() const {
        std::string result = "Node " + std::to_string(config.node_id) +
                             " (" + config.endpoint() + ") with " +
                             std::to_string(peers.size()) + " peer(s)";
        return result;
    }
};

struct ClusterMetadata {
    std::vector<NodeConfig> nodes;

    const NodeConfig* find_by_domain(NodeDomain domain) const {
        for (const auto& candidate : nodes) {
            if (candidate.domain == domain) {
                return &candidate;
            }
        }
        return nullptr;
    }
};

struct ReplicaMap {
    std::unordered_map<NodeDomain, NodeDomain> replication;

    void add(NodeDomain owner, NodeDomain replica) {
        replication[owner] = replica;
    }
};

// --- NEW: PgStore replaces the old in-memory Store. It wraps a real ---
// --- libpqxx connection to this node's own PostgreSQL cluster.       ---
class PgStore {
public:
    // Builds the connection string and opens a real TCP connection to
    // this node's Postgres instance (e.g. host=127.0.0.1 port=5433).
    PgStore(const std::string& host, int port,
            const std::string& user, const std::string& password,
            const std::string& dbname = "postgres") {
        std::string conn_str =
            "host=" + host +
            " port=" + std::to_string(port) +
            " user=" + user +
            " password=" + password +
            " dbname=" + dbname;
        conn_ = std::make_unique<pqxx::connection>(conn_str);
    }

    bool is_open() const {
        return conn_ && conn_->is_open();
    }

    // Runs a single INSERT/UPDATE/DELETE statement inside its own
    // transaction and commits it. Returns true on success.
    bool execute(const std::string& sql) {
        try {
            pqxx::work txn(*conn_);
            txn.exec(sql);
            txn.commit();
            return true;
        } catch (const std::exception& e) {
            std::cerr << "PgStore execute error: " << e.what() << '\n';
            return false;
        }
    }

    // Runs a SELECT and returns the number of rows found. Prints each
    // row's columns for now (useful for quick verification/demo output).
    std::size_t query_and_print(const std::string& sql) {
        try {
            pqxx::work txn(*conn_);
            pqxx::result r = txn.exec(sql);
            for (const auto& row : r) {
                std::string line;
                for (const auto& field : row) {
                    line += field.c_str();
                    line += " | ";
                }
                std::cout << "  " << line << '\n';
            }
            return r.size();
        } catch (const std::exception& e) {
            std::cerr << "PgStore query error: " << e.what() << '\n';
            return 0;
        }
    }

private:
    std::unique_ptr<pqxx::connection> conn_;
};
// --- END NEW ---

struct LogEntry {
    std::string key;
    std::string value;
    long timestamp;
};

struct TransactionLog {
    std::vector<LogEntry> entries;

    void record(const std::string& key, const std::string& value) {
        entries.push_back({key, value, (long)std::time(nullptr)});
    }

    std::size_t size() const {
        return entries.size();
    }

    std::string last_key() const {
        return entries.empty() ? "" : entries.back().key;
    }
};

bool can_failover(const ReplicaMap& replicas, NodeDomain domain) {
    return replicas.replication.find(domain) != replicas.replication.end();
}

bool node_healthy(const Node& node, const LivenessInfo& liveness, long now) {
    return node.is_valid() && is_alive(liveness, now);
}

NodeDomain route_for(const ReplicaMap& replicas, NodeDomain request) {
    auto it = replicas.replication.find(request);
    return (it != replicas.replication.end()) ? it->second : request;
}

bool owns_domain(const ClusterMetadata& metadata, NodeDomain domain, int node_id) {
    const NodeConfig* candidate = metadata.find_by_domain(domain);
    return candidate != nullptr && candidate->node_id == node_id;
}

bool quorum_available(std::size_t responsive_nodes, std::size_t quorum_size) {
    return responsive_nodes >= quorum_size;
}

TxState finish_transaction(TxState state, bool quorum_ready) {
    return state == TxState::Begin && quorum_ready ? TxState::Commit : state;
}

bool log_ready_for_recovery(const TransactionLog& log) {
    return log.size() > 0;
}

ClusterMetadata build_cluster_metadata() {
    return ClusterMetadata{{
        {1, "127.0.0.1", 5433, NodeDomain::Users},
        {2, "127.0.0.1", 5434, NodeDomain::Products},
        {3, "127.0.0.1", 5435, NodeDomain::Orders}
    }};
}

Node build_node(const ClusterMetadata& metadata, int node_id) {
    NodeConfig local{};
    std::vector<NodeConfig> peers;

    for (const auto& candidate : metadata.nodes) {
        if (candidate.node_id == node_id) {
            local = candidate;
        }
    }
    for (const auto& candidate : metadata.nodes) {
        if (candidate.node_id != node_id) {
            peers.push_back(candidate);
        }
    }
    return Node{local, peers};
}

// --- NEW: returns the table name each domain owns, and a sample row to insert. ---
// This is just a small helper so main() can demo a real insert without
// hardcoding domain-specific SQL inline.
std::string table_for_domain(NodeDomain domain) {
    switch (domain) {
        case NodeDomain::Users:
            return "users";
        case NodeDomain::Products:
            return "products";
        case NodeDomain::Orders:
            return "orders";
    }
    return "unknown";
}
// --- END NEW ---

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <node_id>\n";
        std::cerr << "  node_id must be 1 (Users), 2 (Products), or 3 (Orders)\n";
        return 1;
    }

    int node_id = std::atoi(argv[1]);
    if (node_id < 1 || node_id > 3) {
        std::cerr << "Invalid node_id: " << argv[1] << " (must be 1, 2, or 3)\n";
        return 1;
    }

    ClusterMetadata metadata = build_cluster_metadata();
    Node node = build_node(metadata, node_id);

    TransactionLog log;
    ReplicaMap replicas;
    replicas.add(NodeDomain::Users, NodeDomain::Products);
    replicas.add(NodeDomain::Products, NodeDomain::Orders);
    replicas.add(NodeDomain::Orders, NodeDomain::Users);

    NodeState state = NodeState::Starting;
    TxState tx = TxState::Begin;

    if (!node.is_valid()) {
        std::cerr << "Invalid node configuration\n";
        return 1;
    }
    state = NodeState::Ready;

    long now = (long)std::time(nullptr);
    LivenessInfo liveness;
    liveness.mark_alive(now);

    const std::size_t cluster_size = node.peers.size() + 1;
    const std::size_t quorum_size = cluster_size / 2 + 1;
    const std::size_t nodes_after_failure = cluster_size - 1;
    tx = finish_transaction(tx, quorum_available(cluster_size, quorum_size));

    std::cout << node.summary() << '\n';
    std::cout << "State: " << state_name(state) << '\n';
    std::cout << "Cluster: " << cluster_size << " nodes, quorum: " << quorum_size << '\n';
    std::cout << "Quorum status: " << (quorum_available(cluster_size, quorum_size) ? "available" : "unavailable") << '\n';
    std::cout << "After one failure: " << (quorum_available(nodes_after_failure, quorum_size) ? "available" : "unavailable") << '\n';
    std::cout << "Domain: " << domain_name(node.config.domain) << '\n';

    // --- NEW: real Postgres connection replaces the old in-memory Store ---
    std::cout << "\nConnecting to PostgreSQL at " << node.config.endpoint() << " ...\n";
    try {
        PgStore store(node.config.host, node.config.port, "postgres", "kvara");
        if (store.is_open()) {
            std::cout << "PostgreSQL connection: SUCCESS\n";

            std::string table = table_for_domain(node.config.domain);
            std::cout << "Domain table: " << table << '\n';

            // Insert one demo row appropriate to this node's domain, then read it back.
            if (node.config.domain == NodeDomain::Users) {
                store.execute(
                    "INSERT INTO users (name, email) VALUES "
                    "('Demo User', 'demo" + std::to_string(now) + "@example.com') "
                    "ON CONFLICT DO NOTHING;"
                );
            } else if (node.config.domain == NodeDomain::Products) {
                store.execute(
                    "INSERT INTO products (name, price, stock) VALUES "
                    "('Demo Product', 999.00, 10);"
                );
            } else if (node.config.domain == NodeDomain::Orders) {
                store.execute(
                    "INSERT INTO orders (user_id, product_id, quantity, status) VALUES "
                    "(1, 1, 1, 'pending');"
                );
            }

            std::cout << "Rows in " << table << ":\n";
            std::size_t row_count = store.query_and_print("SELECT * FROM " + table + ";");
            std::cout << "Total rows: " << row_count << '\n';

            log.record("pg_connection", "success");
        } else {
            std::cout << "PostgreSQL connection: FAILED (connection not open)\n";
            log.record("pg_connection", "failed");
        }
    } catch (const std::exception& e) {
        std::cout << "PostgreSQL connection: FAILED (" << e.what() << ")\n";
        log.record("pg_connection", "failed");
    }
    // --- END NEW ---

    std::cout << "\nTransaction log: " << log.size() << " entries\n";
    std::cout << "Recovery log model: " << (log_ready_for_recovery(log) ? "ready" : "empty") << '\n';
    std::cout << "Latest log key: " << log.last_key() << '\n';

    for (const auto& endpoint : node.peer_endpoints()) {
        std::cout << "  Peer endpoint: " << endpoint << '\n';
    }
    if (const NodeConfig* products = metadata.find_by_domain(NodeDomain::Products)) {
        std::cout << "Products node: " << products->endpoint() << '\n';
    }
    if (can_failover(replicas, NodeDomain::Users)) {
        std::cout << "Modeled failover route: " << domain_name(replicas.replication[NodeDomain::Users]) << '\n';
    }

    std::cout << "Heartbeat model: " << (node_healthy(node, liveness, now) ? "healthy" : "unhealthy") << '\n';

    std::cout << "Modeled coordinator failover route: " << domain_name(route_for(replicas, NodeDomain::Users)) << '\n';
    std::cout << "Transaction state model: " << tx_state_name(tx) << '\n';
    std::cout << "Domain ownership: " << (owns_domain(metadata, node.config.domain, node.config.node_id) ? "owned" : "not-owned") << '\n';

    std::cout.flush();
    _exit(0);
}
