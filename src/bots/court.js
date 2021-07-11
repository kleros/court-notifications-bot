const cuid = require("cuid");
const axios = require("axios");
const delay = require("delay");
const safeParse = require("../utils/safe-parse");
const mainLogger = require("../utils/logger");

const Period = {
  Evidence: 0,
  Commit: 1,
  Vote: 2,
  Appeal: 3,
  Execution: 4,
};

const DEFAULT_DELAY_AMOUNT = 5 * 60 * 1000; // 5 minutes
const delayAmount = safeParse.number(process.env.DELAY_AMOUNT) || DEFAULT_DELAY_AMOUNT;

module.exports = async (
  { web3, court, policyRegistry, mongoCollection, archon, webhookUrl },
  { logger = mainLogger.child({ executionId: cuid() }) } = {}
) => {
  // Get the lower-case address instead of the checksumed version
  const courtAddress = String(court.options.address).toLowerCase();

  // get our starting point
  let lastBlock = process.env.START_BLOCK;
  let currentBlock = process.env.START_BLOCK;
  let votingDisputes = [];
  const appState = await mongoCollection.findOne({ courtAddress });
  if (appState) {
    lastBlock = appState.lastBlock;
    votingDisputes = appState.votingDisputes || [];
  } else {
    // if starting from scratch we can go from the current block
    await mongoCollection.insertOne({ courtAddress, lastBlock: currentBlock });
  }
  votingDisputes = [...new Set(votingDisputes)];

  logger.info({ votingDisputes }, "Current voting disputes");

  while (true) {
    const internalLogger = logger.child({ logGroupId: cuid() });

    currentBlock = await web3.eth.getBlockNumber();

    const drawEvents = await getPastEvents(court, "Draw", {
      fromBlock: lastBlock,
      toBlock: "latest",
    });

    if (drawEvents.length) {
      const jurorsForDisputes = await getDrawnJurorsByDispute(drawEvents || []);
      for (const disputeID of Object.keys(jurorsForDisputes)) {
        for (const juror of jurorsForDisputes[disputeID]) {
          await notifyEvent({
            event: "Draw",
            _disputeID: disputeID,
            _appeal: juror.appeal,
            _address: juror.address,
          });
        }
      }
    }

    const newPeriods = await getPastEvents(court, "NewPeriod", {
      fromBlock: lastBlock,
      toBlock: "latest",
    });

    if (newPeriods.length) {
      for (const newPeriodEvent of newPeriods) {
        if (Number(newPeriodEvent.returnValues._period) === Period.Vote) {
          const disputeID = newPeriodEvent.returnValues._disputeID;
          const jurors = await getJurorsInCurrentRound(disputeID, court);
          for (const juror of jurors) {
            await notifyEvent({
              event: "Vote",
              _disputeID: disputeID,
              _address: juror.address,
            });
          }
          // add disputeID to list of disputes currently voting if not already there
          if (votingDisputes.indexOf(disputeID) === -1) {
            internalLogger.info({ disputeID }, "Found new dispute with voting ongoing");
            votingDisputes.push(disputeID);
          }
        } else if (Number(newPeriodEvent.returnValues._period) === Period.Appeal) {
          const disputeID = newPeriodEvent.returnValues._disputeID;
          const previousLength = votingDisputes.length;
          // remove disputeID from disputes currently voting
          votingDisputes = votingDisputes.filter((item) => item !== disputeID);

          if (votingDisputes.length !== previousLength) {
            internalLogger.info({ disputeID }, "Removed dispute from ongoing voting list");
          }
        }
      }

      await mongoCollection.findOneAndUpdate({ courtAddress }, { $set: { votingDisputes } }, { upsert: true });
    }

    for (const disputeID of votingDisputes) {
      const dispute = await court.methods.disputes(disputeID).call();
      const subcourt = await court.methods.getSubcourt(dispute.subcourtID).call();
      const now = new Date();
      const timeUntilNextPeriod = subcourt.timesPerPeriod[2] - (now.getTime() / 1000 - dispute.lastPeriodChange);
      // remind jurors
      if (timeUntilNextPeriod <= 86400 && timeUntilNextPeriod > 0) {
        const jurors = await getJurorsInCurrentRound(disputeID, court);
        for (const juror of jurors) {
          if (!juror.voted) {
            await notifyEvent({
              event: "VoteReminder",
              _disputeID: disputeID,
              _address: juror.address,
            });
          }
        }

        const previousLength = votingDisputes.length;
        votingDisputes = votingDisputes.filter((item) => item !== disputeID);

        if (votingDisputes.length !== previousLength) {
          internalLogger.info({ disputeID }, "Removed dispute from ongoing voting list");
        }

        await mongoCollection.findOneAndUpdate({ courtAddress }, { $set: { votingDisputes } }, { upsert: true });
      }
    }

    // let jurors know about an appeal
    const newAppeals = await getPastEvents(court, "AppealDecision", {
      fromBlock: lastBlock,
      toBlock: "latest",
    });

    for (const appeal of newAppeals) {
      const disputeID = appeal.returnValues._disputeID;
      const jurorsInLastRound = await getJurorsInCurrentRound(disputeID, court, true);
      for (const juror of jurorsInLastRound) {
        await notifyEvent({
          event: "Appeal",
          _disputeID: disputeID,
          _address: juror.address,
        });
      }
    }

    const newTokenShiftEvents = await getPastEvents(court, "TokenAndETHShift", {
      fromBlock: lastBlock,
      toBlock: "latest",
    });

    const tokenShiftsByDispute = formatTokenMovementEvents(newTokenShiftEvents, web3);
    for (const disputeID of Object.keys(tokenShiftsByDispute)) {
      for (const account of Object.keys(tokenShiftsByDispute[disputeID])) {
        const _dispute = await court.methods.disputes(disputeID).call();
        const disputeData = await archon.arbitrable.getDispute(_dispute.arbitrated, courtAddress, disputeID);
        const metaEvidence = await archon.arbitrable.getMetaEvidence(_dispute.arbitrated, disputeData.metaEvidenceID, {
          strictHashes: false,
        });
        if (tokenShiftsByDispute[disputeID][account].ethAmount > 0) {
          const ethWon = formatAmount(tokenShiftsByDispute[disputeID][account].ethAmount);
          const pnkWon = formatAmount(tokenShiftsByDispute[disputeID][account].pnkAmount);

          await notifyEvent({
            event: "Won",
            _disputeID: disputeID,
            _address: account,
            _ethWon: ethWon,
            _pnkWon: pnkWon,
            _caseTitle: metaEvidence.metaEvidenceJSON.title,
          });
        } else {
          // Lost the case
          console.log("SENDING PNK LOSS " + account + " IN CASE " + disputeID);
          const pnkLost = formatAmount(tokenShiftsByDispute[disputeID][account].pnkAmount);

          await notifyEvent({
            event: "Lost",
            _disputeID: disputeID,
            _address: account,
            _pnkLost: pnkLost,
            _caseTitle: metaEvidence.metaEvidenceJSON.title,
          });
        }
      }
    }

    // Staking
    const stakeEvents = await getPastEvents(court, "StakeSet", {
      fromBlock: lastBlock,
      toBlock: "latest",
    });
    if (stakeEvents.length) {
      const jurors = await getSetStakesForJuror(stakeEvents, policyRegistry, web3);
      for (const address of Object.keys(jurors)) {
        await notifyEvent({
          event: "StakeChanged",
          _address: address,
          _stakesChanged: jurors[address],
        });
      }
    }

    await mongoCollection.findOneAndUpdate({ courtAddress }, { $set: { lastBlock: currentBlock } }, { upsert: true });
    lastBlock = currentBlock + 1;
    await delay(delayAmount);

    // The functions bellow MUST be declared inside the loop because they close over
    // the `internalLogger` variable.
    async function getPastEvents(contract, event, { fromBlock, toBlock = "latest", filters }) {
      const requestId = cuid();

      internalLogger.info(
        {
          requestId,
          contract: contract.options.address,
          event,
          fromBlock,
          toBlock,
          filters,
        },
        "Fetching past events for contract"
      );

      try {
        const events = await contract.getPastEvents(event, { fromBlock, toBlock, filters });

        internalLogger.info(
          {
            requestId,
            contract: contract.options.address,
            event,
            fromBlock,
            toBlock,
            filters,
            count: events.length,
          },
          "Successfully fetched past events for contract"
        );

        return events;
      } catch (err) {
        internalLogger.error(
          {
            requestId,
            contract: contract.options.address,
            event,
            fromBlock,
            toBlock,
            filters,
            err,
          },
          "Failed to fetch past events for contract"
        );

        throw err;
      }
    }

    async function notifyEvent(params) {
      await delay(10000);
      const requestId = cuid();
      try {
        internalLogger.info({ requestId, webhookUrl, params }, "Submitting request to the webhook endpoint");
        const response = await axios.post(webhookUrl, params);
        internalLogger.info({ requestId }, "Successfully submited the request to the webhook");

        return response;
      } catch (err) {
        internalLogger.error({ requestId, err }, "Failed to call the webhook endpoint");
        throw err;
      }
    }
  }
};

