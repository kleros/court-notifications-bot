const fs = require('fs')
const axios = require('axios')
const delay = require('delay')

const _court = require('../contracts/court.json')

const COURT_MONGO_COLLECTION = 'court'
const IPFS_URL = 'https://ipfs.kleros.io'

const PERIODS = {
    "EVIDENCE": 0,
    "COMMIT": 1,
    "VOTE": 2,
    "APPEAL": 3,
    "EXECUTION": 4
}


module.exports = async (web3, mongoClient, courtAddress, archon) => {
  // Instantiate the contracts.
  const courtInstance = new web3.eth.Contract(
    _court.abi,
    courtAddress
  )

  // connect to the right collection
  await mongoClient.createCollection(COURT_MONGO_COLLECTION)
  const db = mongoClient.collection(COURT_MONGO_COLLECTION)

  // get our starting point
  let lastBlock = process.env.START_BLOCK
  let currentBlock = process.env.START_BLOCK
  let votingDisputes = []
  let appState = await db.findOne({'courtAddress': courtAddress})
  if (appState) {
    lastBlock = appState.lastBlock
    votingDisputes = appState.votingDisputes || []
  }
  else {
    // if starting from scratch we can go from the current block
    await db.insertOne({'courtAddress': courtAddress, 'lastBlock': currentBlock})
  }

  while (true) {
    await delay(process.env.DELAY_AMOUNT)
    currentBlock = await web3.eth.getBlockNumber()
    const drawEvents = await courtInstance.getPastEvents('Draw', {
      fromBlock: lastBlock,
      toBlock: 'latest'
    })

    if (drawEvents.length) {
      const jurorsForDisputes = await getDrawnJurorsByDispute(drawEvents || [])
      for (let disputeID of Object.keys(jurorsForDisputes)) {
        for (let juror of jurorsForDisputes[disputeID]) {
          const address = juror.address
          await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
            {
                "event": "Draw",
                "_disputeID": disputeID,
                "_appeal": juror.appeal,
                "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67'
            }
          )
        }
      }
    }

    const newPeriods = await courtInstance.getPastEvents('NewPeriod', {
      fromBlock: lastBlock,
      toBlock: 'latest'
    })

    if (newPeriods.length) {
      for (let newPeriodEvent of newPeriods) {
        if (newPeriodEvent.returnValues._period == PERIODS['VOTE']) {
          const disputeID = newPeriodEvent.returnValues._disputeID
          const jurors = await getJurorsInCurrentRound(disputeID, courtInstance)
          for (let juror of jurors) {
            await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
              {
                  "event": "Vote",
                  "_disputeID": disputeID,
                  "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67'
              }
            )
          }
          // add disputeID to list of disputes currently voting
          votingDisputes.push(disputeID)
        } else if (newPeriodEvent.returnValues._period == PERIODS['APPEAL']) {
          const disputeID = newPeriodEvent.returnValues._disputeID
          // remove disputeID from disputes currently voting
          votingDisputes = votingDisputes.filter(item => item !== disputeID)
        }
      }
      db.findOneAndUpdate({'courtAddress': courtAddress}, {$set: {votingDisputes: votingDisputes}}, { upsert: true })
    }

    for (let disputeID of votingDisputes) {
      const subcourt = await courtInstance.methods.getSubcourt(disputeID).call()
      const dispute = await courtInstance.methods.disputes(disputeID).call()
      const now = new Date()
      const timeUntilNextPeriod = subcourt.timesPerPeriod[2] - (now.getTime() - (dispute.lastPeriodChange * 1000))

      // remind jurors
      if (timeUntilNextPeriod <= 86400) {
        const jurors = await getJurorsInCurrentRound(disputeID, courtInstance)
        console.log('sending VOTE REMINDER emails')
        for (let juror of jurors) {
          if (!juror.voted) {
            await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
              {
                  "event": "VoteReminder",
                  "_disputeID": disputeID,
                  "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67'
              }
            )
          }
        }
        votingDisputes = votingDisputes.filter(item => item !== disputeID)
        db.findOneAndUpdate({'courtAddress': courtAddress}, {$set: {votingDisputes: votingDisputes}}, { upsert: true })
      }
    }

    // let jurors know about an appeal
    const newAppeals = await courtInstance.getPastEvents('AppealDecision', {
      fromBlock: lastBlock,
      toBlock: 'latest'
    })

    for (let appeal of newAppeals) {
      jurorsInLastRound = await getJurorsInCurrentRound(appeal.returnValues._disputeID, courtInstance, true)
      console.log('sending APPEAL emails')
      for (let juror of jurorsInLastRound) {
        await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
          {
              "event": "Appeal",
              "_disputeID": appeal.returnValues._disputeID,
              "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67'
          }
        )
      }
    }

    const newTokenShiftEvents = await courtInstance.getPastEvents('TokenAndETHShift', {
      fromBlock: lastBlock,
      toBlock: 'latest'
    })

    const tokenShiftsByDispute = formatTokenMovementEvents(newTokenShiftEvents, web3)
    for (let disputeID of Object.keys(tokenShiftsByDispute)) {
      for (let account of Object.keys(tokenShiftsByDispute[disputeID])) {
        const _dispute = await courtInstance.methods.disputes(disputeID).call()
        const disputeData = await archon.arbitrable.getDispute(
          _dispute.arbitrated,
          courtAddress,
          disputeID
        )
        const metaEvidence = await archon.arbitrable.getMetaEvidence(
          _dispute.arbitrated,
          disputeData.metaEvidenceID,
          {
            strictHashes: false
          }
        )
        if (tokenShiftsByDispute[disputeID][account].ethAmount > 0) {
          // Won the case
          await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
            {
                "event": "Won",
                "_disputeID": disputeID,
                "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67',
                "_ethWon": tokenShiftsByDispute[disputeID][account].ethAmount,
                "_pnkWon": tokenShiftsByDispute[disputeID][account].pnkAmount,
                "_caseTitle": metaEvidence.metaEvidenceJSON.title
            }
          )
        } else {
          // Lost the case
          await axios.post('https://iu6s7cave4.execute-api.us-east-2.amazonaws.com/production/event-handler-court-emails',
            {
                "event": "Lost",
                "_disputeID": disputeID,
                "_address": '0x27fE00A5a1212e9294b641BA860a383783016C67',
                "_pnkLost": tokenShiftsByDispute[disputeID][account].pnkAmount,
                "_caseTitle": metaEvidence.metaEvidenceJSON.title
            }
          )
        }
      }
    }

    db.findOneAndUpdate({'courtAddress': courtAddress}, {$set: {lastBlock: currentBlock}}, { upsert: true })
    lastBlock=currentBlock+1
  }
}

