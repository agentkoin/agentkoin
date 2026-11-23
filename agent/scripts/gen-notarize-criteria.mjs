const sort=(v)=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const H="https://agentcoinhq.com";
const spec={
 specId:"agentkoin-notarize-binding-criteria/v1",
 testnet:true, realValue:false, chainId:84532, network:"Base Sepolia",
 appliesTo:{jobType:"notarize",escrows:{"0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D":"v0.5","0xd6E00d3419c16A3Bee1b8cc030a7062bF2014b2c":"v0.6"},usdc:"0x036CbD53842c5426634e7929541eC2318f3dCF7e"},
 scope:"Whether the notarize receipt, the on-chain job and the settlement are bound to each other, as recomputable from public data.",
 digestRule:"specDigest = sha256 over the exact bytes served at the spec URL, written as lowercase hex with a 0x prefix.",
 inputs:{
  jobId:"uint256 job id on the named escrow",
  escrow:"escrow contract address",
  proofUrl:H+"/v1/jobs/{jobId}/proof",
  receiptUrl:H+"/v1/notarize/{jobId} (JSON object; the receipt is its \"receipt\" field)",
  rpc:"any Base Sepolia (84532) JSON-RPC endpoint",
  tools:["npx @agentkoin/judge-kit@testnet verify {jobId}","viem or any EVM library","RFC 8785 JSON canonicalization","keccak256","EIP-191 signature recovery"]},
 checks:[
  {id:"job-onchain",inputs:["escrow","jobId"],recompute:"eth_getCode(escrow) and escrow.getJob(jobId) at the head block",pass:"code is non-empty and getJob(jobId).client is not the zero address"},
  {id:"deliverable-hash",inputs:["receiptUrl","escrow","jobId"],recompute:"fetch the receipt bytes, parse as JSON, canonicalize per RFC 8785, keccak256 the UTF-8 bytes",pass:"the computed hash equals getJob(jobId).deliverableHash",report:"computed hash and on-chain hash"},
  {id:"receipt-job-binding",inputs:["receiptUrl","escrow","jobId"],recompute:"read receipt fields jobId, client, chainId and settleTx",pass:"receipt.jobId equals jobId, receipt.chainId equals 84532, receipt.client equals getJob(jobId).client",report:"receipt values and on-chain values"},
  {id:"submit-binding",inputs:["escrow","jobId"],recompute:"find the JobSubmitted log for jobId after the fund transaction",pass:"the log deliverableHash equals getJob(jobId).deliverableHash and the log provider equals getJob(jobId).provider"},
  {id:"payment-flow",inputs:["escrow","jobId"],recompute:"read the fund transaction receipt: the JobCreated or JobFunded log for jobId and the USDC Transfer logs",pass:"USDC Transfer logs move value from the client, directly or through a deposit route, into the escrow; the amount equals getJob(jobId).amount",report:"fund tx hash, each Transfer from/to/value, the job amount"},
  {id:"verdict-signer",inputs:["escrow","jobId"],recompute:"find the Verdict log for jobId and read the sender of its transaction",pass:"the transaction sender equals getJob(jobId).evaluator; the log outcome and payoutBps equal the job's outcome and payoutBps",report:"recovered address (tx sender) and expected address (job evaluator)"},
  {id:"settlement",inputs:["escrow","jobId"],recompute:"find the Settled log for jobId",pass:"a Settled log exists after verdictAt plus the challenge window and its payoutBps equals getJob(jobId).payoutBps",report:"settle tx hash, block and payoutBps"},
  {id:"proof-signature",inputs:["proofUrl",H+"/.well-known/jwks.json"],recompute:"remove the signature field from the proof, canonicalize per RFC 8785, keccak256, recover the EIP-191 signer over the raw 32-byte digest",pass:"the recovered address equals signature.signer and equals the key published at /.well-known/jwks.json",report:"recovered address and expected address"}
 ],
 verdictFields:{
  required:["specId","specDigest","jobId","escrow","chainId","evaluator","verdict","checks","evaluatedAt"],
  verdictValues:["bind","no-bind"],
  checksItem:["id","status","expected","recomputed"],
  statusValues:["pass","fail","skip"],
  mustInclude:["recomputed deliverable hash","recovered signer address and expected signer address","settlement flow values: fund tx hash, transfers, Settled tx hash"],
  publication:"posted publicly",
  specDigestRule:"specDigest equals the sha256 of the served spec bytes; a verdict that omits it or cites another digest does not conform to this spec"},
 outOfScope:["whether the notarized content is true","whether the notarized content is good, useful or lawful","the identity or reputation of the client or provider","the quality of any deliverable beyond its hash binding","legal effect of a receipt","any mainnet or real-value transaction"],
 urls:{spec:H+"/specs/criteria/notarize-binding-v1.json",digestAlias:H+"/specs/criteria/notarize-binding-v1.sha256"}
};
process.stdout.write(JSON.stringify(sort(spec))+"\n");
