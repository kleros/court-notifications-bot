const _court = require("./court.json");
const _xDaiCourt = require("./xdai-court.json");
const _policyRegistry = require("./policy-registry.json");
const { ensureEnv } = require("../utils/safe-env");

module.exports = {
  createContractsByChainId: {
    1: (web3) => ({
      court: new web3.eth.Contract(_court.abi, ensureEnv("COURT_ADDRESS")),
      policyRegistry: new web3.eth.Contract(_policyRegistry.abi, ensureEnv("POLICY_REGISTRY_ADDRESS")),
    }),
    100: (web3) => ({
      court: new web3.eth.Contract(_xDaiCourt.abi, ensureEnv("COURT_ADDRESS")),
      policyRegistry: new web3.eth.Contract(_policyRegistry.abi, ensureEnv("POLICY_REGISTRY_ADDRESS")),
    }),
  },
};
