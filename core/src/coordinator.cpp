#include <iostream>
#include <string>
#include <unordered_map>
#include <memory>
#include <pqxx/pqxx>
#include <unistd.h>
#include <thread>
#include <chrono>
#include <vector>
#include <csignal>
#include <algorithm>
#include "cluster.h"
class NodeConnection {
public:
    NodeConnection(const NodeConfig& config, const std::string& user, const std::string& password)
        : config_(config) {
        conn_str_ =
            "host=" + config.host +
            " port=" + std::to_string(config.port) +
            " user=" + user +
            " password=" + password +
            " dbname=postgres";
        try_reconnect();
    }
    bool try_reconnect() {
        try {
            conn_ = std::make_unique<pqxx::connection>(conn_str_);
            alive_ = true;
            return true;
        } catch (const std::exception&) {
            conn_.reset();
            alive_ = false;
            return false;
        }
    }
    bool ping() {
        if (!conn_ || !conn_->is_open()) {
            alive_ = try_reconnect();
            if (!alive_) {
                return false;
            }
        }
        try {
            pqxx::nontransaction n(*conn_);
            n.exec("SELECT 1");
            alive_ = true;
        } catch (const std::exception&) {
            alive_ = false;
        }
        return alive_;
    }

    bool is_alive() const {
        return alive_;
    }

    const NodeConfig& config() const {
        return config_;
    }

    pqxx::connection& raw_connection() {
        return *conn_;
    }

    std::unique_ptr<pqxx::connection> open_extra_session() const {
        return std::make_unique<pqxx::connection>(conn_str_);
    }
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

    std::vector<std::vector<std::string>> fetch(const std::string& sql) {
        std::vector<std::vector<std::string>> out;
        if (!is_alive()) {
            return out;
        }
        try {
            pqxx::nontransaction n(*conn_);
            pqxx::result r = n.exec(sql);
            for (const auto& row : r) {
                std::vector<std::string> cells;
                for (const auto& field : row) {
                    cells.push_back(field.is_null() ? "" : field.c_str());
                }
                out.push_back(std::move(cells));
            }
        } catch (const std::exception&) {
        }
        return out;
    }

private:
    NodeConfig config_;
    std::string conn_str_;
    std::unique_ptr<pqxx::connection> conn_;
    bool alive_ = false;
};

static void maybe_crash(const char* point) {
    const char* allow = std::getenv("DISTRIBUY_ALLOW_FAULTS");
    const char* fault = std::getenv("DISTRIBUY_FAULT");
    if (allow && std::string(allow) == "1" && fault && std::string(fault) == point) {
        std::cout << "  [FAULT] simulated crash at " << point << std::endl;
        kill(getpid(), SIGKILL);
    }
}

static int recovery_grace_seconds() {
    const char* v = std::getenv("RECOVERY_GRACE_MS");
    return v ? std::max(0, std::atoi(v) / 1000) : 30;
}

struct DomainRole {
    NodeDomain primary = NodeDomain::Users;
    bool has_replica = false;
    NodeDomain replica = NodeDomain::Users;
    long epoch = 0;
    double updated = 0;
    std::string state = "normal";
};

class Coordinator {
public:
    explicit Coordinator(const ClusterMetadata& metadata)
        : replica_map_(build_replica_map()) {
        for (const auto& node_config : metadata.nodes) {
            connections_.emplace(
                node_config.domain,
                std::make_unique<NodeConnection>(node_config, pg_user(), pg_password())
            );
        }
        refresh_roles();
    }

    void refresh_roles() {
        std::unordered_map<NodeDomain, DomainRole> best;
        for (auto& [domain, conn] : connections_) {
            auto rows = conn->fetch(
                "SELECT domain, primary_node, COALESCE(replica_node, ''), epoch, state, "
                "extract(epoch from updated_at) FROM cluster_meta");
            for (const auto& r : rows) {
                NodeDomain dom, prim;
                NodeDomain rep = NodeDomain::Users;
                if (!domain_from_name(r[0], dom) || !domain_from_name(r[1], prim)) continue;
                DomainRole role;
                role.primary = prim;
                role.has_replica = domain_from_name(r[2], rep);
                role.replica = rep;
                role.epoch = std::stol(r[3]);
                role.state = r[4];
                role.updated = std::stod(r[5]);
                auto it = best.find(dom);
                if (it == best.end() || role.epoch > it->second.epoch ||
                    (role.epoch == it->second.epoch && role.updated > it->second.updated)) {
                    best[dom] = role;
                }
            }
        }
        if (!best.empty()) {
            roles_ = best;
        }
    }

