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


module.exports = async (web3, mongoClient, courtAddress) => {
  // Instantiate the contracts.
  const courtInstance = new web3.eth.Contract(
    _court.abi,
    courtAddress
  )

  // connect to the right collection
  await mongoClient.createCollection(COURT_MONGO_COLLECTION)
  const db = mongoClient.collection(COURT_MONGO_COLLECTION)

  // get our starting point
  let lastBlock = 10322792
  let currentBlock = 10322792
  let appState = await db.findOne({'courtAddress': courtAddress})
  if (appState) {
    lastBlock = appState.lastBlock
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
          const jurors = getJurorsInCurrentRound(disputeID, courtInstance)
        }
      }
    }
    // db.findOneAndUpdate({'proxyAddress': proxyAddress}, {$set: {lastBlock: currentBlock}}, { upsert: true })
    // lastBlock=currentBlock+1
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

const getJurorsInCurrentRound = async (disputeID, courtInstance) => {
  const dispute = await courtInstance.methods.getDispute(disputeID).call()
  const numberOfVotes = dispute[0][dispute[0].length - 1]

  const seenJurors = {}
  for (let i=0; i<parseInt(numberOfVotes); i++) {
    const vote = courtInstance.methods.getVote(disputeID, dispute[0].length - 1, i).call()
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
