const delay = require('delay')
const Web3 = require('web3')
const ZeroClientProvider = require('web3-provider-engine/zero')
const Archon = require('@kleros/archon')

const _mongoClient = require('./mongo-client')
const bots = [require('./bots/court')]

// Run bots and restart them on failures.
const run = async bot => {
  // Create an instance of `web3` for each bot.
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL)
  // const privateKey = process.env.PRIVATE_KEY
  // const account = web3.eth.accounts.privateKeyToAccount(privateKey)
  // web3.eth.accounts.wallet.add(account)
  const archon = new Archon(process.env.WEB3_PROVIDER_URL, 'https://ipfs.kleros.io')
  const mongoClient = await _mongoClient()
  const courtAddresses = [
    process.env.COURT_CONTRACT_ADDRESS,
  ]

  let bots = []
  while (true) {
    try {
      for (let i=0; i<courtAddresses.length; i++) {
        bots.push(bot(web3, mongoClient, courtAddresses[i], archon))
      }
      await Promise.all(bots)
    } catch (err) {
      console.error('Bot error: ', err)
    }
    await delay(10000) // Wait 10 seconds before restarting failed bot.
  }
}
bots.forEach(run)