/*
 *
 */
const getDrawnJurorsByDispute = (drawEvents) => {
  const disputes = {}
  for (let i=0; i<drawEvents.length; i++) {
    const disputeID = drawEvents[i].returnValues._disputeID
    if (!disputes[disputeID])
      disputes[disputeID] = {}
    juror = drawEvents[i].returnValues._address
    disputes[disputeID][juror] = {
      "numberOfVotes": disputes[disputeID][juror] ? disputes[disputeID][juror].numberOfVotes + 1 : 1,
      "appeal": drawEvents[i].returnValues._appeal
    }
  }

  formattedDisputes = {}
  for (let key of Object.keys(disputes)) {
    formattedDisputes[key] = []
    for (let address of Object.keys(disputes[key])) {
      formattedDisputes[key].push({
        address,
        numberOfVotes: disputes[key][address]['numberOfVotes'],
        appeal: disputes[key][address]['appeal']
      })
    }
  }

  return formattedDisputes
}

const getJurorsInCurrentRound = async (disputeID, courtInstance, _appeal=false) => {
  const dispute = await courtInstance.methods.getDispute(disputeID).call()
  const appeal = _appeal ? dispute[0].length - 2 : dispute[0].length - 1
  const numberOfVotes = dispute[0][appeal]

  const seenJurors = {}
  for (let i=0; i<parseInt(numberOfVotes); i++) {
    const vote = courtInstance.methods.getVote(disputeID, appeal, i).call()
    // vote[0] == address, vote[3] == voted
    seenJurors[vote[0]] = vote[3]
  }

  const currentJurors = []
  for (let address of Object.keys(seenJurors)) {
    currentJurors.push({
      address,
      voted: seenJurors[address]
    })
  }
  return currentJurors
}

const formatTokenMovementEvents = (eventLogs, web3) => {
  const disputes = {}
  for (log of eventLogs) {
    const disputeID = log.returnValues._disputeID
    const address = log.returnValues._address
    if (!disputes[disputeID]) disputes[disputeID] = {}
    if (!disputes[disputeID][address]) disputes[disputeID][address] = {
      ethAmount: 0,
      pnkAmount: 0
    }

    disputes[disputeID][address].ethAmount += web3.utils.fromWei(log.returnValues._ETHAmount).substr(1)
    disputes[disputeID][address].pnkAmount += web3.utils.fromWei(log.returnValues._tokenAmount).substr(1)
  }

  return disputes
}
