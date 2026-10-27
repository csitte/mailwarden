/** State of the in-memory keystore that test/setup.ts puts in place of src/keystore-io.ts. */
export interface FakeKeyStore {
  mode: "ok" | "unavailable" | "set-fails" | "get-fails";
  entries: Map<string, Buffer>;
  calls: string[];
}

export function fakeKeyStore(): FakeKeyStore {
  return (globalThis as { __mwKeystore?: FakeKeyStore }).__mwKeystore!;
}

export function resetFakeKeyStore(): FakeKeyStore {
  const ks = fakeKeyStore();
  ks.mode = "ok";
  ks.entries.clear();
  ks.calls.length = 0;
  return ks;
}