    DomainRole role_for(NodeDomain domain) const {
        auto it = roles_.find(domain);
        if (it != roles_.end()) {
            return it->second;
        }
        DomainRole fallback;
        fallback.primary = domain;
        auto rep = replica_map_.find(domain);
        if (rep != replica_map_.end()) {
            fallback.has_replica = true;
            fallback.replica = rep->second;
        }
        return fallback;
    }

    std::string roles_summary() const {
        std::string out;
        for (NodeDomain d : {NodeDomain::Users, NodeDomain::Products, NodeDomain::Orders}) {
            DomainRole r = role_for(d);
            out += std::string(domain_name(d)) + ": primary=" + domain_name(r.primary) + " node, replica=" +
                   (r.has_replica ? std::string(domain_name(r.replica)) + " node" : std::string("none")) +
                   ", epoch " + std::to_string(r.epoch) + ", " + r.state + "\n";
        }
        return out;
    }

    void route_and_query(NodeDomain domain) {
        DomainRole role = role_for(domain);
        auto it = connections_.find(role.primary);
        if (it == connections_.end()) {
            std::cerr << "No node registered for domain " << domain_name(domain) << '\n';
            return;
        }
        NodeConnection& primary = *it->second;
        std::cout << "Routing " << domain_name(domain) << " to its primary on the " << domain_name(role.primary)
                   << " node (" << primary.config().endpoint() << "), epoch " << role.epoch << '\n';

        if (primary.is_alive()) {
            std::cout << "  Status: reachable (primary)\n";
            std::size_t rows = primary.query_table(table_for_domain(domain));
            std::cout << "  Rows returned: " << rows << '\n';
            return;
        }

        std::cout << "  Status: PRIMARY UNREACHABLE - attempting failover read...\n";
        if (!role.has_replica) {
            std::cout << "  No in-service replica for " << domain_name(domain) << ". Read failed.\n";
            return;
        }
        auto replica_conn_it = connections_.find(role.replica);
        if (replica_conn_it == connections_.end() || !replica_conn_it->second->is_alive()) {
            std::cout << "  Replica node (" << domain_name(role.replica)
                       << "'s node) is ALSO unreachable. Read failed - no surviving copy.\n";
            return;
        }
        NodeConnection& replica = *replica_conn_it->second;
        std::cout << "  FAILOVER READ: serving from replica on " << domain_name(role.replica)
                   << "'s node (" << replica.config().endpoint() << ")\n";
        std::size_t rows = replica.query_table(table_for_domain(domain));
        std::cout << "  Rows returned (from replica): " << rows << '\n';
    }

    NodeConnection* log_connection() {
        auto it = connections_.find(role_for(NodeDomain::Users).primary);
        return (it != connections_.end() && it->second->is_alive()) ? it->second.get() : nullptr;
    }

    bool log_exec(const std::string& sql) {
        NodeConnection* lg = log_connection();
        if (!lg) {
            return false;
        }
        try {
            pqxx::nontransaction n(lg->raw_connection());
            n.exec(sql);
            return true;
        } catch (const std::exception& e) {
            std::cerr << "  [2PC-LOG] write failed: " << e.what() << '\n';
            return false;
        }
    }

    bool log_state(const std::string& txn_id, const std::string& state) {
        NodeConnection* lg = log_connection();
        if (!lg) {
            return false;
        }
        const std::string done = (state == "COMMITTED" || state == "ABORTED") ? ", completed_at = now()" : "";
        return log_exec("UPDATE txn_log SET state = " + lg->raw_connection().quote(state) +
                         ", updated_at = now()" + done + " WHERE txn_id = " + lg->raw_connection().quote(txn_id));
    }

