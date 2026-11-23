// Jobs 1-4 on the v0.5 escrow predate the service's local job state. Their chain tx hashes were found once by scanning JobCreated/JobSubmitted/Verdict/Settled
// logs (indexed by jobId) from the escrow's deployment block (52030644); the verifier still checks every one of them against the chain.
// NOTE (0.5.30): these jobs are anchored on Concordium, so the service serves their frozen core (which has no tx hashes) and these hints are not used for them;
// the core cannot change without invalidating its anchor. The hashes are published on /trust instead. Kept for any unanchored re-build of these proofs.
// 0.5.33: the verifier's deployBlock for this escrow was wrong (57000000, after these jobs); fixed to 52030644, and the smoke-test spec/deliverable strings are recomputed by the verifier, so these jobs now verify.
export const LEGACY_JOB_HINTS = {
  "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D": {
    "1": {
      "fundTx": "0xcd87a26639dddbec1158a1a5b68c9217def880dbc1180c2fe13259e442719a18",
      "submitTx": "0xbcb9292234c1e24c870168871d9dc6534c1bad1a5094071a79be335c47a20b20",
      "verdictTx": "0xb7cb367d625110f1590fbd2cb81dc2cea24fd819a0a72e05ff82b405377a8982",
      "settleTx": "0x0f12ef62812419708362588128da9efd77bd59ed95e842cc2bac0c5a05de6d03"
    },
    "2": {
      "fundTx": "0xdf55b217a41701a19bb629f436c68efcf0ff7491a3a6e2c941d0d654e9cb8d4e",
      "submitTx": "0x74d4d47bd605facc419fc05b97a89f4255ca3b4594d66eca577fa891218fef51",
      "verdictTx": "0x017a93a803c18788c7ee5bfbd2477dd8609dc4de7d5103090ead5c33e9131dc3",
      "settleTx": "0x063498af8fdd49d192f6b79f1231a6fdc7eb94b6fb8218fee55af532cfaf760d"
    },
    "3": {
      "fundTx": "0x2c9d844000bb9276cdf05f6c1de1555670bde5dc78e822c5d03858979193e116",
      "submitTx": "0xf6f644a044be648aeeae7327451c6b1ea397b0ac14e58d21dbf349f82171cefa",
      "verdictTx": "0x886b1ac8d7ecc1d22dd5d6d56a0fe7439a450e8bcf6b84591339078d4381681f",
      "settleTx": "0xf1bdceec23fe2d4f93b73e8a285c95972166d10fc5f83fbe53d43304b74b0617"
    },
    "4": {
      "fundTx": "0x23cbc6ccc24143a4d5bbdb872d96c56a51332fa4e46a1ef970648ca5ceedc2e2",
      "submitTx": "0x2ab9d8648a111fc0e69391ef91bb9fe10b7d4c44e4b13ea3fa289167f44bab1f",
      "verdictTx": "0x87c436792ad6c9bfe5780df0aabdf81d2f151497af350cd1208f8cec1c3a5c1e",
      "settleTx": "0x52e3cdd1129564cdaa671d07c8771519c30577255d0e17b434483c3d39dee77d"
    }
  },
};
