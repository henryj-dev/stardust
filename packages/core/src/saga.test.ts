import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineSaga, runSaga, type SagaStep, startSaga } from "./saga.ts";
import { guardStoreContract, MemoryGuardStore, MemorySagaStore, sagaStoreContract } from "./testing.ts";

sagaStoreContract("memory", async () => new MemorySagaStore());
guardStoreContract("memory", async () => new MemoryGuardStore());

interface State {
  made: string[];
}
const ID = "00000000-0000-4000-8000-0000000000aa";
const never = new AbortController().signal;

/** A saga whose steps record what they did and undid, and can be told to fail. */
function create(options: { failAt?: string; failUndo?: string; abortAt?: string; controller?: AbortController } = {}) {
  const log: string[] = [];
  const step = (name: string, undo = true): SagaStep<State> => ({
    name,
    async run(state) {
      log.push(`run ${name}`);
      if (options.abortAt === name) {
        options.controller?.abort();
        throw new Error("interrupted");
      }
      if (options.failAt === name) throw new Error(`${name} failed`);
      return { made: [...state.made, name] };
    },
    ...(undo
      ? {
          async compensate(state: State) {
            log.push(`undo ${name} (made ${state.made.join(",")})`);
            if (options.failUndo === name) throw new Error("cannot undo");
          },
        }
      : {}),
  });
  const saga = defineSaga<State>({
    kind: "instances.create",
    steps: [step("create-instance"), step("add-dns-record"), step("note-only", false), step("enroll-agent")],
  });
  return { saga, log };
}

describe("sagas", () => {
  it("run every step in order, carry the state, and record each step as it finishes", async () => {
    const store = new MemorySagaStore();
    const { saga, log } = create();
    await startSaga(store, saga, ID, { made: [] });
    const done = await runSaga(store, saga, ID, never);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.state, { made: ["create-instance", "add-dns-record", "note-only", "enroll-agent"] });
    assert.deepEqual(log, ["run create-instance", "run add-dns-record", "run note-only", "run enroll-agent"]);
    assert.equal(store.saves, 5, "after each of four steps, and once at the end");
    assert.deepEqual(await store.load(ID), done);
  });

  it("undo the finished steps in reverse when one fails, and say which step failed", async () => {
    const store = new MemorySagaStore();
    const { saga, log } = create({ failAt: "enroll-agent" });
    await startSaga(store, saga, ID, { made: [] });
    const done = await runSaga(store, saga, ID, never);
    assert.equal(done.status, "compensated");
    assert.equal(done.failedStep, "enroll-agent");
    assert.equal(done.error, "enroll-agent failed");
    assert.deepEqual(log.slice(4), [
      "undo add-dns-record (made create-instance,add-dns-record,note-only)",
      "undo create-instance (made create-instance,add-dns-record,note-only)",
    ]);
  });

  it("stop undoing and say so when an undo fails: someone has to look", async () => {
    const store = new MemorySagaStore();
    const { saga } = create({ failAt: "enroll-agent", failUndo: "add-dns-record" });
    await startSaga(store, saga, ID, { made: [] });
    const done = await runSaga(store, saga, ID, never);
    assert.equal(done.status, "compensation-failed");
    assert.equal(done.error, "enroll-agent failed; undoing add-dns-record failed: cannot undo");
  });

  it("resume where they stopped after an interruption, without running a finished step again", async () => {
    const store = new MemorySagaStore();
    const controller = new AbortController();
    const first = create({ abortAt: "add-dns-record", controller });
    await startSaga(store, first.saga, ID, { made: [] });
    const stopped = await runSaga(store, first.saga, ID, controller.signal);
    assert.equal(stopped.status, "running", "an interruption is not a failure: nothing is undone");
    assert.deepEqual((await store.load(ID))?.done, ["create-instance"]);

    const second = create();
    const done = await runSaga(store, second.saga, ID, never);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(second.log, ["run add-dns-record", "run note-only", "run enroll-agent"]);
  });

  it("leave an ended saga as it is, and refuse another kind's record", async () => {
    const store = new MemorySagaStore();
    const { saga } = create();
    await startSaga(store, saga, ID, { made: [] });
    await runSaga(store, saga, ID, never);
    const again = create();
    assert.equal((await runSaga(store, again.saga, ID, never)).status, "succeeded");
    assert.deepEqual(again.log, []);
    const other = defineSaga<State>({ kind: "databases.destroy", steps: [{ name: "x", run: async (s) => s }] });
    await assert.rejects(runSaga(store, other, ID, never), /is a instances.create, not a databases.destroy/);
    await assert.rejects(runSaga(store, saga, "00000000-0000-4000-8000-0000000000ff", never), /no saga/);
  });

  it("are defined with a <plugin>.<what> kind and unique, named steps", () => {
    const run = async (s: State) => s;
    assert.throws(() => defineSaga({ kind: "create", steps: [{ name: "a", run }] }), /must be <plugin>.<what>/);
    assert.throws(
      () =>
        defineSaga({
          kind: "a.b",
          steps: [
            { name: "a", run },
            { name: "a", run },
          ],
        }),
      /declared twice/,
    );
    assert.throws(() => defineSaga({ kind: "a.b", steps: [] }), /at least one step/);
  });
});