    std::string log_decide(const std::string& txn_id, const std::string& decision) {
        NodeConnection* lg = log_connection();
        if (!lg) {
            return "";
        }
        auto& c = lg->raw_connection();
        if (!log_exec("UPDATE txn_log SET decision = " + c.quote(decision) + ", updated_at = now() WHERE txn_id = " +
                       c.quote(txn_id) + " AND decision IS NULL")) {
            return "";
        }
        auto rows = lg->fetch("SELECT COALESCE(decision, '') FROM txn_log WHERE txn_id = " + c.quote(txn_id));
        return rows.empty() ? "" : rows[0][0];
    }

    bool place_order(int user_id, int product_id, int quantity) {
        DomainRole orders_role = role_for(NodeDomain::Orders);
        DomainRole products_role = role_for(NodeDomain::Products);
        auto orders_it = connections_.find(orders_role.primary);
        auto products_it = connections_.find(products_role.primary);

        if (orders_it == connections_.end() || products_it == connections_.end()) {
            std::cout << "  [2PC] Missing node registration for Orders or Products.\n";
            return false;
        }

        NodeConnection& orders_conn = *orders_it->second;
        NodeConnection& products_conn = *products_it->second;

        if (!orders_conn.is_alive() || !products_conn.is_alive()) {
            std::cout << "  [2PC] Aborting: one or more required primaries are unreachable "
                       << "(Orders: " << (orders_conn.is_alive() ? "up" : "DOWN")
                       << ", Products: " << (products_conn.is_alive() ? "up" : "DOWN") << "). "
                       << "2PC requires writing to the current primary - a replica cannot be written to.\n";
            return false;
        }
        if (!log_connection()) {
            std::cout << "  [2PC] Aborting: the transaction log (Users primary) is unreachable; "
                       << "refusing to run 2PC without a durable log.\n";
            return false;
        }

        std::unique_ptr<pqxx::connection> extra_orders_session;
        pqxx::connection* orders_pg = &orders_conn.raw_connection();
        if (orders_it == products_it) {
            try {
                extra_orders_session = orders_conn.open_extra_session();
                orders_pg = extra_orders_session.get();
            } catch (const std::exception& e) {
                std::cout << "  [2PC] Aborting: cannot open a second session on the shared node (" << e.what() << ").\n";
                return false;
            }
        }

        static int txn_counter = 0;
        ++txn_counter;
        std::string txn_id = "order_c" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) +
                             "_" + std::to_string(getpid()) + "_" + std::to_string(txn_counter);
        std::string txn_orders = txn_id + "_orders";
        std::string txn_products = txn_id + "_products";

        const std::string orders_key = table_for_domain(orders_role.primary);
        const std::string products_key = table_for_domain(products_role.primary);
        auto& lc = log_connection()->raw_connection();
        const std::string participants =
            "{\"orders\":{\"node\":\"" + orders_key + "\",\"gid\":\"" + txn_orders + "\"},"
            "\"products\":{\"node\":\"" + products_key + "\",\"gid\":\"" + txn_products + "\"}}";
        const std::string payload = "{\"user_id\":" + std::to_string(user_id) + ",\"product_id\":" +
                                    std::to_string(product_id) + ",\"quantity\":" + std::to_string(quantity) + "}";
        if (!log_exec("INSERT INTO txn_log (txn_id, state, participants, payload) VALUES (" + lc.quote(txn_id) +
                       ", 'INITIATED', " + lc.quote(participants) + "::jsonb, " + lc.quote(payload) + "::jsonb)")) {
            std::cout << "  [2PC] Aborting: could not write the transaction log.\n";
            return false;
        }
        log_state(txn_id, "PREPARING");

        bool orders_prepared = false;
        bool products_prepared = false;

        std::cout << "\n[2PC] " << txn_id << "\n[2PC] Phase 1: PREPARE (Products on " << products_key
                   << " node, Orders on " << orders_key << " node)\n";

        try {
            pqxx::work txn(products_conn.raw_connection());
            pqxx::result r = txn.exec(
                "SELECT stock, price FROM products WHERE id = " + std::to_string(product_id) + " FOR UPDATE"
            );
            if (r.empty()) {
                throw std::runtime_error("product not found");
            }
            int stock = r[0][0].as<int>();
            std::string price = r[0][1].c_str();
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

            try {
                pqxx::work otxn(*orders_pg);
                otxn.exec(
                    "INSERT INTO orders (user_id, product_id, quantity, status, unit_price) VALUES (" +
                    std::to_string(user_id) + ", " + std::to_string(product_id) + ", " +
                    std::to_string(quantity) + ", 'pending', " + price + ")"
                );
                otxn.exec("PREPARE TRANSACTION '" + txn_orders + "'");
                orders_prepared = true;
                std::cout << "  Orders node: PREPARE succeeded\n";
            } catch (const std::exception& e) {
                std::cout << "  Orders node: PREPARE failed (" << e.what() << ")\n";
            }
        } catch (const std::exception& e) {
            std::cout << "  Products node: PREPARE failed (" << e.what() << ")\n";
        }

