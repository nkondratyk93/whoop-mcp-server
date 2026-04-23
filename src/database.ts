import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type {
	WhoopTokens,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	DbCycle,
	DbRecovery,
	DbSleep,
	DbWorkout,
} from './types.js';

interface TokenRow {
	id: number;
	access_token: string;
	refresh_token: string;
	expires_at: number;
	updated_at: string;
}

interface SyncStateRow {
	id: number;
	last_sync_at: string | null;
	oldest_synced_date: string | null;
	newest_synced_date: string | null;
}

interface RecoveryTrendRow {
	date: string;
	recovery_score: number;
	hrv: number;
	rhr: number;
}

interface SleepTrendRow {
	date: string;
	total_sleep_hours: number;
	performance: number;
	efficiency: number;
}

interface StrainTrendRow {
	date: string;
	strain: number;
	calories: number;
}

interface DailyLoadRow {
	date: string;
	day_strain: number | null;
	workout_count: number;
	sports: string | null;
	next_recovery: number | null;
	next_hrv: number | null;
}

interface SleepDebtRow {
	date: string;
	actual_sleep_ms: number;
	baseline_ms: number | null;
	debt_ms: number | null;
	strain_ms: number | null;
	nap_ms: number | null;
	total_need_ms: number;
	performance: number | null;
	disturbances: number | null;
	cycles: number | null;
	shortfall_ms: number;
}

export class WhoopDatabase {
	private db: Database.Database;

	constructor(dbPath = './whoop.db') {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_sync_at TEXT,
				oldest_synced_date TEXT,
				newest_synced_date TEXT
			);

