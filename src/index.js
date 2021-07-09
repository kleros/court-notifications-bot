const cuid = require("cuid");
const delay = require("delay");
const Web3 = require("web3");
const Archon = require("@kleros/archon");

const _mongoClient = require("./mongo-client");
const bot = require("./bots/court");
const { createContractsByChainId } = require("./contracts");
const safeParse = require("./utils/safe-parse");
const { ensureEnv } = require("./utils/safe-env");
const mainLogger = require("./utils/logger");

const ipfsGateway = process.env.IPFS_GATEWAY || "https://ipfs.kleros.io";
const chainId = safeParse.number(ensureEnv("CHAIN_ID"));

const DEFAULT_DELAY_AMOUNT = 5 * 60 * 1000; // 5 minutes
const delayAmount = safeParse.number(process.env.DELAY_AMOUNT, DEFAULT_DELAY_AMOUNT);

const autoRestart = safeParse.boolean(process.env.AUTO_RESTART, false);

start();

async function start() {
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL);
  const archon = new Archon(process.env.WEB3_PROVIDER_URL, ipfsGateway);
  const courtMongoCollection = process.env.COURT_MONGO_COLLECTION;

  const mongoClient = await _mongoClient();
  // connect to the right collection
  const mongoCollection = await mongoClient.createCollection(courtMongoCollection);

  run(bot, {
    chainId,
    archon,
    web3,
    mongoCollection,
    webhookUrl: process.env.WEBHOOK_URL,
    contracts: [createContractsByChainId[chainId](web3)],
  });
}

// Run bots and restart them on failures.
async function run(bot, { chainId, web3, archon, mongoCollection, webhookUrl, contracts }) {
  let isRunning = true;

  while (isRunning) {
    try {
      await Promise.all(
        contracts.map(async ({ court, policyRegistry }) => {
          const logger = mainLogger.child({ executionId: cuid() });
          logger.info(
            { chainId, court: court.options.address, policyRegistry: policyRegistry.options.address, webhookUrl },
            "Starting notificaiton bot for KlerosLiquid"
          );

          try {
            return bot({ court, policyRegistry, web3, mongoCollection, archon, webhookUrl }, { logger });
          } catch (err) {
            logger.error({ err }, "Something went wrong with the bot");
            throw err;
          }
        })
      );
    } catch (err) {
      if (autoRestart && delayAmount > 0) {
        await delay(delayAmount);
      } else {
        isRunning = false;
      }
    }
  }
}
