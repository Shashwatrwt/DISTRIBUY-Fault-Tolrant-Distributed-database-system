#ifndef DISTRIBUY_CLUSTER_H
#define DISTRIBUY_CLUSTER_H

#include <cstdlib>
#include <unistd.h>
#include <iostream>
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

inline bool domain_from_name(const std::string& name, NodeDomain& out) {
    if (name == "users") { out = NodeDomain::Users; return true; }
    if (name == "products") { out = NodeDomain::Products; return true; }
    if (name == "orders") { out = NodeDomain::Orders; return true; }
    return false;
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

inline std::string pg_user() {
    const char* v = std::getenv("PG_USER");
    return v ? v : "postgres";
}
inline std::string pg_password() {
    const char* v = std::getenv("PG_PASSWORD");
    if (!v || !*v) {
        std::cerr << "PG_PASSWORD is not set. Export it before running.\n";
        std::cerr.flush();
        _exit(1);
    }
    return v;
}

#endif
