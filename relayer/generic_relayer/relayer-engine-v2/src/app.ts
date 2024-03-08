import Koa from "koa";
import Router from "koa-router";
import * as wh from "@certusone/wormhole-sdk";
import {
  Next,
  RelayerApp,
  StandardRelayerAppOpts,
  StandardRelayerContext,
  logging,
  wallets,
  missedVaas,
  providers,
  sourceTx,
  sleep,
  ParsedVaaWithBytes
} from "relayer-engine";
import { BigNumber, ethers } from "ethers";
import {
  VaaKeyType,
  RelayerPayloadId,
  parseWormholeRelayerPayloadType,
  parseWormholeRelayerSend,
  deliveryInstructionsPrintable,
  vaaKeyPrintable,
  parseWormholeRelayerResend,
  RedeliveryInstruction,
  DeliveryInstruction,
  packOverrides,
  DeliveryOverrideArgs,
  parseEVMExecutionInfoV1,
  
} from "@certusone/wormhole-sdk/lib/cjs/relayer";
import { RedisStorage } from "relayer-engine/lib/storage/redis-storage";
import { CHAIN_ID_BSC, CHAIN_ID_ETH, EVMChainId } from "@certusone/wormhole-sdk";
import { WormholeRelayer__factory } from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import { processGenericRelayerVaa } from "./processor";
import { Logger } from "winston";
import deepCopy from "clone";
import { loadAppConfig } from "./env";

import {
  DeliveryExecutionRecord,
  addFatalError,
  deliveryExecutionRecordPrintable,
} from "./executionRecord";

export type GRContext = StandardRelayerContext & {
  deliveryProviders: Record<EVMChainId, string>;
  wormholeRelayers: Record<EVMChainId, string>;
  opts: StandardRelayerAppOpts;
};

async function main() {
  const { env, opts, deliveryProviders, wormholeRelayers } = await loadAppConfig();
  const logger = opts.logger!;
  logger.info("Starting relayer with env: ", env);
  logger.info("Starting relayer with config: ", opts);
  logger.debug("Delivery providers: ", deliveryProviders);
  logger.debug("Wormhole relayers: ", wormholeRelayers);
  logger.debug("Redis config: ", opts.redis);

  const app = new RelayerApp<GRContext>(env, opts);
  const {
    privateKeys,
    name,
    spyEndpoint,
    redis,
    redisCluster,
    redisClusterEndpoints,
    wormholeRpcs,
  } = opts;
  const store = new RedisStorage({
    redis,
    redisClusterEndpoints,
    redisCluster,
    attempts: opts.workflows?.retries ?? 3,
    namespace: name,
    queueName: `${name}-relays`,
  });
  app.spy(spyEndpoint);
  app.useStorage(store);
  app.logger(logger);
  app.use(logging(logger));
  app.use(
    missedVaas(app, {
      namespace: name,
      logger,
      redis,
      redisCluster,
      redisClusterEndpoints,
      wormholeRpcs,
    })
  );
  app.use(providers(opts.providers));
  if (opts.privateKeys && Object.keys(opts.privateKeys).length) {
    app.use(
      wallets(env, {
        logger,
        namespace: name,
        privateKeys: privateKeys!,
        metrics: { registry: store.registry},
      })
    );
  }
  if (opts.fetchSourceTxhash) {
    app.use(sourceTx());
  }
  const provider = new ethers.providers.JsonRpcProvider("http://eth-devnet2:8545/");
  const privateKey = "6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1";
  const wallet = new ethers.Wallet(privateKey, provider);
  const basenonce = await wallet.getTransactionCount();
  console.log(`basenonce: ${basenonce}`);
  // Set up middleware
  app.use(async (ctx: GRContext, next: Next) => {
    ctx.deliveryProviders = deepCopy(deliveryProviders);
    ctx.wormholeRelayers = deepCopy(wormholeRelayers);
    ctx.opts = { ...opts };
    next();
  });
  let start = Date.now();

  // get base nonce of the relayer wallet 
  // // Set up routes
  // app.multiple(deepCopy(wormholeRelayers), processGenericRelayerVaa);
  app.chain(CHAIN_ID_ETH).address(
    // emitter address on Solana
    "0x53855d4b64e9a3cf59a84bc768ada716b5536bc5",
     
    // callback function to invoke on new message
    async (ctx, next) => {
  
      const executionRecord: DeliveryExecutionRecord = {};
      executionRecord.executionStartTime = Date.now();
      ctx.logger.info(`Processing generic relayer vaa`);

      executionRecord.rawVaaHex = ctx.vaaBytes!.toString("hex");
      executionRecord.rawVaaPayloadHex = ctx.vaa!.payload.toString("hex");
  
      const payloadId = parseWormholeRelayerPayloadType(ctx.vaa!.payload);
  
      executionRecord.payloadType = RelayerPayloadId[payloadId];
      const vaa = ctx.vaa;
      executionRecord.nonce = basenonce + Number(vaa.sequence);
      const deliveryVaa = parseWormholeRelayerSend(ctx.vaa!.payload);
      executionRecord.didParse = true;
      processDeliveryInstruction(ctx, deliveryVaa, ctx.vaaBytes!, executionRecord);
    }
  );
  app.listen();
  //runApi(store, opts, logger);
}

