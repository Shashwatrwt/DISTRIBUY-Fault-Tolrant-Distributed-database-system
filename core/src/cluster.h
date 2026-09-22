#ifndef SHARDCORE_CLUSTER_H
#define SHARDCORE_CLUSTER_H

#include <string>
#include <vector>
#include <unordered_map>

// This header holds the cluster topology definitions shared by both the
// per-node process (main.cpp) and the Coordinator (coordinator.cpp), so
// both always agree on which node owns which domain and which port it
// runs on.

enum class NodeDomain { Users, Products, Orders };

inline const char* domain_name(NodeDomain domain) {
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

inline std::string table_for_domain(NodeDomain domain) {
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

    const NodeConfig* find_by_id(int node_id) const {
        for (const auto& candidate : nodes) {
            if (candidate.node_id == node_id) {
                return &candidate;
            }
        }
        return nullptr;
    }
};

inline ClusterMetadata build_cluster_metadata() {
    return ClusterMetadata{{
        {1, "127.0.0.1", 5433, NodeDomain::Users},
        {2, "127.0.0.1", 5434, NodeDomain::Products},
        {3, "127.0.0.1", 5435, NodeDomain::Orders}
    }};
}

// The replication ring: each domain's data is also replicated to the node
// that owns the domain on the right. This matches scripts/setup_replication.sh:
//   Users (node1)    -> replicated to -> node2 (Products' node)
//   Products (node2) -> replicated to -> node3 (Orders' node)
//   Orders (node3)   -> replicated to -> node1 (Users' node)
// So if a domain's PRIMARY node is down, its data can still be read from
// the node that owns the domain this map points to.
inline std::unordered_map<NodeDomain, NodeDomain> build_replica_map() {
    return {
        {NodeDomain::Users, NodeDomain::Products},
        {NodeDomain::Products, NodeDomain::Orders},
        {NodeDomain::Orders, NodeDomain::Users}
    };
}

inline const char* PG_USER = "postgres";
inline const char* PG_PASSWORD = "kvara";

#endif // SHARDCORE_CLUSTER_H
