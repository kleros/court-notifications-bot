#!/usr/bin/env bash

function rpcLastBlock() #rpc
{
   local rpc="$1"
   block=$(curl -s "$rpc" \
       -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":"0"}' \
         | jq -r .result)
   echo $(( $(echo "$block" | jq -r .number) ))
   #echo $(( $(echo "$block" | jq -r .timestamp) ))
}

echo "mainnet"
source ./.env.mainnet
mongoLastBlock=$(mongo --quiet --eval 'db.court.find().forEach(r=>print(JSON.stringify(r)))' courtBlocks | jq -r .lastBlock)
rpcLastBlock=$(rpcLastBlock $WEB3_PROVIDER_URL)
lastRun=$(( (rpcLastBlock - mongoLastBlock) * 12 / 60 ))
echo "blockNumber from mongo: $mongoLastBlock"
echo "blockNumber from RPC: $rpcLastBlock"
echo "last run: $lastRun minutes ago"
echo
echo "xdai"
source ./.env.xdai
mongoLastBlock=$(mongo --quiet --eval 'db.xDaiCourt.find().forEach(r=>print(JSON.stringify(r)))' xDaiCourtBlocks | jq -r .lastBlock)
rpcLastBlock=$(rpcLastBlock $WEB3_PROVIDER_URL)
lastRun=$(( (rpcLastBlock - mongoLastBlock) * 12 / 60 ))
echo "blockNumber from mongo: $mongoLastBlock"
echo "blockNumber from RPC: $rpcLastBlock"
echo "last run: $lastRun minutes ago"
