/**
 * Saved website logins, kept on this machine and encrypted at rest.
 *
 * One login per site (example.com covers www.example.com and login.example.com).
 * The file holds usernames in the clear and passwords under AES-256-GCM. The key
 * comes from BERTH_VAULT_KEY when set; otherwise one is generated on first use
 * and kept beside the vault with owner-only permissions. A password is never
 * returned by any API and never written to a log or a task step: the engine
 * types it into the page, and only into a page on the site it was saved for.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { siteKey } from "./net.ts";

type Stored = { username: string; password: string; updatedAt: string };
type VaultFile = { version: 1; logins: Record<string, Stored> };
export type LoginInfo = { site: string; username: string; updatedAt: string };

function dir(): string {
  return process.env.BERTH_VAULT_DIR || path.join(process.cwd(), ".local");
}
const file = () => path.join(dir(), "berth-vault.json");
const keyFile = () => path.join(dir(), "berth-vault.key");

let cachedKey: { from: string; key: Buffer } | null = null;

function key(): Buffer {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  let secret = process.env.BERTH_VAULT_KEY?.trim() ?? "";
  if (!secret) {
    if (!existsSync(keyFile())) {
      writeFileSync(keyFile(), randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    chmodSync(keyFile(), 0o600);
    secret = readFileSync(keyFile(), "utf8").trim();
  }
  if (cachedKey?.from !== secret)
    cachedKey = { from: secret, key: scryptSync(secret, "berth-vault-v1", 32) };
  return cachedKey.key;
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

function open(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !body) throw new Error("The saved login is unreadable.");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function read(): VaultFile {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as VaultFile;
    if (parsed && parsed.version === 1 && parsed.logins && typeof parsed.logins === "object")
      return parsed;
  } catch {
    // no vault yet, or an unreadable one: start empty rather than fail every task
  }
  return { version: 1, logins: {} };
}

function write(vault: VaultFile) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const temp = `${file()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(vault, null, 1), { mode: 0o600 });
  renameSync(temp, file());
}

/** The site a login belongs to, from an address or a bare host name. */
export function siteOf(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) throw new Error("Say which website the login is for.");
  let host: string;
  try {
    host = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`).hostname;
  } catch {
    throw new Error("That isn't a website address.");
  }
  const site = siteKey(host);
  if (!site.includes(".") || /[^a-z0-9.-]/.test(site))
    throw new Error("That isn't a website address.");
  return site;
}

export function listLogins(): LoginInfo[] {
  return Object.entries(read().logins)
    .map(([site, row]) => ({ site, username: row.username, updatedAt: row.updatedAt }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export function saveLogin(rawSite: string, username: string, password: string): LoginInfo {
  const site = siteOf(rawSite);
  const user = username.trim().slice(0, 200);
  const pass = password.slice(0, 500);
  if (!pass) throw new Error("A login needs a password.");
  const vault = read();
  const row = { username: user, password: seal(pass), updatedAt: new Date().toISOString() };
  vault.logins[site] = row;
  write(vault);
  return { site, username: user, updatedAt: row.updatedAt };
}

export function removeLogin(rawSite: string): boolean {
  const site = siteOf(rawSite);
  const vault = read();
  if (!vault.logins[site]) return false;
  delete vault.logins[site];
  write(vault);
  return true;
}

export function hasLogin(pageUrl: string): boolean {
  try {
    return Boolean(read().logins[siteKey(new URL(pageUrl).hostname)]);
  } catch {
    return false;
  }
}

/** The login for the site this page is on, or null. Only the engine calls this. */
export function loginFor(pageUrl: string): { username: string; password: string } | null {
  let site: string;
  try {
    site = siteKey(new URL(pageUrl).hostname);
  } catch {
    return null;
  }
  const row = read().logins[site];
  if (!row) return null;
  return { username: row.username, password: open(row.password) };
}