        maybe_crash("after_prepare");
        std::string decision;
        if (orders_prepared && products_prepared) {
            log_state(txn_id, "PREPARED");
            maybe_crash("after_prepared_record");
            decision = log_decide(txn_id, "COMMIT");
            maybe_crash("after_decision");
            if (decision.empty()) {
                decision = "ABORT";
            }
        } else {
            decision = log_decide(txn_id, "ABORT");
            if (decision.empty()) {
                decision = "ABORT";
            }
        }
        std::cout << "[2PC] Phase 2: " << (decision == "COMMIT" ? "COMMIT" : "ABORT") << "\n";

        try {
            if (decision == "COMMIT") {
                pqxx::nontransaction n1(*orders_pg);
                n1.exec("COMMIT PREPARED '" + txn_orders + "'");
                maybe_crash("after_first_commit");
                pqxx::nontransaction n2(products_conn.raw_connection());
                n2.exec("COMMIT PREPARED '" + txn_products + "'");
                log_state(txn_id, "COMMITTED");
                std::cout << "  Order placed successfully.\n";
                return true;
            }
            if (orders_prepared) {
                pqxx::nontransaction n1(*orders_pg);
                n1.exec("ROLLBACK PREPARED '" + txn_orders + "'");
                std::cout << "  Rolled back Orders node.\n";
            }
            if (products_prepared) {
                pqxx::nontransaction n2(products_conn.raw_connection());
                n2.exec("ROLLBACK PREPARED '" + txn_products + "'");
                std::cout << "  Rolled back Products node.\n";
            }
            log_state(txn_id, "ABORTED");
            std::cout << "  Order aborted: no partial changes were made.\n";
        } catch (const std::exception& e) {
            std::cout << "  Phase 2 interrupted (" << e.what() << "); the decision is logged and recovery will finish it.\n";
        }
        return false;
    }

    void recover_in_doubt() {
        NodeConnection* lg = log_connection();
        if (!lg) {
            return;
        }
        auto& lc = lg->raw_connection();
        auto rows = lg->fetch(
            "SELECT txn_id, COALESCE(decision, ''), participants->'orders'->>'node', participants->'orders'->>'gid', "
            "participants->'products'->>'node', participants->'products'->>'gid' FROM txn_log "
            "WHERE state NOT IN ('COMMITTED','ABORTED') AND updated_at < now() - make_interval(secs => " +
            std::to_string(recovery_grace_seconds()) + ") ORDER BY created_at");
        for (const auto& row : rows) {
            const std::string& txn_id = row[0];
            std::string decision = row[1];
            if (decision.empty()) {
                decision = log_decide(txn_id, "ABORT");
                std::cout << "  [2PC-RECOVERY] " << txn_id << ": coordinator crashed before deciding; "
                           << "no success was ever acknowledged, logging ABORT\n";
                if (decision.empty()) {
                    continue;
                }
            }
            const std::string verb = (decision == "COMMIT") ? "COMMIT" : "ROLLBACK";
            bool pending = false;
            for (int i = 0; i < 2; ++i) {
                const std::string& node_key = row[2 + i * 2];
                const std::string& gid = row[3 + i * 2];
                NodeDomain nd;
                if (!domain_from_name(node_key, nd) || connections_.find(nd) == connections_.end() ||
                    !connections_[nd]->is_alive()) {
                    std::cout << "  [2PC-RECOVERY] " << txn_id << ": participant on node '" << node_key
                               << "' unreachable; leaving in doubt (no assumptions made)\n";
                    pending = true;
                    continue;
                }
                NodeConnection& pc = *connections_[nd];
                auto has = pc.fetch("SELECT 1 FROM pg_prepared_xacts WHERE gid = " + pc.raw_connection().quote(gid));
                if (!has.empty()) {
                    try {
                        pqxx::nontransaction n(pc.raw_connection());
                        n.exec(verb + " PREPARED " + pc.raw_connection().quote(gid));
                        std::cout << "  [2PC-RECOVERY] " << txn_id << ": " << verb << " PREPARED on " << node_key
                                   << " (logged decision " << decision << ")\n";
                    } catch (const std::exception& e) {
                        std::cout << "  [2PC-RECOVERY] " << txn_id << ": " << verb << " failed on " << node_key
                                   << ": " << e.what() << "\n";
                        pending = true;
                    }
                }
            }
            if (!pending) {
                log_state(txn_id, decision == "COMMIT" ? "COMMITTED" : "ABORTED");
                std::cout << "  [2PC-RECOVERY] " << txn_id << ": completed as "
                           << (decision == "COMMIT" ? "COMMITTED" : "ABORTED") << "\n";
            }
        }
        (void)lc;
    }

    void heartbeat_tick() {
        for (auto& [domain, conn] : connections_) {
            bool was_alive = conn->is_alive();
            bool now_alive = conn->ping();
            if (was_alive && !now_alive) {
                std::cout << "  [HEARTBEAT] " << domain_name(domain) << " node ("
                           << conn->config().endpoint() << ") went DOWN\n";
            } else if (!was_alive && now_alive) {
                std::cout << "  [HEARTBEAT] " << domain_name(domain) << " node ("
                           << conn->config().endpoint() << ") RECOVERED\n";
            }
        }
        std::string before = roles_summary();
        refresh_roles();
        std::string after = roles_summary();
        if (before != after) {
            std::cout << "  [ROLES] role change observed:\n" << after;
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
                   << (alive_count >= quorum ? "AVAILABLE" : "UNAVAILABLE") << "\n";
        std::cout << "Roles (from cluster_meta, highest epoch):\n" << roles_summary() << "\n";
    }

private:
    std::unordered_map<NodeDomain, std::unique_ptr<NodeConnection>> connections_;
    std::unordered_map<NodeDomain, NodeDomain> replica_map_;
    std::unordered_map<NodeDomain, DomainRole> roles_;
};

