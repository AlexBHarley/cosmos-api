import { getErrorMessage } from "scripts/sdk-errors"
import { createSignMessage, createSignature } from "./signature"

const DEFAULT_GAS_PRICE = (2.5e-8).toFixed(9)

export default async function send({ gas, gasPrice = DEFAULT_GAS_PRICE, memo = `` }, msg, senderAddress, signer, cosmosRESTURL, chainId, getters) {
  const { sequence, account_number } = await getters.account(senderAddress)

  // sign transaction
  const stdTx = createStdTx({ gas, gasPrice, memo }, msg)
  const signMessage = createSignMessage(stdTx, { sequence, account_number, chain_id: chainId })
  const { signature, publicKey } = await signer(signMessage)

  // broadcast transaction with signatures included
  const signatureObject = createSignature(signature, sequence, account_number, publicKey)
  const signedTx = createSignedTransaction(stdTx, signatureObject)
  const body = createBroadcastBody(signedTx, `sync`)
  const res = await fetch(`${cosmosRESTURL}/txs`, { method: `POST`, body })
    .then(res => res.json)
    .catch(handleSDKError)

  // check response code
  assertOk(res)

  // Sometimes we get back failed transactions, which shows only by them having a `code` property
  if (res.code) {
    // TODO get message from SDK: https://github.com/cosmos/cosmos-sdk/issues/4013
    throw new Error(`Error sending: ${getErrorMessage(Number(res.code))}`)
  }

  return {
    hash: res.txhash,
    sequence,
    included: () => queryTxInclusion(res.txhash, getters)
  }
}

// wait for inclusion of a tx in a block
// Default waiting time: 30 * 2s = 60s
export async function queryTxInclusion(txHash, getters, iterations = 30, timeout = 2000) {
  while (iterations-- > 0) {
    try {
      await getters.tx(txHash)
      break
    } catch (err) {
      // tx wasn't included in a block yet
      await new Promise(resolve =>
        setTimeout(resolve, timeout)
      )
    }
  }
  if (iterations <= 0) {
    throw new Error(`The transaction was still not included in a block. We can't say for certain it will be included in the future.`)
  }
}
// attaches the request meta data to the message
function createStdTx({ gas, gasPrice, memo }, msg) {
  return {
    msg,
    fee: {
      amount: [{ amount: gasPrice.amount * gas, denom: gasPrice.denom }],
      gas
    },
    signatures: null,
    memo
  }
}

// the broadcast body consists of the signed tx and a return type
// returnType can be block (inclusion in block), async (right away), sync (after checkTx has passed)
function createBroadcastBody(signedTx, returnType = `sync`) {
  return JSON.stringify({
    tx: signedTx,
    mode: returnType
  })
}

// adds the signature object to the tx
function createSignedTransaction(tx, signature) {
  return Object.assign({}, tx, {
    signatures: [signature]
  })
}

// beautify the errors returned from the SDK
function handleSDKError(err) {
  let message
  // TODO: get rid of this logic once the appended message is actually included inside the object message
  if (!err.message) {
    const idxColon = err.indexOf(`:`)
    const indexOpenBracket = err.indexOf(`{`)
    if (idxColon < indexOpenBracket) {
      // e.g => Msg 0 failed: {"codespace":4,"code":102,"abci_code":262246,"message":"existing unbonding delegation found"}
      message = JSON.parse(err.substr(idxColon + 1)).message
    } else {
      message = err
    }
  } else {
    message = err.message
  }
  throw new Error(message)
}

// assert that a transaction was sent successful
function assertOk(res) {
  if (Array.isArray(res)) {
    if (res.length === 0) throw new Error(`Error sending transaction`)

    return res.forEach(assertOk)
  }

  if (!res.txhash) {
    const message = res.message
    throw new Error(message)
  }
}