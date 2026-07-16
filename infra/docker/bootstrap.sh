#!/usr/bin/env bash
# Mercurio dev bootstrap — idempotent (ADR-004, ADR-019).
# Mines initial blocks, funds the three user wallets and opens channels
# alice <-> bob <-> carol so hold-invoice flows can be exercised end-to-end.
# Then sets up the two Alby Hub NWC wallet services headlessly and writes
# their connection strings to volumes/nwc/ for the NWC integration suite.
set -euo pipefail

# Git Bash (MSYS) on Windows rewrites arguments that look like absolute paths
# (--lnddir=/home/lnd/.lnd -> C:/Program Files/Git/home/...): disable the
# conversion so container paths reach docker exec untouched. No-op on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

COMPOSE_FILE="$(dirname "$0")/docker-compose.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
BTC="$COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=devuser -rpcpassword=devpass"

# The polar images run lnd with --lnddir under /home/lnd, while `docker exec`
# lands in root's home: point lncli at the right dir or it can't find the TLS
# cert/macaroon and getinfo never succeeds.
lncli() { # lncli <node> <args...>
  local node="$1"; shift
  $COMPOSE exec -T "$node" lncli --network=regtest --lnddir=/home/lnd/.lnd "$@"
}

echo "==> Waiting for bitcoind..."
until $BTC getblockchaininfo >/dev/null 2>&1; do sleep 1; done

echo "==> Creating miner wallet and maturing coins..."
# createwallet fails if it exists, loadwallet if it's already loaded: either
# way one of the two succeeds and the miner wallet is usable afterwards.
$BTC createwallet miner >/dev/null 2>&1 || $BTC loadwallet miner >/dev/null 2>&1 || true
MINER_ADDR=$($BTC -rpcwallet=miner getnewaddress)
BLOCKS=$($BTC getblockcount)
if [ "$BLOCKS" -lt 101 ]; then
  $BTC generatetoaddress 101 "$MINER_ADDR" >/dev/null
fi

wait_synced() { # wait_synced <node> — RPC up AND caught up with the chain
  local node="$1"
  until lncli "$node" getinfo 2>/dev/null | grep -q '"synced_to_chain": *true'; do
    sleep 1
  done
}

for node in lnd-alice lnd-bob lnd-carol; do
  echo "==> Funding $node..."
  wait_synced "$node"
  # walletbalance repeats confirmed_balance inside account_balance: first hit only.
  BALANCE=$(lncli "$node" walletbalance | sed -n 's/.*"confirmed_balance": *"\([0-9]*\)".*/\1/p' | head -n1)
  if [ "${BALANCE:-0}" -gt 0 ]; then
    echo "    already funded (${BALANCE} sat)"
    continue
  fi
  ADDR=$(lncli "$node" newaddress p2wkh | sed -n 's/.*"address": *"\([^"]*\)".*/\1/p')
  $BTC -rpcwallet=miner sendtoaddress "$ADDR" 1 >/dev/null
done
$BTC generatetoaddress 6 "$MINER_ADDR" >/dev/null

open_channel() { # open_channel <from> <to>
  local from="$1" to="$2"
  local to_pubkey attempt
  to_pubkey=$(lncli "$to" getinfo | sed -n 's/.*"identity_pubkey": *"\([^"]*\)".*/\1/p')
  if lncli "$from" listchannels | grep -q "$to_pubkey"; then
    return 0
  fi
  echo "==> Opening channel $from -> $to..."
  wait_synced "$from"
  # connect + openchannel can race lnd's startup (graph/peer handshakes):
  # retry a few times instead of failing the whole bootstrap on a hiccup.
  for attempt in 1 2 3 4 5; do
    lncli "$from" connect "${to_pubkey}@${to}:9735" >/dev/null 2>&1 || true
    if lncli "$from" openchannel --node_key="$to_pubkey" --local_amt=5000000 --push_amt=2000000 >/dev/null 2>&1; then
      return 0
    fi
    echo "    openchannel attempt $attempt failed, retrying..."
    sleep 3
  done
  echo "ERROR: could not open channel $from -> $to" >&2
  return 1
}

open_channel lnd-alice lnd-bob
open_channel lnd-bob lnd-carol
$BTC generatetoaddress 6 "$MINER_ADDR" >/dev/null

echo "==> Waiting for channels to become active..."
channels_active() { # channels_active <node> <n> — node has >= n active channels
  local node="$1" want="$2" have
  have=$(lncli "$node" listchannels | grep -c '"active": *true' || true)
  [ "$have" -ge "$want" ]
}
channels_ok=0
for i in $(seq 1 60); do
  if channels_active lnd-alice 1 && channels_active lnd-bob 2 && channels_active lnd-carol 1; then
    channels_ok=1
    break
  fi
  sleep 2