int main(int argc, char* argv[]) {
    bool watch_mode = (argc > 1 && std::string(argv[1]) == "--watch");

    std::cout << "=== Distribuy Coordinator starting ===\n";
    ClusterMetadata metadata = build_cluster_metadata();

    std::cout << "Connecting to all nodes...\n";
    Coordinator coordinator(metadata);

    if (argc > 1 && std::string(argv[1]) == "--recover") {
        coordinator.recover_in_doubt();
        std::cout.flush();
        _exit(0);
    }
    if (argc > 4 && std::string(argv[1]) == "--order") {
        bool placed = coordinator.place_order(std::atoi(argv[2]), std::atoi(argv[3]), std::atoi(argv[4]));
        std::cout << (placed ? "RESULT: committed" : "RESULT: not committed") << std::endl;
        _exit(placed ? 0 : 3);
    }

    std::cout << "Recovering in-doubt transactions from the durable log...\n";
    coordinator.recover_in_doubt();

    if (watch_mode) {
        const int interval_seconds = 3;
        std::cout << "\n[WATCH MODE] Heartbeat interval: " << interval_seconds
                   << "s. Press Ctrl+C to stop.\n";
        int tick = 0;
        while (true) {
            ++tick;
            coordinator.heartbeat_tick();
            if (tick % 5 == 0) {
                coordinator.print_cluster_health();
            }
            if (tick % 10 == 0) {
                coordinator.recover_in_doubt();
            }
            std::cout.flush();
            std::this_thread::sleep_for(std::chrono::seconds(interval_seconds));
        }
    }

    coordinator.print_cluster_health();

    std::cout << "--- Demo: routing one query per domain (role-aware, with failover reads) ---\n";
    coordinator.route_and_query(NodeDomain::Users);
    coordinator.route_and_query(NodeDomain::Products);
    coordinator.route_and_query(NodeDomain::Orders);

    std::cout << "\n--- Demo: placing an order via logged 2PC ---\n";
    coordinator.place_order(1, 1, 1);

    std::cout << "\n=== Coordinator finished ===\n";

    std::cout.flush();
    _exit(0);
}
