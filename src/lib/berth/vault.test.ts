import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "berth-vault-"));
process.env.BERTH_VAULT_DIR = dir;
delete process.env.BERTH_VAULT_KEY;
const vault = await import("./vault.server.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

describe("login vault", () => {
  it("saves a login for the whole site and gives it back only for that site", () => {
    const saved = vault.saveLogin("https://www.exhalecoffee.com/account/login", "me@example.com", "s3cret pass!");
    assert.deepEqual([saved.site, saved.username], ["exhalecoffee.com", "me@example.com"]);
    assert.deepEqual(vault.loginFor("https://login.exhalecoffee.com/x"), { username: "me@example.com", password: "s3cret pass!" });
    assert.equal(vault.loginFor("https://exhalecoffee.com.evil.example/login"), null);
    assert.equal(vault.hasLogin("https://shop.exhalecoffee.com"), true);
    assert.equal(vault.hasLogin("https://other.example"), false);
  });
  it("never writes the password in the clear, and keeps its files private", () => {
    const raw = readFileSync(path.join(dir, "berth-vault.json"), "utf8");
    assert.ok(!raw.includes("s3cret"));
    assert.ok(raw.includes("me@example.com"));
    assert.equal(statSync(path.join(dir, "berth-vault.json")).mode & 0o077, 0);
    assert.equal(statSync(path.join(dir, "berth-vault.key")).mode & 0o077, 0);
  });
  it("lists sites and usernames without passwords, replaces and removes", () => {
    vault.saveLogin("example.co.uk", "old", "one");
    vault.saveLogin("www.example.co.uk", "new", "two");
    const listed = vault.listLogins();
    assert.deepEqual(listed.map((l) => [l.site, l.username]), [["example.co.uk", "new"], ["exhalecoffee.com", "me@example.com"]]);
    assert.ok(!JSON.stringify(listed).includes("two"));
    assert.equal(vault.loginFor("https://example.co.uk")?.password, "two");
    assert.equal(vault.removeLogin("example.co.uk"), true);
    assert.equal(vault.removeLogin("example.co.uk"), false);
    assert.equal(vault.loginFor("https://example.co.uk"), null);
  });
  it("refuses a login with no password or no real site", () => {
    assert.throws(() => vault.saveLogin("example.com", "me", ""), /needs a password/);
    assert.throws(() => vault.saveLogin("not a site", "me", "x"), /website address/);
    assert.throws(() => vault.saveLogin("", "me", "x"), /which website/);
  });
});
