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
	private loginAttempted = false;
	private loginError: Error | null = null;

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
		if (this.loginAttempted && this.loginError) throw this.loginError;
		this.loginAttempted = true;
		try {
			await this.gc.login(this.email, this.password);
			this.loggedIn = true;
			this.loginError = null;
			const exported = this.gc.exportToken();
			if (exported) {
				this.onTokensChange?.({ oauth1: exported.oauth1 as IOauth1Token, oauth2: exported.oauth2 as IOauth2Token });
			}
		} catch (err) {
			this.loginError = err instanceof Error ? err : new Error(String(err));
			throw this.loginError;
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
		// Log in once up front so a 401/429/etc surfaces immediately, rather than
		// once per day (which would hammer Garmin's SSO and invite bot-block).
		await this.ensureLoggedIn();

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
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/404/.test(message)) continue;
				// Any other per-day error is unexpected — stop and surface it.
				throw err;
			}
		}
		return all;
	}
}
