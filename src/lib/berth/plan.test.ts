import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { focusText, isTrackerHost, plainAnswer, searchFallbackUrl, taskTerms } from "./plan.ts";

describe("focusText", () => {
  it("returns short pages untouched", () => {
    assert.equal(focusText("hello", "anything", 100), "hello");
  });
  it("brings in the passage that answers the task from far down a long page", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Menu item number ${i} about nothing in particular.`).join("\n");
    const page = `${filler}\nNext departure to London Waterloo: 08:12 from platform 2.\n${filler}`;
    const shown = focusText(page, "When is the next train to London Waterloo?", 3000);
    assert.ok(shown.length <= 3000);
    assert.match(shown, /08:12 from platform 2/);
    assert.match(shown, /^Menu item number 0/);
  });
  it("falls back to the top of the page when nothing matches", () => {
    const page = "x ".repeat(5000);
    assert.equal(focusText(page, "zebra crossing", 1000), page.slice(0, 1000));
  });
});

describe("taskTerms", () => {
  it("keeps the words that identify the task and drops instructions", () => {
    const terms = taskTerms("Search the public web and answer: LMND Lemonade stock price today");
    assert.deepEqual(terms, ["lmnd", "lemonade", "stock", "price", "today"]);
  });
});

describe("searchFallbackUrl", () => {
  it("re-runs a blocked Google search on DuckDuckGo", () => {
    assert.equal(
      searchFallbackUrl("https://www.google.com/search?q=heathrow+drop+off+charge", "x"),
      "https://html.duckduckgo.com/html/?q=heathrow%20drop%20off%20charge",
    );
  });
  it("finds the query inside Google's 'sorry' redirect", () => {
    const sorry = "https://www.google.com/sorry/index?continue=" + encodeURIComponent("https://www.google.com/search?q=lmnd price");
    assert.match(searchFallbackUrl(sorry, "x") ?? "", /q=lmnd%20price$/);
  });
  it("builds a query from the task when the address has none, and leaves other sites alone", () => {
    assert.match(searchFallbackUrl("https://www.google.com/", "Find the Heathrow drop-off charge") ?? "", /q=heathrow%20drop-off%20charge$/);
    assert.equal(searchFallbackUrl("https://www.kayak.co.uk/flights", "anything"), null);
  });
});

describe("isTrackerHost", () => {
  it("matches trackers and their subdomains only", () => {
    assert.ok(isTrackerHost("www.googletagmanager.com"));
    assert.ok(isTrackerHost("stats.g.doubleclick.net"));
    assert.ok(!isTrackerHost("finance.yahoo.com"));
    assert.ok(!isTrackerHost("notdoubleclick.net.example.com"));
  });
});

describe("plainAnswer", () => {
  it("removes Markdown the model adds", () => {
    assert.equal(plainAnswer("## LMND\n**Price:** 39.87 USD\n- up `0.19%`"), "LMND\nPrice: 39.87 USD\n• up 0.19%");
  });
});
