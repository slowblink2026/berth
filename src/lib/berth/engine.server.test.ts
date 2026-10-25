import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dateHint,
  isRepeated,
  isSensitive,
  needsForm,
  needsQuery,
  parseDecision,
  parsePoint,
} from "./engine.server.ts";

type Decision = Parameters<typeof isSensitive>[0];

function decision(over: Partial<Decision> = {}): Decision {
  return {
    action: "click",
    target: "",
    text: "",
    useVault: false,
    sensitive: false,
    summary: "",
    reason: "",
    ...over,
  } as Decision;
}

describe("isRepeated", () => {
  it("treats a step that already failed as tried", () => {
    const history = [
      {
        label:
          "The action failed: Clicked Out Sun 25 Oct • 19:30. timeout at https://thetrainline.com/.",
      },
    ];
    assert.equal(isRepeated("Clicked Out Sun 25 Oct • 19:30.", history), true);
  });

  it("allows a step once more before calling it repeated", () => {
    const once = [{ label: "Scrolled down the page." }];
    assert.equal(isRepeated("Scrolled down the page.", once), false);
    assert.equal(isRepeated("Scrolled down the page.", [...once, ...once]), true);
  });

  it("ignores unrelated steps and matches regardless of case", () => {
    const history = [{ label: "Clicked Search." }, { label: "Typed into From." }];
    assert.equal(isRepeated("Clicked One-way.", history), false);
    assert.equal(isRepeated("clicked search.", history), false);
    assert.equal(isRepeated("clicked search.", [...history, { label: "Clicked Search." }]), true);
  });
});

describe("needsQuery", () => {
  it("is true only on the bare search home", () => {
    assert.equal(needsQuery("https://duckduckgo.com/"), true);
    assert.equal(needsQuery("https://www.google.co.uk/"), true);
  });

  it("leaves a search page that already has a query alone", () => {
    assert.equal(needsQuery("https://duckduckgo.com/?q=flights+to+paris"), false);
  });

  it("leaves other pages on those hosts alone", () => {
    assert.equal(needsQuery("https://www.google.com/travel/flights?q=LHR+to+CDG"), false);
    assert.equal(needsQuery("https://www.google.com/maps"), false);
  });

  it("is false for any other site and for rubbish", () => {
    assert.equal(needsQuery("https://www.kayak.co.uk/flights/LON-PAR/2026-11-15"), false);
    assert.equal(needsQuery("not a url"), false);
  });
});

describe("needsForm", () => {
  it("recognises the flight and train missions", () => {
    assert.equal(needsForm("cheapest one-way flight London to Paris on 15 November 2026"), true);
    assert.equal(needsForm("train times and fares London to Manchester tomorrow"), true);
    assert.equal(needsForm("book a hotel room in Leeds for Friday"), true);
  });

  it("leaves a read-one-page task on the small budget", () => {
    assert.equal(needsForm("What is the top story right now?"), false);
    assert.equal(needsForm("Summarise this article"), false);
  });
});

describe("isSensitive", () => {
  it("holds a step that commits a payment or a booking", () => {
    for (const target of [
      "Pay now",
      "Place order",
      "Confirm and pay",
      "Proceed to checkout",
      "Add to basket",
      "Complete booking",
      "Transfer money",
      "Delete account",
      "Change password",
    ]) {
      assert.equal(isSensitive(decision({ target })), true, target);
    }
    assert.equal(isSensitive(decision({ action: "type", target: "Card number", text: "" })), true);
  });

  it("lets an ordinary search through when the page says transfer or payment", () => {
    assert.equal(isSensitive(decision({ target: "Transfer at Crewe" })), false);
    assert.equal(
      isSensitive(decision({ target: "Search", reason: "1 transfer, 2h 14m is the cheapest" })),
      false,
    );
    assert.equal(
      isSensitive(decision({ action: "select", target: "Return", text: "One-way" })),
      false,
    );
    assert.equal(isSensitive(decision({ action: "type", target: "From", text: "London" })), false);
  });

  it("does not hold an answer or a scroll that quotes the page", () => {
    assert.equal(
      isSensitive(
        decision({
          action: "done",
          summary: "£34.50, buy now on the operator site",
          reason: "buy now",
        }),
      ),
      false,
    );
    assert.equal(
      isSensitive(decision({ action: "scroll", reason: "to reach proceed to checkout" })),
      false,
    );
  });

  it("still honours the model's own flag and the saved login", () => {
    assert.equal(isSensitive(decision({ action: "done", sensitive: true })), true);
    assert.equal(
      isSensitive(decision({ action: "type", useVault: true, target: "Password" })),
      false,
    );
  });
});

