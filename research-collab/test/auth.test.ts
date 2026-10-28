import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Auth } from "../src/auth.ts";

test("host token is created once with mode 600 and identifies the host", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rc-auth-"));
	const auth = await Auth.open(dir, "Mira", undefined);
	assert.equal(((await stat(join(dir, "host-token"))).mode & 0o777).toString(8), "600");
	assert.deepEqual(auth.identify(auth.hostToken), { id: "host", name: "Mira", role: "host" });
	const again = await Auth.open(dir, "Mira", undefined);
	assert.equal(again.hostToken, auth.hostToken);
});

test("invites identify one person, survive reopening, and can be revoked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rc-auth-"));
	const auth = await Auth.open(dir, "Host", "host-secret");
	const { identity, token } = await auth.create("Alice", "editor");
	assert.equal(auth.identify(token)?.name, "Alice");
	assert.equal(auth.identify(token)?.role, "editor");
	assert.equal(auth.identify("wrong"), undefined);
	assert.equal(auth.identify(undefined), undefined);

	const stored = await readFile(join(dir, "invites.json"), "utf8");
	assert.ok(!stored.includes(token), "raw tokens must not be stored");

	const reopened = await Auth.open(dir, "Host", "host-secret");
	assert.equal(reopened.identify(token)?.id, identity.id);
	assert.equal(await reopened.revoke(identity.id), true);
	assert.equal(reopened.identify(token), undefined);
});
