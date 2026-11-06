#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export PGPASSWORD="$PG_PASSWORD"
PORTS=(5433 5434 5435); NAMES=(users products orders)
Q(){ psql -h 127.0.0.1 -p "$1" -U postgres -tA -F'|' -c "$2" 2>&1; }

primary_port(){
  local node; node=$(Q 5433 "select primary_node from cluster_meta where domain='$1'")
  for i in 0 1 2; do [ "${NAMES[$i]}" = "$node" ] && echo "${PORTS[$i]}"; done
}

found=0
for i in 0 1 2; do
  port=${PORTS[$i]}
  for arch in $(Q "$port" "select tablename from pg_tables where schemaname='public' and tablename ~ '_divergent_[0-9]+$' order by 1"); do
    found=1
    table=${arch%_divergent_*}
    domain=$table; [ "$table" = txn_log ] && domain=users
    pport=$(primary_port "$domain")
    echo "== $arch on ${NAMES[$i]} node (port $port)  vs  live '$table' on the current primary (port $pport)"
    if [ "$(Q "$port" "select count(*) from information_schema.columns where table_name='$arch' and column_name='id'")" != 1 ]; then
      echo "   (no 'id' column; compare manually)"; continue
    fi
    cols=$(Q "$port" "select 'id,' || coalesce(string_agg(quote_ident(column_name), ',' order by column_name), '') from information_schema.columns where table_schema='public' and table_name='$arch' and column_name<>'id'")
    tmp=$(mktemp -d)
    Q "$port"  "select $cols from $arch  order by id" | sort > "$tmp/arch"
    Q "$pport" "select $cols from $table order by id" | sort > "$tmp/live"
    comm -23 "$tmp/arch" "$tmp/live" > "$tmp/diff"
    live_ids=$(cut -d'|' -f1 "$tmp/live" | sort)
    only=0; changed=0
    echo "   columns: $cols"
    while IFS= read -r row; do
      [ -z "$row" ] && continue
      id=${row%%|*}
      if echo "$live_ids" | grep -qx "$id"; then changed=$((changed+1)); echo "   CHANGED         $row"
      else only=$((only+1)); echo "   ONLY IN ARCHIVE $row"; fi
    done < "$tmp/diff"
    echo "   summary: $(wc -l < "$tmp/arch") archived rows, $only only in archive (replay candidates), $changed changed since"
    rm -rf "$tmp"
  done
done
[ "$found" = 1 ] || echo "No *_divergent_* archive tables found on any node."
