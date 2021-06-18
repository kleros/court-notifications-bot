const delay = require("delay");
const Web3 = require("web3");
const Archon = require("@kleros/archon");

const _mongoClient = require("./mongo-client");
const bot = require("./bots/court");

const _court = require("./contracts/court.json");
const _policyRegistry = require("./contracts/policy-registry.json");

mainnet();

const ipfsGateway = process.env.IPFS_GATEWAY || "https://ipfs.kleros.io";

async function mainnet() {
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL);
  const archon = new Archon(process.env.WEB3_PROVIDER_URL, ipfsGateway);
  const courtMongoCollection = process.env.COURT_MONGO_COLLECTION;

  const mongoClient = await _mongoClient();
  // connect to the right collection
  const mongoCollection = await mongoClient.createCollection(courtMongoCollection);

  run(bot, {
    archon,
    web3,
    mongoCollection,
    courtContracts: [new web3.eth.Contract(_court.abi, process.env.COURT_ADDRESS)],
    policyRegistryContracts: [new web3.eth.Contract(_policyRegistry.abi, process.env.POLICY_REGISTRY_ADDRESS)],
    webhookUrl: process.env.WEBHOOK_URL,
  });
}

// Run bots and restart them on failures.
async function run(bot, { web3, archon, courtContracts, policyRegistryContracts, mongoCollection, webhookUrl }) {
  // const privateKey = process.env.PRIVATE_KEY
  // const account = web3.eth.accounts.privateKeyToAccount(privateKey)
  // web3.eth.accounts.wallet.add(account)

  const botInstances = [];
  let shouldRun = true;
  while (shouldRun) {
    try {
      for (let i = 0; i < courtContracts.length; i++) {
        botInstances.push(
          bot({
            court: courtContracts[i],
            policyRegistry: policyRegistryContracts[i],
            web3,
            mongoCollection,
            archon,
            webhookUrl,
          })
        );
      }
      await Promise.all(botInstances);
    } catch (err) {
      console.error("Bot error: ", err);
      if (!process.env.AUTO_RESTART) {
        shouldRun = false;
      } else {
        await delay(30000);
      }
    }
  }
}