describe("parsePoint", () => {
  it("reads x,y in screenshot pixels", () => {
    assert.deepEqual(parsePoint("550,300"), { x: 550, y: 300 });
    assert.deepEqual(parsePoint(" 12 , 34 "), { x: 12, y: 34 });
  });

  it("clamps to the viewport", () => {
    assert.deepEqual(parsePoint("5000,5000"), { x: 1099, y: 719 });
    assert.deepEqual(parsePoint("-40,-1"), { x: 0, y: 0 });
  });

  it("refuses anything that is not a pair of numbers", () => {
    assert.throws(() => parsePoint("the date picker"), /x,y in pixels/);
    assert.throws(() => parsePoint("550"), /x,y in pixels/);
    assert.throws(() => parsePoint(""), /x,y in pixels/);
  });
});

describe("parseDecision", () => {
  it("accepts the camelCase actions, which a lowercased compare used to reject", () => {
    assert.equal(parseDecision('{"action":"clickAt","target":"550,300"}').action, "clickAt");
    assert.equal(parseDecision('{"action":"clickat","target":"550,300"}').action, "clickAt");
    assert.equal(parseDecision('{"action":"click_at","target":"550,300"}').action, "clickAt");
    assert.equal(parseDecision('{"action":"scrollUp"}').action, "scrollUp");
    assert.equal(parseDecision('{"action":"scrollup"}').action, "scrollUp");
  });

  it("reads the plain actions and the wait action", () => {
    assert.equal(parseDecision('{"action":"click","target":"Search"}').action, "click");
    assert.equal(
      parseDecision('{"action":"wait","reason":"comparing flight sites"}').action,
      "wait",
    );
    assert.equal(parseDecision('{"action":"DONE","summary":"£40 on easyJet"}').action, "done");
  });

  it("maps the names a model reaches for instead of the listed ones", () => {
    assert.equal(
      parseDecision('{"action":"navigate","target":"https://example.com"}').action,
      "click",
    );
    assert.equal(parseDecision('{"action":"pressEnter"}').action, "press");
    assert.equal(parseDecision('{"action":"waitFor"}').action, "wait");
  });

  it("names the action it could not place", () => {
    assert.throws(() => parseDecision('{"action":"teleport"}'), /unknown step: teleport/);
    assert.throws(() => parseDecision("no json here"), /didn't return a step/);
  });

  it("still reads fields out of a reply that is not valid JSON", () => {
    const decision = parseDecision('{"action":"click", "target":"One way",}');
    assert.equal(decision.action, "click");
    assert.equal(decision.target, "One way");
  });
});

describe("dateHint", () => {
  it("gives the date and the weekday a relative date is counted from", () => {
    assert.equal(dateHint(new Date("2026-10-25T22:40:00Z")), "2026-10-25 (Sunday, UTC)");
    assert.equal(dateHint(new Date("2026-11-15T00:00:00Z")), "2026-11-15 (Sunday, UTC)");
  });

  it("reads the day in UTC, not in the host's zone", () => {
    assert.equal(dateHint(new Date("2026-10-25T23:30:00Z")), "2026-10-25 (Sunday, UTC)");
    assert.equal(dateHint(new Date("2026-10-26T00:30:00Z")), "2026-10-26 (Monday, UTC)");
  });
});