			CREATE TABLE IF NOT EXISTS cycles (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				kilojoule REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS recovery (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sleep_id TEXT,
				created_at TEXT NOT NULL,
				score_state TEXT NOT NULL,
				recovery_score INTEGER,
				resting_hr INTEGER,
				hrv_rmssd REAL,
				spo2 REAL,
				skin_temp REAL,
				user_calibrating INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sleep (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				cycle_id INTEGER,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				is_nap INTEGER NOT NULL DEFAULT 0,
				score_state TEXT NOT NULL,
				total_in_bed_milli INTEGER,
				total_awake_milli INTEGER,
				total_no_data_milli INTEGER,
				total_light_milli INTEGER,
				total_deep_milli INTEGER,
				total_rem_milli INTEGER,
				sleep_cycle_count INTEGER,
				disturbance_count INTEGER,
				sleep_performance REAL,
				sleep_efficiency REAL,
				sleep_consistency REAL,
				respiratory_rate REAL,
				sleep_needed_baseline_milli INTEGER,
				sleep_needed_debt_milli INTEGER,
				sleep_needed_strain_milli INTEGER,
				sleep_needed_nap_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS workouts (
				id TEXT PRIMARY KEY,
				v1_id INTEGER,
				user_id INTEGER NOT NULL,
				sport_id INTEGER NOT NULL,
				sport_name TEXT,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				timezone_offset TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				kilojoule REAL,
				percent_recorded REAL,
				distance_meter REAL,
				altitude_gain_meter REAL,
				altitude_change_meter REAL,
				zone_zero_milli INTEGER,
				zone_one_milli INTEGER,
				zone_two_milli INTEGER,
				zone_three_milli INTEGER,
				zone_four_milli INTEGER,
				zone_five_milli INTEGER,
				created_at TEXT,
				updated_at TEXT,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS healthkit_samples (
				metric TEXT NOT NULL,
				date TEXT NOT NULL,
				qty REAL NOT NULL,
				units TEXT,
				received_at TEXT DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (metric, date, qty)
			);

			CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
			CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
			CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
			CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);
			CREATE INDEX IF NOT EXISTS idx_hk_metric_date ON healthkit_samples(metric, date);

			INSERT OR IGNORE INTO sync_state (id) VALUES (1);
		`);

		this.migrateColumns('workouts', [
			['sport_name', 'TEXT'],
			['timezone_offset', 'TEXT'],
			['percent_recorded', 'REAL'],
			['created_at', 'TEXT'],
			['updated_at', 'TEXT'],
			['v1_id', 'INTEGER'],
			['distance_meter', 'REAL'],
			['altitude_gain_meter', 'REAL'],
			['altitude_change_meter', 'REAL'],
		]);
		this.migrateColumns('recovery', [
			['user_calibrating', 'INTEGER'],
		]);
		this.migrateColumns('sleep', [
			['total_no_data_milli', 'INTEGER'],
			['sleep_cycle_count', 'INTEGER'],
			['disturbance_count', 'INTEGER'],
			['sleep_needed_nap_milli', 'INTEGER'],
		]);
	}

	private migrateColumns(table: string, additions: Array<[string, string]>): void {
		const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
		for (const [name, def] of additions) {
			if (!cols.some(c => c.name === name)) {
				this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
			}
		}
	}

	saveTokens(tokens: WhoopTokens): void {
		const encryptedAccess = encrypt(tokens.access_token);
		const encryptedRefresh = encrypt(tokens.refresh_token);

		this.db.prepare(`
			INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at)
			VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
		`).run(encryptedAccess, encryptedRefresh, tokens.expires_at);
	}

	getTokens(): WhoopTokens | null {
		const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as TokenRow | undefined;
		if (!row) return null;

		const accessToken = isEncrypted(row.access_token)
			? decrypt(row.access_token)
			: row.access_token;

		const refreshToken = isEncrypted(row.refresh_token)
			? decrypt(row.refresh_token)
			: row.refresh_token;

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_at: row.expires_at,
		};
	}

	getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
		const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as SyncStateRow | undefined;
		return {
			lastSyncAt: row?.last_sync_at ?? null,
			oldestDate: row?.oldest_synced_date ?? null,
			newestDate: row?.newest_synced_date ?? null,
		};
	}

	updateSyncState(oldestDate: string, newestDate: string): void {
		this.db.prepare(`
			UPDATE sync_state
			SET last_sync_at = CURRENT_TIMESTAMP,
				oldest_synced_date = COALESCE(
					CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END,
					?
				),
				newest_synced_date = COALESCE(
					CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END,
					?
				)
			WHERE id = 1
		`).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
	}

	upsertCycles(cycles: WhoopCycle[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, score_state, strain, kilojoule, avg_hr, max_hr, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopCycle[]) => {
			for (const c of items) {
				stmt.run(
					c.id,
					c.user_id,
					c.start,
					c.end,
					c.score_state,
					c.score?.strain ?? null,
					c.score?.kilojoule ?? null,
					c.score?.average_heart_rate ?? null,
					c.score?.max_heart_rate ?? null
				);
			}
		});

		insertMany(cycles);
	}

	upsertRecoveries(recoveries: WhoopRecovery[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, user_calibrating, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopRecovery[]) => {
			for (const r of items) {
				const calibrating = r.score?.user_calibrating;
				stmt.run(
					r.cycle_id,
					r.user_id,
					r.sleep_id,
					r.created_at,
					r.score_state,
					r.score?.recovery_score ?? null,
					r.score?.resting_heart_rate ?? null,
					r.score?.hrv_rmssd_milli ?? null,
					r.score?.spo2_percentage ?? null,
					r.score?.skin_temp_celsius ?? null,
					calibrating === undefined ? null : (calibrating ? 1 : 0)
				);
			}
		});

		insertMany(recoveries);
	}

	upsertSleeps(sleeps: WhoopSleep[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO sleep (
				id, user_id, start_time, end_time, is_nap, score_state,
				total_in_bed_milli, total_awake_milli, total_no_data_milli,
				total_light_milli, total_deep_milli, total_rem_milli,
				sleep_cycle_count, disturbance_count,
				sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate,
				sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli, sleep_needed_nap_milli,
				synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopSleep[]) => {
			for (const s of items) {
				stmt.run(
					s.id,
					s.user_id,
					s.start,
					s.end,
					s.nap ? 1 : 0,
					s.score_state,
					s.score?.stage_summary.total_in_bed_time_milli ?? null,
					s.score?.stage_summary.total_awake_time_milli ?? null,
					s.score?.stage_summary.total_no_data_time_milli ?? null,
					s.score?.stage_summary.total_light_sleep_time_milli ?? null,
					s.score?.stage_summary.total_slow_wave_sleep_time_milli ?? null,
					s.score?.stage_summary.total_rem_sleep_time_milli ?? null,
					s.score?.stage_summary.sleep_cycle_count ?? null,
					s.score?.stage_summary.disturbance_count ?? null,
					s.score?.sleep_performance_percentage ?? null,
					s.score?.sleep_efficiency_percentage ?? null,
					s.score?.sleep_consistency_percentage ?? null,
					s.score?.respiratory_rate ?? null,
					s.score?.sleep_needed.baseline_milli ?? null,
					s.score?.sleep_needed.need_from_sleep_debt_milli ?? null,
					s.score?.sleep_needed.need_from_recent_strain_milli ?? null,
					s.score?.sleep_needed.need_from_recent_nap_milli ?? null
				);
			}
		});

		insertMany(sleeps);
	}

	upsertWorkouts(workouts: WhoopWorkout[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO workouts (
				id, v1_id, user_id, sport_id, sport_name, start_time, end_time, timezone_offset, score_state,
				strain, avg_hr, max_hr, kilojoule, percent_recorded,
				distance_meter, altitude_gain_meter, altitude_change_meter,
				zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli,
				created_at, updated_at, synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopWorkout[]) => {
			for (const w of items) {
				stmt.run(
					w.id,
					w.v1_id ?? null,
					w.user_id,
					w.sport_id,
					w.sport_name ?? null,
					w.start,
					w.end,
					w.timezone_offset ?? null,
					w.score_state,
					w.score?.strain ?? null,
					w.score?.average_heart_rate ?? null,
					w.score?.max_heart_rate ?? null,
					w.score?.kilojoule ?? null,
					w.score?.percent_recorded ?? null,
					w.score?.distance_meter ?? null,
					w.score?.altitude_gain_meter ?? null,
					w.score?.altitude_change_meter ?? null,
					w.score?.zone_durations?.zone_zero_milli ?? null,
					w.score?.zone_durations?.zone_one_milli ?? null,
					w.score?.zone_durations?.zone_two_milli ?? null,
					w.score?.zone_durations?.zone_three_milli ?? null,
					w.score?.zone_durations?.zone_four_milli ?? null,
					w.score?.zone_durations?.zone_five_milli ?? null,
					w.created_at ?? null,
					w.updated_at ?? null
				);
			}
		});

		insertMany(workouts);
	}

	getLatestCycle(): DbCycle | null {
		return this.db.prepare('SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null;
	}

	getLatestRecovery(): DbRecovery | null {
		return this.db.prepare('SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1').get() as DbRecovery | undefined ?? null;
	}

	getLatestSleep(): DbSleep | null {
		return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null;
	}

	getCyclesByDateRange(startDate: string, endDate: string): DbCycle[] {
		return this.db.prepare(`
			SELECT * FROM cycles WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbCycle[];
	}

	getRecoveriesByDateRange(startDate: string, endDate: string): DbRecovery[] {
		return this.db.prepare(`
			SELECT * FROM recovery WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC
		`).all(startDate, endDate) as DbRecovery[];
	}

	getSleepsByDateRange(startDate: string, endDate: string, includeNaps = false): DbSleep[] {
		const query = includeNaps
			? 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC'
			: 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? AND is_nap = 0 ORDER BY start_time DESC';
		return this.db.prepare(query).all(startDate, endDate) as DbSleep[];
	}

	getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] {
		return this.db.prepare(`
			SELECT * FROM workouts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbWorkout[];
	}

	getRecoveryTrends(days: number): RecoveryTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(created_at) as date, recovery_score, hrv_rmssd as hrv, resting_hr as rhr
			FROM recovery
			WHERE recovery_score IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
			ORDER BY created_at DESC
		`).all(days) as RecoveryTrendRow[];
	}

