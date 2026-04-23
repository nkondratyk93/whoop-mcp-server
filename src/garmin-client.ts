import { createRequire } from 'node:module';
import type { IOauth1Token, IOauth2Token } from 'garmin-connect/dist/garmin/types.js';

// garmin-connect exposes GarminConnect via Object.defineProperty, which
// Node's cjs-module-lexer can't statically detect — so a named ESM import
// fails at runtime. Fall through to createRequire to load the CJS module
// directly while keeping type-safety.
const require = createRequire(import.meta.url);
const { GarminConnect } = require('garmin-connect') as typeof import('garmin-connect');

export interface GarminTokens {
	oauth1: IOauth1Token;
	oauth2: IOauth2Token;
}

interface GarminDailyWeight {
	samplePk: number;
	calendarDate: string;
	timestampGMT: number;
	weight: number;
	bmi: number | null;
	bodyFat: number | null;
	bodyWater: number | null;
	boneMass: number | null;
	muscleMass: number | null;
	physiqueRating: number | null;
	visceralFat: number | null;
	metabolicAge: number | null;
	sourceType: string;
}

interface GarminWeightDayResponse {
	dateWeightList?: GarminDailyWeight[];
}

interface GarminClientConfig {
	email: string;
	password: string;
	onTokensChange?: (tokens: GarminTokens) => void;
}

export class GarminClient {
	private gc: InstanceType<typeof GarminConnect>;
	private readonly email: string;
	private readonly password: string;
	private readonly onTokensChange?: (tokens: GarminTokens) => void;
	private loggedIn = false;

	constructor(config: GarminClientConfig) {
		this.email = config.email;
		this.password = config.password;
		this.onTokensChange = config.onTokensChange;
		this.gc = new GarminConnect({ username: this.email, password: this.password });
	}

	loadTokens(tokens: GarminTokens): void {
		this.gc.loadToken(tokens.oauth1, tokens.oauth2);
		this.loggedIn = true;
	}

	async ensureLoggedIn(): Promise<void> {
		if (this.loggedIn) return;
		await this.gc.login(this.email, this.password);
		this.loggedIn = true;
		const exported = this.gc.exportToken();
		if (exported) {
			this.onTokensChange?.({ oauth1: exported.oauth1 as IOauth1Token, oauth2: exported.oauth2 as IOauth2Token });
		}
	}

	async getDailyWeight(date: Date): Promise<GarminDailyWeight[]> {
		await this.ensureLoggedIn();
		try {
			const data = await this.gc.getDailyWeightData(date) as GarminWeightDayResponse;
			return data?.dateWeightList ?? [];
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/401|403|unauthor/i.test(message)) {
				this.loggedIn = false;
				await this.ensureLoggedIn();
				const data = await this.gc.getDailyWeightData(date) as GarminWeightDayResponse;
				return data?.dateWeightList ?? [];
			}
			throw err;
		}
	}

	async getWeightRange(days: number): Promise<GarminDailyWeight[]> {
		const all: GarminDailyWeight[] = [];
		const seenSamplePks = new Set<number>();
		const now = new Date();
		for (let i = 0; i < days; i++) {
			const d = new Date(now);
			d.setUTCDate(d.getUTCDate() - i);
			try {
				const entries = await this.getDailyWeight(d);
				for (const e of entries) {
					if (!seenSamplePks.has(e.samplePk)) {
						seenSamplePks.add(e.samplePk);
						all.push(e);
					}
				}
			} catch {
				// Tolerate per-day failures; return what we have.
			}
		}
		return all;
	}
}