/*
 *
 */
const getDrawnJurorsByDispute = (drawEvents) => {
  const disputes = {};
  for (let i = 0; i < drawEvents.length; i++) {
    const disputeID = drawEvents[i].returnValues._disputeID;
    if (!disputes[disputeID]) disputes[disputeID] = {};
    const juror = drawEvents[i].returnValues._address;
    disputes[disputeID][juror] = {
      numberOfVotes: disputes[disputeID][juror] ? disputes[disputeID][juror].numberOfVotes + 1 : 1,
      appeal: drawEvents[i].returnValues._appeal,
    };
  }

  const formattedDisputes = {};
  for (const key of Object.keys(disputes)) {
    formattedDisputes[key] = [];
    for (const address of Object.keys(disputes[key])) {
      formattedDisputes[key].push({
        address,
        numberOfVotes: disputes[key][address].numberOfVotes,
        appeal: disputes[key][address].appeal,
      });
    }
  }

  return formattedDisputes;
};

const getJurorsInCurrentRound = async (disputeID, courtInstance, _appeal = false) => {
  const dispute = await courtInstance.methods.getDispute(disputeID).call();
  const appeal = _appeal ? dispute[0].length - 2 : dispute[0].length - 1;
  const numberOfVotes = dispute[0][appeal];

  const seenJurors = {};
  for (let i = 0; i < parseInt(numberOfVotes); i++) {
    const vote = await courtInstance.methods.getVote(disputeID, appeal, i).call();
    // vote[0] == address, vote[3] == voted
    seenJurors[vote[0]] = vote[3];
  }

  const currentJurors = [];
  for (const address of Object.keys(seenJurors)) {
    currentJurors.push({
      address,
      voted: seenJurors[address],
    });
  }
  return currentJurors;
};