	getSleepTrends(days: number): SleepTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time) as date,
				ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
				sleep_performance as performance, sleep_efficiency as efficiency
			FROM sleep
			WHERE is_nap = 0 AND sleep_performance IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as SleepTrendRow[];
	}

	getWorkouts(days: number, minStrain?: number): DbWorkout[] {
		if (minStrain !== undefined) {
			return this.db.prepare(`
				SELECT * FROM workouts
				WHERE start_time >= DATE('now', '-' || ? || ' days')
					AND strain IS NOT NULL AND strain >= ?
				ORDER BY start_time DESC
			`).all(days, minStrain) as DbWorkout[];
		}
		return this.db.prepare(`
			SELECT * FROM workouts
			WHERE start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as DbWorkout[];
	}

	getAvgHrv(days: number): number | null {
		const row = this.db.prepare(`
			SELECT AVG(hrv_rmssd) as avg FROM recovery
			WHERE hrv_rmssd IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
		`).get(days) as { avg: number | null } | undefined;
		return row?.avg ?? null;
	}

	getAvgRhr(days: number): number | null {
		const row = this.db.prepare(`
			SELECT AVG(resting_hr) as avg FROM recovery
			WHERE resting_hr IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
		`).get(days) as { avg: number | null } | undefined;
		return row?.avg ?? null;
	}

	getDailyTrainingLoad(days: number): DailyLoadRow[] {
		return this.db.prepare(`
			SELECT
				DATE(c.start_time) as date,
				c.strain as day_strain,
				(SELECT COUNT(*) FROM workouts w
					WHERE DATE(w.start_time) = DATE(c.start_time) AND w.strain IS NOT NULL) as workout_count,
				(SELECT GROUP_CONCAT(DISTINCT COALESCE(sport_name, 'sport#' || sport_id))
					FROM workouts w WHERE DATE(w.start_time) = DATE(c.start_time)) as sports,
				(SELECT recovery_score FROM recovery r
					WHERE DATE(r.created_at) = DATE(c.start_time, '+1 day')
						AND r.recovery_score IS NOT NULL LIMIT 1) as next_recovery,
				(SELECT hrv_rmssd FROM recovery r
					WHERE DATE(r.created_at) = DATE(c.start_time, '+1 day')
						AND r.hrv_rmssd IS NOT NULL LIMIT 1) as next_hrv
			FROM cycles c
			WHERE c.strain IS NOT NULL
				AND c.start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY c.start_time DESC
		`).all(days) as DailyLoadRow[];
	}

	getSleepDebtTrend(days: number): SleepDebtRow[] {
		return this.db.prepare(`
			SELECT
				DATE(start_time) as date,
				(COALESCE(total_in_bed_milli, 0)
					- COALESCE(total_awake_milli, 0)
					- COALESCE(total_no_data_milli, 0)) as actual_sleep_ms,
				sleep_needed_baseline_milli as baseline_ms,
				sleep_needed_debt_milli as debt_ms,
				sleep_needed_strain_milli as strain_ms,
				sleep_needed_nap_milli as nap_ms,
				(COALESCE(sleep_needed_baseline_milli, 0)
					+ COALESCE(sleep_needed_debt_milli, 0)
					+ COALESCE(sleep_needed_strain_milli, 0)
					+ COALESCE(sleep_needed_nap_milli, 0)) as total_need_ms,
				sleep_performance as performance,
				disturbance_count as disturbances,
				sleep_cycle_count as cycles,
				((COALESCE(sleep_needed_baseline_milli, 0)
					+ COALESCE(sleep_needed_debt_milli, 0)
					+ COALESCE(sleep_needed_strain_milli, 0)
					+ COALESCE(sleep_needed_nap_milli, 0))
					- (COALESCE(total_in_bed_milli, 0)
						- COALESCE(total_awake_milli, 0)
						- COALESCE(total_no_data_milli, 0))) as shortfall_ms
			FROM sleep
			WHERE is_nap = 0
				AND sleep_needed_baseline_milli IS NOT NULL
				AND start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as SleepDebtRow[];
	}

	getStrainTrends(days: number): StrainTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time) as date, strain, ROUND(kilojoule / 4.184, 0) as calories
			FROM cycles
			WHERE strain IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as StrainTrendRow[];
	}

	upsertHealthkitSamples(samples: Array<{ metric: string; date: string; qty: number; units: string | null }>): number {
		const stmt = this.db.prepare(`
			INSERT OR IGNORE INTO healthkit_samples (metric, date, qty, units, received_at)
			VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);
		let inserted = 0;
		const tx = this.db.transaction((items: typeof samples) => {
			for (const s of items) {
				const res = stmt.run(s.metric, s.date, s.qty, s.units);
				inserted += res.changes;
			}
		});
		tx(samples);
		return inserted;
	}

	getHealthkitDailyTotals(days: number, metrics: string[]): Array<{ date: string; metric: string; total: number; count: number; units: string | null }> {
		if (metrics.length === 0) return [];
		const placeholders = metrics.map(() => '?').join(',');
		return this.db.prepare(`
			SELECT DATE(date) as date, metric, SUM(qty) as total, COUNT(*) as count, MAX(units) as units
			FROM healthkit_samples
			WHERE metric IN (${placeholders})
				AND DATE(date) >= DATE('now', '-' || ? || ' days')
			GROUP BY DATE(date), metric
			ORDER BY DATE(date) DESC, metric
		`).all(...metrics, days) as Array<{ date: string; metric: string; total: number; count: number; units: string | null }>;
	}

	getHealthkitDailyAvg(days: number, metrics: string[]): Array<{ date: string; metric: string; avg: number; count: number; units: string | null }> {
		if (metrics.length === 0) return [];
		const placeholders = metrics.map(() => '?').join(',');
		return this.db.prepare(`
			SELECT DATE(date) as date, metric, AVG(qty) as avg, COUNT(*) as count, MAX(units) as units
			FROM healthkit_samples
			WHERE metric IN (${placeholders})
				AND DATE(date) >= DATE('now', '-' || ? || ' days')
			GROUP BY DATE(date), metric
			ORDER BY DATE(date) DESC, metric
		`).all(...metrics, days) as Array<{ date: string; metric: string; avg: number; count: number; units: string | null }>;
	}

	getHealthkitDayTotal(metric: string, daysAgo: number): { total: number; units: string | null } | null {
		const row = this.db.prepare(`
			SELECT SUM(qty) as total, MAX(units) as units
			FROM healthkit_samples
			WHERE metric = ? AND DATE(date) = DATE('now', '-' || ? || ' days')
		`).get(metric, daysAgo) as { total: number | null; units: string | null } | undefined;
		if (!row || row.total === null) return null;
		return { total: row.total, units: row.units };
	}

	getHealthkitSamples(metric: string, days: number): Array<{ date: string; qty: number; units: string | null }> {
		return this.db.prepare(`
			SELECT date, qty, units FROM healthkit_samples
			WHERE metric = ? AND DATE(date) >= DATE('now', '-' || ? || ' days')
			ORDER BY date DESC
		`).all(metric, days) as Array<{ date: string; qty: number; units: string | null }>;
	}

	getEnergyBalance(days: number): Array<{ date: string; kcal_in: number | null; kcal_out: number | null; protein_g: number | null }> {
		return this.db.prepare(`
			WITH windowed AS (
				SELECT
					DATE(start_time) as date,
					datetime(start_time) as start_dt,
					COALESCE(datetime(end_time), datetime(start_time, '+24 hours')) as end_dt,
					ROUND(kilojoule / 4.184, 0) as kcal_out
				FROM cycles
				WHERE kilojoule IS NOT NULL
					AND start_time >= datetime('now', '-' || ? || ' days')
			)
			SELECT
				w.date,
				w.kcal_out,
				(SELECT SUM(CASE WHEN units = 'kJ' THEN qty / 4.184 ELSE qty END)
					FROM healthkit_samples
					WHERE metric = 'dietary_energy'
						AND datetime(date) >= w.start_dt
						AND datetime(date) < w.end_dt) as kcal_in,
				(SELECT SUM(qty) FROM healthkit_samples
					WHERE metric = 'protein'
						AND datetime(date) >= w.start_dt
						AND datetime(date) < w.end_dt) as protein_g
			FROM windowed w
			ORDER BY w.start_dt DESC
		`).all(days) as Array<{ date: string; kcal_in: number | null; kcal_out: number | null; protein_g: number | null }>;
	}

	close(): void {
		this.db.close();
	}
}
