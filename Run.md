## start local wormhole environment
```
# start wormhole guardian relayer and two evm blockchains
tilt up --host=0.0.0.0 -- --evm2 --generic_relayer --guardiand_loglevel=info
```


## stop
```
tilt down --delete-namespaces
```

## deploy hello-wormhole contract

```
cd wormhloe-contract/hello-wormhole

EVM_PRIVATE_KEY=0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d npm run deploy

```

## run blockbench

```
python3 start_test.py start 1
```