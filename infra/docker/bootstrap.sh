#!/usr/bin/env bash
# Mercurio dev bootstrap — idempotent (ADR-004).
# Mines initial blocks, funds the three user wallets and opens channels
# alice <-> bob <-> carol so hold-invoice flows can be exercised end-to-end.
set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/docker-compose.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
BTC="$COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=devuser -rpcpassword=devpass"

lncli() { # lncli <node> <args...>
  local node="$1"; shift
  $COMPOSE exec -T "$node" lncli --network=regtest "$@"
}

echo "==> Waiting for bitcoind..."
until $BTC getblockchaininfo >/dev/null 2>&1; do sleep 1; done

echo "==> Creating miner wallet and maturing coins..."
$BTC createwallet miner >/dev/null 2>&1 || true
MINER_ADDR=$($BTC -rpcwallet=miner getnewaddress)
BLOCKS=$($BTC getblockcount)
if [ "$BLOCKS" -lt 101 ]; then
  $BTC generatetoaddress 101 "$MINER_ADDR" >/dev/null
fi

for node in lnd-alice lnd-bob lnd-carol; do
  echo "==> Funding $node..."
  until lncli "$node" getinfo >/dev/null 2>&1; do sleep 1; done
  ADDR=$(lncli "$node" newaddress p2wkh | sed -n 's/.*"address": *"\([^"]*\)".*/\1/p')
  $BTC -rpcwallet=miner sendtoaddress "$ADDR" 1 >/dev/null
done
$BTC generatetoaddress 6 "$MINER_ADDR" >/dev/null

open_channel() { # open_channel <from> <to>
  local from="$1" to="$2"
  local to_pubkey to_ip
  to_pubkey=$(lncli "$to" getinfo | sed -n 's/.*"identity_pubkey": *"\([^"]*\)".*/\1/p')
  lncli "$from" connect "${to_pubkey}@${to}:9735" >/dev/null 2>&1 || true
  if ! lncli "$from" listchannels | grep -q "$to_pubkey"; then
    echo "==> Opening channel $from -> $to..."
    lncli "$from" openchannel --node_key="$to_pubkey" --local_amt=5000000 --push_amt=2000000 >/dev/null
  fi
}

open_channel lnd-alice lnd-bob
open_channel lnd-bob lnd-carol
$BTC generatetoaddress 6 "$MINER_ADDR" >/dev/null

echo "==> Done. alice (sender) <-> bob (carrier) <-> carol (hub) are connected."
