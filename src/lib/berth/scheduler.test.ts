import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { busyCount, enqueueFor, evictable, isBusy, resetScheduler } from "./scheduler.ts";

type Dock = { id: string; touched: number };

/** Let queued work start: enqueueFor schedules onto the microtask queue. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let release!: () => void;
  const waited = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waited, release };
}

beforeEach(() => resetScheduler());

test("tasks on different docks run side by side", async () => {
  const a = deferred();
  const order: string[] = [];
  const first = enqueueFor("alpha", async () => {
    order.push("alpha:start");
    await a.waited;
    order.push("alpha:end");
  });
  const second = enqueueFor("beta", async () => {
    order.push("beta:ran");
  });
  await second;
  await tick();
  assert.deepEqual(order, ["alpha:start", "beta:ran"], "beta did not wait for alpha");
  a.release();
  await first;
});

test("tasks on one dock queue behind each other", async () => {
  const a = deferred();
  const order: string[] = [];
  const first = enqueueFor("alpha", async () => {
    order.push("first:start");
    await a.waited;
    order.push("first:end");
  });
  const second = enqueueFor("alpha", async () => {
    order.push("second:ran");
  });
  await tick();
  assert.deepEqual(order, ["first:start"], "the second task waits its turn");
  a.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:ran"]);
});

test("a dock stays busy until the last task behind it has finished", async () => {
  const a = deferred();
  const b = deferred();
  const first = enqueueFor("alpha", async () => {
    await a.waited;
  });
  const second = enqueueFor("alpha", async () => {
    await b.waited;
  });
  assert.equal(isBusy("alpha"), true);
  a.release();
  await first;
  assert.equal(isBusy("alpha"), true, "a queued task still holds the dock");
  b.release();
  await second;
  await tick();
  assert.equal(isBusy("alpha"), false);
  assert.equal(busyCount(), 0);
});

test("a failing task releases its dock", async () => {
  await assert.rejects(
    enqueueFor("alpha", async () => {
      throw new Error("navigation failed");
    }),
  );
  await tick();
  assert.equal(isBusy("alpha"), false);
});

test("a busy dock is never offered for eviction, however old", async () => {
  const a = deferred();
  const running = enqueueFor("old", async () => {
    await a.waited;
  });
  const open: Dock[] = [
    { id: "old", touched: 1 },
    { id: "recent", touched: 50 },
  ];
  // "old" is the oldest, but closing it would kill the task running on it.
  assert.deepEqual(
    evictable(open, "newcomer", 2).map((dock) => dock.id),
    ["recent"],
  );
  a.release();
  await running;
});

test("nothing is evictable when every other dock is working", async () => {
  const a = deferred();
  const b = deferred();
  const first = enqueueFor("one", async () => {
    await a.waited;
  });
  const second = enqueueFor("two", async () => {
    await b.waited;
  });
  const open: Dock[] = [
    { id: "one", touched: 1 },
    { id: "two", touched: 2 },
  ];
  assert.deepEqual(evictable(open, "newcomer", 2), []);
  a.release();
  b.release();
  await Promise.all([first, second]);
});

test("the dock being opened is kept, and idle docks go oldest first", () => {
  const open: Dock[] = [
    { id: "keep", touched: 1 },
    { id: "oldest", touched: 2 },
    { id: "newer", touched: 3 },
  ];
  assert.deepEqual(
    evictable(open, "keep", 2).map((dock) => dock.id),
    ["oldest", "newer"],
  );
});

test("there is nothing to evict below the ceiling", () => {
  assert.deepEqual(evictable([{ id: "one", touched: 1 }], "newcomer", 2), []);
});