const formatTokenMovementEvents = (eventLogs, web3) => {
  const disputes = {};
  for (const log of eventLogs) {
    const disputeID = log.returnValues._disputeID;
    const address = log.returnValues._address;
    if (!disputes[disputeID]) disputes[disputeID] = {};
    if (!disputes[disputeID][address])
      disputes[disputeID][address] = {
        ethAmount: 0,
        pnkAmount: 0,
      };

    disputes[disputeID][address].ethAmount += Number(web3.utils.fromWei(log.returnValues._ETHAmount));
    disputes[disputeID][address].pnkAmount += Number(web3.utils.fromWei(log.returnValues._tokenAmount));
  }

  return disputes;
};

const formatAmount = (amount) => {
  const a = parseFloat(amount);
  if (a > 1) return Number(a.toFixed(2));
  else return Number(a.toFixed(4));
};

const getSetStakesForJuror = async (setStakeEvents, policyRegistryInstance, web3) => {
  const subcourtCache = {};
  const jurors = {};
  for (const log of setStakeEvents) {
    if (!jurors[log.returnValues._address]) jurors[log.returnValues._address] = {};
    let policy = subcourtCache[log.returnValues._subcourtID];
    if (!subcourtCache[log.returnValues._subcourtID]) {
      let uri = await policyRegistryInstance.methods.policies(log.returnValues._subcourtID).call();
      if (uri.substring(0, 6) === "/ipfs/") {
        uri = `https://ipfs.kleros.io${uri}`;
      }
      policy = (await axios.get(uri)).data;
      subcourtCache[log.returnValues._subcourtID] = policy;
    }

    // Take the most recent value for each subcourt
    jurors[log.returnValues._address][policy.name] = web3.utils.fromWei(log.returnValues._stake);
  }

  const formatted = {};
  for (const j of Object.keys(jurors)) {
    formatted[j] = [];
    for (const subcourtName of Object.keys(jurors[j])) {
      formatted[j].push({
        amount: jurors[j][subcourtName],
        subcourt: subcourtName,
      });
    }
  }

  return formatted;
};
