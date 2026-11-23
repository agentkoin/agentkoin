// test/dry-run guard: any network call throws
globalThis.fetch = () => { throw new Error("network disabled in dry run"); };
