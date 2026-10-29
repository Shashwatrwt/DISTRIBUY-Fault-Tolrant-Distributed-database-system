#ifndef DISTRIBUY_CLUSTER_H
#define DISTRIBUY_CLUSTER_H

#include <string>
#include <vector>
#include <unordered_map>
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

    std::string endpoint() const {
        return host + ':' + std::to_string(port);
    }
};

struct ClusterMetadata {
    std::vector<NodeConfig> nodes;

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
inline std::unordered_map<NodeDomain, NodeDomain> build_replica_map() {
    return {
        {NodeDomain::Users, NodeDomain::Products},
        {NodeDomain::Products, NodeDomain::Orders},
        {NodeDomain::Orders, NodeDomain::Users}
    };
}

inline const char* PG_USER = "postgres";
inline const char* PG_PASSWORD = "kvara";

#endif
