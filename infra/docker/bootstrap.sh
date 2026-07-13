#!/usr/bin/env bash
# Mercurio dev bootstrap — idempotent (ADR-004).
# Mines initial blocks, funds the three user wallets and opens channels
# alice <-> bob <-> carol so hold-invoice flows can be exercised end-to-end.
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
for i in $(seq 1 60); do
  if channels_active lnd-alice 1 && channels_active lnd-bob 2 && channels_active lnd-carol 1; then
    echo "==> Done. alice (sender) <-> bob (carrier) <-> carol (hub) are connected and active."
    exit 0
  fi
  sleep 2
done
echo "ERROR: channels did not become active in time" >&2
exit 1