async function processDeliveryInstruction(
  ctx: GRContext,
  delivery: DeliveryInstruction,
  deliveryVaa: Buffer | Uint8Array,
  executionRecord: DeliveryExecutionRecord,
  overrides?: DeliveryOverrideArgs
) {

  const vaaIds = delivery.vaaKeys.map((m) => ({
    emitterAddress: m.emitterAddress!,
    emitterChain: m.chainId! as wh.ChainId,
    sequence: m.sequence!.toBigInt(),
  }));

  let results: ParsedVaaWithBytes[];
  results = await ctx.fetchVaas({
    ids: vaaIds,
    // txHash: ctx.sourceTxHash,
  });

  ctx.logger.debug(`Processing delivery`, {
    deliveryVaa: deliveryInstructionsPrintable(delivery),
  });
  // const chainId = assertEvmChainId(ix.targetChain)
  const chainId = delivery.targetChainId as EVMChainId;
  // const receiverValue = overrides?.newReceiverValue
  //   ? overrides.newReceiverValue
  //   : delivery.requestedReceiverValue.add(delivery.extraReceiverValue);
  // const getMaxRefund = (encodedDeliveryInfo: Buffer) => {
  //   const [deliveryInfo] = parseEVMExecutionInfoV1(encodedDeliveryInfo, 0);
  //   return deliveryInfo.targetChainRefundPerGasUnused.mul(
  //     deliveryInfo.gasLimit
  //   );
  // };
  // const maxRefund = getMaxRefund(
  //   overrides?.newExecutionInfo
  //     ? overrides.newExecutionInfo
  //     : delivery.encodedExecutionInfo
  // );
  const budget = BigInt("14285714285700000");
  console.log(`budget: ${budget}`);
  try {
    await ctx.wallets.onEVM(chainId, async ({ wallet }) => {
      const wormholeRelayer = WormholeRelayer__factory.connect(
        ctx.wormholeRelayers[chainId],
        wallet
      );
    const gasUnitsEstimate = BigNumber.from(183086);
     const gasPrice = ethers.utils.parseUnits("1000000000", "wei"); 
     console.log(`gasPrice: ${gasPrice}`);
      console.log(`gasUnitsEstimate: ${gasUnitsEstimate}`);
      const estimatedTransactionFee = gasPrice.mul(gasUnitsEstimate);
      const estimatedTransactionFeeEther = ethers.utils.formatEther(
        estimatedTransactionFee
      );

      ctx.logger.info(
        `Estimated transaction cost (ether): ${estimatedTransactionFeeEther}`,
        {
          gasUnitsEstimate: gasUnitsEstimate.toString(),
          gasPrice: gasPrice.toString(),
          estimatedTransactionFee: estimatedTransactionFee.toString(),
          estimatedTransactionFeeEther,
          valueEther: ethers.utils.formatEther(budget),
        }
      );
      process.stdout.write("");
      //await sleep(100);
      ctx.logger.debug("Sending 'deliver' tx...");

      // executionRecord.deliveryRecord!.transactionSubmitTimeStart = Date.now();
      const receipt =  wormholeRelayer
        .deliver(
          results.map((v) => v.bytes),
          deliveryVaa,
          wallet.address,
          overrides ? packOverrides(overrides) : [],
          {
            value: budget,
            gasLimit: 3000000,
            nonce: executionRecord.nonce,
          }
        ) //TODO more intelligent gas limit
        .then((x: any) => x.wait());
      // executionRecord.deliveryRecord!.transactionSubmitTimeEnd = Date.now();
      // executionRecord.deliveryRecord!.transactionDidSubmit = true;
      // executionRecord.deliveryRecord!.transactionHashes = [
      //   receipt.transactionHash,
      // ];

     // logResults(ctx, receipt, chainId);
    });
  } catch (e: any) {
    ctx.logger.error(`Fatal error in processGenericRelayerVaa: ${e}`);
    addFatalError(executionRecord, e);
    ctx.logger.error("Dumping execution context for fatal error");
    ctx.logger.error(deliveryExecutionRecordPrintable(executionRecord));
  }
}
function logResults(
  ctx: GRContext,
  receipt: ethers.ContractReceipt,
  chainId: EVMChainId,
) {
  const relayerContractLog = receipt.logs?.find((x: any) => {
    return x.address === ctx.wormholeRelayers[chainId];
  });
  if (relayerContractLog) {
    const parsedLog = WormholeRelayer__factory.createInterface().parseLog(
      relayerContractLog!
    );
    console.log(`parsedLog: ${parsedLog}`);
    const logArgs = {
      recipientAddress: parsedLog.args[0],
      sourceChain: parsedLog.args[1],
      sourceSequence: parsedLog.args[2],
      vaaHash: parsedLog.args[3],
      status: parsedLog.args[4],
    };
    ctx.logger.info("Parsed Delivery event", logArgs);
    switch (logArgs.status) {
      case 0:
        ctx.logger.info("Delivery Success");
        break;
      case 1:
        ctx.logger.info("Receiver Failure");
        break;
      case 2:
        ctx.logger.info("Forwarding Failure");
        break;
    }
  }
  ctx.logger.info(
    `Relayed instruction to chain ${chainId}, tx hash: ${receipt.transactionHash}`
  );
}

function runApi(storage: RedisStorage, { port, redis }: any, logger: Logger) {
  const app = new Koa();
  const router = new Router();

  router.get("/metrics", async (ctx: Koa.Context) => {
    ctx.body = await storage.registry?.metrics();
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  if (redis?.host) {
    app.use(storage.storageKoaUI("/ui"));
  }

  port = Number(port) || 3000;
  app.listen(port, () => {
    logger.info(`Running on ${port}...`);
    logger.info(`For the UI, open http://localhost:${port}/ui`);
    logger.info(
      `For prometheus metrics, open http://localhost:${port}/metrics`
    );
    logger.info("Make sure Redis is running on port 6379 by default");
  });
}

main().catch((e) => {
  console.error("Encountered unrecoverable error:");
  console.error(e);
  process.exit(1);
});
