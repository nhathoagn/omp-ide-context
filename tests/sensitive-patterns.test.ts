import { describe, expect, it } from "bun:test";
import { isSensitive } from "../vscode-extension/src/sensitive-patterns.ts";

describe("isSensitive", () => {
	it("blocks .env, .env.local, .env.production", () => {
		expect(isSensitive(".env")).toBe(true);
		expect(isSensitive(".env.local")).toBe(true);
		expect(isSensitive(".env.production")).toBe(true);
		expect(isSensitive("src/.env")).toBe(true);
		expect(isSensitive("deeply/nested/path/.env.staging")).toBe(true);
	});

	it("blocks .pem/.key/.p12/.pfx files", () => {
		expect(isSensitive("cert.pem")).toBe(true);
		expect(isSensitive("secrets/server.key")).toBe(true);
		expect(isSensitive("wildcard.p12")).toBe(true);
		expect(isSensitive("dir/wildcard.pfx")).toBe(true);
	});

	it("blocks SSH/AWS/GnupG directories and contents", () => {
		expect(isSensitive(".ssh/id_rsa")).toBe(true);
		expect(isSensitive(".ssh/id_ed25519")).toBe(true);
		expect(isSensitive("home/.aws/credentials")).toBe(true);
		expect(isSensitive(".gnupg/secring.gpg")).toBe(true);
	});

	it("blocks .git internals and node_modules", () => {
		expect(isSensitive(".git/config")).toBe(true);
		expect(isSensitive(".git/HEAD")).toBe(true);
		expect(isSensitive("node_modules/lodash/index.js")).toBe(true);
	});

	it("blocks credentials* and secrets* basenames", () => {
		expect(isSensitive("credentials")).toBe(true);
		expect(isSensitive("credentials.json")).toBe(true);
		expect(isSensitive("secrets")).toBe(true);
		expect(isSensitive("secrets.yaml")).toBe(true);
	});

	it("does not block ordinary source files", () => {
		expect(isSensitive("src/index.ts")).toBe(false);
		expect(isSensitive("README.md")).toBe(false);
		expect(isSensitive("src/components/UserForm.vue")).toBe(false);
	});

	it("treats empty and non-string input as sensitive (fail-closed)", () => {
		expect(isSensitive("")).toBe(true);
	});

	it("is case-insensitive on basenames", () => {
		expect(isSensitive(".ENV")).toBe(true);
		expect(isSensitive("Server.PEM")).toBe(true);
	});
});
