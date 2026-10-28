// Invites and roles. A token identifies one person: the name is fixed when the host creates the invite.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Role = "host" | "editor" | "viewer";

export interface Identity {
	readonly id: string;
	readonly name: string;
	readonly role: Role;
}

interface StoredInvite extends Identity {
	readonly hash: string;
	readonly createdAt: number;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export class Auth {
	private readonly file: string;
	private invites: StoredInvite[];
	private readonly hostHash: string;
	readonly hostToken: string;

	private constructor(file: string, invites: StoredInvite[], hostToken: string) {
		this.file = file;
		this.invites = invites;
		this.hostToken = hostToken;
		this.hostHash = sha256(hostToken);
	}

	/** The host token comes from ROOM_HOST_TOKEN, else from `host-token` in the data directory (created once, mode 600). */
	static async open(dataDir: string, hostName: string, envToken: string | undefined): Promise<Auth> {
		const tokenFile = join(dataDir, "host-token");
		let hostToken = envToken?.trim();
		if (!hostToken) {
			try {
				hostToken = (await readFile(tokenFile, "utf8")).trim();
			} catch {
				hostToken = randomBytes(24).toString("base64url");
				await writeFile(tokenFile, `${hostToken}\n`, { mode: 0o600 });
				await chmod(tokenFile, 0o600);
			}
		}
		const file = join(dataDir, "invites.json");
		let invites: StoredInvite[] = [];
		try {
			invites = JSON.parse(await readFile(file, "utf8")) as StoredInvite[];
		} catch {}
		const auth = new Auth(file, invites, hostToken);
		auth.hostName = hostName;
		return auth;
	}

	hostName = "Host";

	/** Who a token belongs to, or undefined. Compares hashes in constant time. */
	identify(token: string | undefined): Identity | undefined {
		if (!token) return undefined;
		const hash = sha256(token);
		const same = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(a), Buffer.from(b));
		if (same(hash, this.hostHash)) return { id: "host", name: this.hostName, role: "host" };
		const found = this.invites.find((invite) => same(hash, invite.hash));
		return found === undefined ? undefined : { id: found.id, name: found.name, role: found.role };
	}

	list(): Identity[] {
		return this.invites.map(({ id, name, role }) => ({ id, name, role }));
	}

	async create(name: string, role: Exclude<Role, "host">): Promise<{ identity: Identity; token: string }> {
		const token = randomBytes(18).toString("base64url");
		const id = randomBytes(6).toString("hex");
		this.invites.push({ id, name, role, hash: sha256(token), createdAt: Date.now() });
		await this.save();
		return { identity: { id, name, role }, token };
	}

	async revoke(id: string): Promise<boolean> {
		const before = this.invites.length;
		this.invites = this.invites.filter((invite) => invite.id !== id);
		await this.save();
		return this.invites.length < before;
	}

	private save(): Promise<void> {
		return writeFile(this.file, JSON.stringify(this.invites, null, 2), { mode: 0o600 });
	}
}