done
if [ "$channels_ok" -ne 1 ]; then
  echo "ERROR: channels did not become active in time" >&2
  exit 1
fi
echo "==> Channels active: alice (sender) <-> bob (carrier) <-> carol (hub)."

# --- NWC wallet services: Alby Hub on top of alice and bob (ADR-019 §7) -----
#
# Headless one-time setup over Alby Hub's HTTP API (the backend config comes
# from env in docker-compose.yml; /api/setup only stores the unlock password
# — it updates non-empty values only, so it cannot clobber the env-derived
# LND settings). Each hub gets one NWC connection ("app") whose pairing URI
# lands in volumes/nwc/<user>.nwc for the integration suite to read. The
# whole volumes/ tree is gitignored runtime data, and every credential here
# is a regtest fixture anyway (CLAUDE.md: no secrets in the repo).

HUB_PASSWORD=mercurio-regtest
NWC_DIR="$(dirname "$0")/volumes/nwc"
mkdir -p "$NWC_DIR"

json_str() { # json_str <key> — first string value of "key" from stdin JSON
  # Go's JSON encoder HTML-escapes ampersands as "backslash-u0026" inside
  # strings; it matters here because NWC pairing URIs carry query
  # parameters — undo it.
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -n1 | sed 's/\\u0026/\&/g'
}

hub_api() { # hub_api <port> <method> <path> [json-body] [bearer-token]
  local port="$1" method="$2" path="$3" body="${4:-}" token="${5:-}"
  local -a extra=()
  [ -n "$body" ] && extra+=(-d "$body")
  [ -n "$token" ] && extra+=(-H "Authorization: Bearer $token")
  curl -sf -X "$method" "http://127.0.0.1:${port}/api${path}" \
    -H 'Content-Type: application/json' "${extra[@]}"
}

setup_hub() { # setup_hub <service> <host-port> <out-file>
  local name="$1" port="$2" out="$3" token pairing

  # The pairing URI and the hub's own state live under the same volumes/
  # tree: they exist (or get wiped) together, so the file alone is a safe
  # idempotency marker.
  if [ -s "$out" ]; then
    echo "==> $name: NWC connection already provisioned ($(basename "$out"))"
    return 0
  fi

  echo "==> Waiting for $name..."
  until hub_api "$port" GET /info >/dev/null 2>&1; do sleep 1; done

  if hub_api "$port" GET /info | grep -q '"setupCompleted": *false'; then
    echo "==> $name: one-time setup..."
    hub_api "$port" POST /setup \
      "{\"backendType\":\"LND\",\"unlockPassword\":\"$HUB_PASSWORD\"}" >/dev/null
    hub_api "$port" POST /start "{\"unlockPassword\":\"$HUB_PASSWORD\"}" >/dev/null
  fi

  echo "==> $name: waiting for the wallet service to be running..."
  until hub_api "$port" GET /info | grep -q '"running": *true'; do sleep 1; done

  token=$(hub_api "$port" POST /unlock \
    "{\"unlockPassword\":\"$HUB_PASSWORD\",\"permission\":\"full\"}" | json_str token)
  if [ -z "$token" ]; then
    echo "ERROR: $name: could not obtain an API token" >&2
    return 1
  fi

  # A timestamped name sidesteps collisions if the URI file was lost while
  # the hub kept its state (names are the only uniqueness handle we rely on).
  # make_invoice is the scope that carries the three hold-invoice methods.
  echo "==> $name: creating the NWC connection..."
  pairing=$(hub_api "$port" POST /apps "{
    \"name\": \"mercurio-itest-$(date +%s)\",
    \"scopes\": [\"pay_invoice\", \"make_invoice\", \"lookup_invoice\",
                  \"get_balance\", \"get_info\", \"list_transactions\", \"notifications\"],
    \"budgetRenewal\": \"never\",
    \"isolated\": false
  }" "$token" | json_str pairingUri)
  if [ -z "$pairing" ]; then
    echo "ERROR: $name: app creation returned no pairingUri" >&2
    return 1
  fi
  printf '%s\n' "$pairing" > "$out"
  echo "    connection string written to $(basename "$out")"
}

setup_hub albyhub-alice 8091 "$NWC_DIR/alice.nwc"
setup_hub albyhub-bob 8092 "$NWC_DIR/bob.nwc"

echo "==> Done. LND regtest + NWC wallet services are ready."
