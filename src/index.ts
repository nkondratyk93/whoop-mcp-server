import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
	min_strain?: number;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_workouts',
				description: 'Get individual workout sessions with sport, duration, strain, heart rate, calories, and per-zone time breakdown.',
				inputSchema: {
					type: 'object',
					properties: {
						days: { type: 'number', description: 'Number of days to look back (default: 14, max: 90)' },
						min_strain: { type: 'number', description: 'Only return workouts with strain >= this value' },
					},
					required: [],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_readiness_brief',
				description: 'Training-readiness verdict for today. Combines current recovery, 3-day HRV vs 30-day baseline, RHR drift, last night sleep debt, and yesterday strain into a green/yellow/red recommendation.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_training_load',
				description: 'Day-by-day training load joined with next-day recovery and HRV. Shows daily strain, workout count, sports, and how each day affected recovery.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_debt',
				description: 'Sleep debt analysis: per-night actual vs needed sleep (baseline + carried debt + strain-driven), shortfall, and summary of nights short of need.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_profile',
				description: 'Get the authenticated user profile and body measurements (height, weight, max heart rate) from Whoop.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = [
				'get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history',
				'get_workouts', 'get_readiness_brief', 'get_training_load', 'get_sleep_debt',
			];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch {
					// Continue with cached data
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0)
							- (sleep.total_awake_milli ?? 0)
							- (sleep.total_no_data_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.sleep_cycle_count !== null || sleep.disturbance_count !== null) {
							response += `- **Cycles / disturbances**: ${sleep.sleep_cycle_count ?? 'N/A'} / ${sleep.disturbance_count ?? 'N/A'}\n`;
						}
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_workouts': {
					const days = validateDays(typedArgs.days);
					const minStrain = typeof typedArgs.min_strain === 'number' ? typedArgs.min_strain : undefined;
					const workouts = db.getWorkouts(days, minStrain);

					if (workouts.length === 0) {
						const filterNote = minStrain !== undefined ? ` with strain >= ${minStrain}` : '';
						return { content: [{ type: 'text', text: `No workouts found in the last ${days} days${filterNote}.` }] };
					}

					let response = `# Workouts (Last ${days} Days)\n\n`;
					response += `Found ${workouts.length} session${workouts.length === 1 ? '' : 's'}`;
					if (minStrain !== undefined) response += ` with strain >= ${minStrain}`;
					response += '.\n\n';

					const fmtIso = (iso: string | null): string => {
						if (!iso) return 'N/A';
						return new Date(iso).toLocaleString('en-US', {
							weekday: 'short',
							year: 'numeric',
							month: 'short',
							day: 'numeric',
							hour: 'numeric',
							minute: '2-digit',
							hour12: false,
						});
					};
					const fmtMs = (ms: number | null): string => {
						if (ms === null) return 'N/A';
						const m = Math.floor(ms / 60_000);
						const s = Math.floor((ms % 60_000) / 1000);
						return `${m}m ${s}s`;
					};

					for (const w of workouts) {
						const sport = w.sport_name ?? `Sport #${w.sport_id}`;
						const durationMs = new Date(w.end_time).getTime() - new Date(w.start_time).getTime();

						response += `## ${sport.charAt(0).toUpperCase() + sport.slice(1)} — ${fmtIso(w.start_time)}\n`;
						response += `- **ID**: \`${w.id}\` (sport_id ${w.sport_id}`;
						if (w.v1_id !== null) response += `, v1_id ${w.v1_id}`;
						response += `)\n`;
						response += `- **Start → End**: ${fmtIso(w.start_time)} → ${fmtIso(w.end_time)}`;
						if (w.timezone_offset) response += ` (${w.timezone_offset})`;
						response += `\n`;
						response += `- **Duration**: ${formatDuration(durationMs)}\n`;
						response += `- **Score state**: ${w.score_state}`;
						if (w.percent_recorded !== null) response += ` · **% recorded**: ${(w.percent_recorded * 100).toFixed(1)}%`;
						response += `\n`;

						if (w.strain !== null) {
							response += `- **Strain**: ${w.strain.toFixed(2)} ${getStrainZone(w.strain)}\n`;
						}
						if (w.kilojoule !== null) {
							response += `- **Energy**: ${Math.round(w.kilojoule / 4.184)} kcal (${w.kilojoule.toFixed(1)} kJ)\n`;
						}
						if (w.avg_hr !== null || w.max_hr !== null) {
							response += `- **HR**: avg ${w.avg_hr ?? 'N/A'} · max ${w.max_hr ?? 'N/A'} bpm\n`;
						}
						if (w.distance_meter !== null) {
							const d = w.distance_meter >= 1000
								? `${(w.distance_meter / 1000).toFixed(2)} km`
								: `${w.distance_meter.toFixed(0)} m`;
							response += `- **Distance**: ${d}\n`;
						}
						if (w.altitude_gain_meter !== null || w.altitude_change_meter !== null) {
							const parts: string[] = [];
							if (w.altitude_gain_meter !== null) parts.push(`gain ${w.altitude_gain_meter.toFixed(1)} m`);
							if (w.altitude_change_meter !== null) parts.push(`net ${w.altitude_change_meter >= 0 ? '+' : ''}${w.altitude_change_meter.toFixed(1)} m`);
							response += `- **Elevation**: ${parts.join(' · ')}\n`;
						}

						const zones: Array<[string, number | null]> = [
							['Z0', w.zone_zero_milli],
							['Z1', w.zone_one_milli],
							['Z2', w.zone_two_milli],
							['Z3', w.zone_three_milli],
							['Z4', w.zone_four_milli],
							['Z5', w.zone_five_milli],
						];
						const totalZoneMs = zones.reduce<number>((sum, [, z]) => sum + (z ?? 0), 0);
						if (totalZoneMs > 0) {
							const parts = zones.map(([label, ms]) => {
								const pct = Math.round(((ms ?? 0) / totalZoneMs) * 100);
								return `${label} ${pct}% (${fmtMs(ms)})`;
							});
							response += `- **HR zones**: ${parts.join(' · ')}\n`;
						} else {
							response += `- **HR zones**: not reported\n`;
						}

						if (w.created_at || w.updated_at) {
							response += `- **Record**: created ${fmtIso(w.created_at)} · updated ${fmtIso(w.updated_at)}\n`;
						}

						response += '\n';
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				case 'get_readiness_brief': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();
					const avgHrv3 = db.getAvgHrv(3);
					const avgHrv30 = db.getAvgHrv(30);
					const avgRhr30 = db.getAvgRhr(30);

					if (!recovery) {
						return { content: [{ type: 'text', text: 'No recovery data available yet. Run sync_data first.' }] };
					}

					const hrvDeviation = avgHrv3 !== null && avgHrv30 !== null && avgHrv30 > 0
						? ((avgHrv3 - avgHrv30) / avgHrv30) * 100
						: null;
					const rhrDeviation = recovery.resting_hr !== null && avgRhr30 !== null
						? recovery.resting_hr - avgRhr30
						: null;

					const totalNeed = (sleep?.sleep_needed_baseline_milli ?? 0)
						+ (sleep?.sleep_needed_debt_milli ?? 0)
						+ (sleep?.sleep_needed_strain_milli ?? 0)
						+ (sleep?.sleep_needed_nap_milli ?? 0);
					const actualSleep = (sleep?.total_in_bed_milli ?? 0)
						- (sleep?.total_awake_milli ?? 0)
						- (sleep?.total_no_data_milli ?? 0);
					const sleepShortfall = totalNeed - actualSleep;

					let verdict = 'GREEN — push hard';
					const reasons: string[] = [];

					if (recovery.user_calibrating === 1) {
						reasons.push('Whoop is still calibrating your baseline — recovery score and HRV signals may be unreliable');
					}

					const rec = recovery.recovery_score;
					if (rec !== null && rec < 34) {
						verdict = 'RED — deload / rest';
						reasons.push(`recovery ${rec}% in red zone`);
					} else if (rec !== null && rec < 67) {
						verdict = 'YELLOW — moderate intensity';
						reasons.push(`recovery ${rec}% in yellow zone`);
					}

					if (hrvDeviation !== null) {
						if (hrvDeviation < -15) {
							verdict = 'RED — HRV significantly below baseline';
							reasons.push(`3-day HRV ${hrvDeviation.toFixed(1)}% below 30-day baseline`);
						} else if (hrvDeviation < -8) {
							if (verdict.startsWith('GREEN')) verdict = 'YELLOW — HRV trending down';
							reasons.push(`3-day HRV ${hrvDeviation.toFixed(1)}% below 30-day baseline`);
						}
					}

					if (rhrDeviation !== null && rhrDeviation > 5) {
						if (verdict.startsWith('GREEN')) verdict = 'YELLOW — elevated RHR';
						reasons.push(`RHR ${rhrDeviation > 0 ? '+' : ''}${rhrDeviation.toFixed(0)} bpm vs 30-day avg`);
					}

					if (sleepShortfall > 7_200_000) {
						if (verdict.startsWith('GREEN')) verdict = 'YELLOW — significant sleep debt';
						reasons.push(`sleep ${formatDuration(sleepShortfall)} short of need`);
					} else if (sleepShortfall > 3_600_000) {
						reasons.push(`sleep ${formatDuration(sleepShortfall)} short of need`);
					}

					if (reasons.length === 0) reasons.push('all metrics in healthy range');

					let response = `# Training Readiness\n\n`;
					response += `## Verdict: ${verdict}\n\n`;
					response += `### Why\n${reasons.map(r => `- ${r}`).join('\n')}\n\n`;
					response += `### Metrics\n`;
					response += `- **Recovery**: ${rec ?? 'N/A'}% ${rec !== null ? getRecoveryZone(rec) : ''}\n`;
					response += `- **HRV**: today ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms · 3-day avg ${avgHrv3?.toFixed(1) ?? 'N/A'} ms · 30-day baseline ${avgHrv30?.toFixed(1) ?? 'N/A'} ms`;
					if (hrvDeviation !== null) response += ` (${hrvDeviation > 0 ? '+' : ''}${hrvDeviation.toFixed(1)}%)`;
					response += '\n';
					response += `- **RHR**: today ${recovery.resting_hr ?? 'N/A'} bpm · 30-day avg ${avgRhr30?.toFixed(0) ?? 'N/A'} bpm`;
					if (rhrDeviation !== null) response += ` (${rhrDeviation > 0 ? '+' : ''}${rhrDeviation.toFixed(0)})`;
					response += '\n';
					if (sleep && totalNeed > 0) {
						response += `- **Last sleep**: ${formatDuration(actualSleep)} actual · need ${formatDuration(totalNeed)}`;
						response += sleepShortfall > 0 ? ` · ${formatDuration(sleepShortfall)} short\n` : ` · met\n`;
					}
					if (cycle?.strain !== null && cycle?.strain !== undefined) {
						response += `- **Yesterday's strain**: ${cycle.strain.toFixed(1)} ${getStrainZone(cycle.strain)}\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_training_load': {
					const days = validateDays(typedArgs.days);
					const rows = db.getDailyTrainingLoad(days);

					if (rows.length === 0) {
						return { content: [{ type: 'text', text: `No training data available for the last ${days} days.` }] };
					}

					let response = `# Training Load (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Workouts | Sports | Next-day Recovery | Next-day HRV |\n';
					response += '|------|--------|----------|--------|-------------------|--------------|\n';

					let totalStrain = 0;
					let highStrainDays = 0;

					for (const r of rows) {
						const strain = r.day_strain ?? 0;
						totalStrain += strain;
						if (strain >= 14) highStrainDays++;
						let sports: string;
						if (r.workout_count > 0) sports = r.sports ?? '—';
						else if (strain < 5) sports = 'rest';
						else sports = 'untagged activity';
						const nextRec = r.next_recovery !== null ? `${r.next_recovery}%` : 'N/A';
						const nextHrv = r.next_hrv !== null ? `${r.next_hrv.toFixed(1)} ms` : 'N/A';
						response += `| ${formatDate(r.date)} | ${strain.toFixed(1)} | ${r.workout_count} | ${sports} | ${nextRec} | ${nextHrv} |\n`;
					}

					const avgStrain = totalStrain / rows.length;
					const withRec = rows.filter(r => r.next_recovery !== null);
					const avgRec = withRec.length > 0
						? withRec.reduce((s, r) => s + (r.next_recovery ?? 0), 0) / withRec.length
						: null;
					const highRows = rows.filter(r => (r.day_strain ?? 0) >= 14 && r.next_recovery !== null);
					const lowRows = rows.filter(r => (r.day_strain ?? 0) < 10 && r.next_recovery !== null);
					const avgRecAfterHigh = highRows.length > 0
						? highRows.reduce((s, r) => s + (r.next_recovery ?? 0), 0) / highRows.length
						: null;
					const avgRecAfterLow = lowRows.length > 0
						? lowRows.reduce((s, r) => s + (r.next_recovery ?? 0), 0) / lowRows.length
						: null;

					response += `\n### Summary\n`;
					response += `- **Avg daily strain**: ${avgStrain.toFixed(1)}\n`;
					response += `- **High-strain days (≥14)**: ${highStrainDays} / ${rows.length}\n`;
					if (avgRec !== null) response += `- **Avg next-day recovery**: ${avgRec.toFixed(0)}%\n`;
					if (avgRecAfterHigh !== null) {
						response += `- **Recovery after high strain (≥14)**: ${avgRecAfterHigh.toFixed(0)}% (n=${highRows.length})\n`;
					}
					if (avgRecAfterLow !== null) {
						response += `- **Recovery after low strain (<10)**: ${avgRecAfterLow.toFixed(0)}% (n=${lowRows.length})\n`;
					}
					if (avgRecAfterHigh !== null && avgRecAfterLow !== null) {
						const delta = avgRecAfterHigh - avgRecAfterLow;
						response += `- **Delta**: ${delta > 0 ? '+' : ''}${delta.toFixed(0)} pp (high-strain vs low-strain recovery)\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_debt': {
					const days = validateDays(typedArgs.days);
					const rows = db.getSleepDebtTrend(days);

					if (rows.length === 0) {
						return { content: [{ type: 'text', text: `No sleep need data for the last ${days} days.` }] };
					}

					let response = `# Sleep Debt (Last ${days} Days)\n\n`;
					response += '| Date | Actual | Baseline | + Debt | + Strain | − Nap | Need | Short by | Cyc | Dist |\n';
					response += '|------|--------|----------|--------|----------|-------|------|----------|-----|------|\n';

					let totalShortfall = 0;
					let nightsShort = 0;
					const fmtNap = (ms: number | null): string => {
						if (ms === null || ms === 0) return '—';
						const abs = Math.abs(ms);
						const sign = ms < 0 ? '-' : '+';
						return `${sign}${formatDuration(abs)}`;
					};

					for (const r of rows) {
						const short = r.shortfall_ms > 0;
						if (short) {
							totalShortfall += r.shortfall_ms;
							nightsShort++;
						}
						response += `| ${formatDate(r.date)} `
							+ `| ${formatDuration(r.actual_sleep_ms)} `
							+ `| ${formatDuration(r.baseline_ms)} `
							+ `| ${formatDuration(r.debt_ms)} `
							+ `| ${formatDuration(r.strain_ms)} `
							+ `| ${fmtNap(r.nap_ms)} `
							+ `| ${formatDuration(r.total_need_ms)} `
							+ `| ${short ? formatDuration(r.shortfall_ms) : 'met'} `
							+ `| ${r.cycles ?? 'N/A'} `
							+ `| ${r.disturbances ?? 'N/A'} |\n`;
					}

					const avgShortfall = nightsShort > 0 ? totalShortfall / nightsShort : 0;
					const totalDebt = rows.reduce((s, r) => s + (r.debt_ms ?? 0), 0);
					const totalStrain = rows.reduce((s, r) => s + (r.strain_ms ?? 0), 0);
					const totalNap = rows.reduce((s, r) => s + (r.nap_ms ?? 0), 0);
					const withDist = rows.filter(r => r.disturbances !== null);
					const avgDist = withDist.length > 0
						? withDist.reduce((s, r) => s + (r.disturbances ?? 0), 0) / withDist.length
						: null;

					response += `\n### Summary\n`;
					response += `- **Nights short of need**: ${nightsShort} / ${rows.length}\n`;
					if (nightsShort > 0) {
						response += `- **Avg shortfall on short nights**: ${formatDuration(avgShortfall)}\n`;
					}
					response += `- **Total extra need from carried debt**: ${formatDuration(totalDebt)}\n`;
					response += `- **Total extra need from strain**: ${formatDuration(totalStrain)}\n`;
					if (totalNap !== 0) {
						response += `- **Total nap adjustment** (reduces need): ${formatDuration(Math.abs(totalNap))}\n`;
					}
					if (avgDist !== null) {
						response += `- **Avg disturbances / night**: ${avgDist.toFixed(1)}\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_profile': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const [profile, body] = await Promise.all([
						client.getProfile().catch(() => null),
						client.getBodyMeasurement().catch(() => null),
					]);

					if (!profile && !body) {
						return { content: [{ type: 'text', text: 'Could not fetch profile or body measurements from Whoop.' }], isError: true };
					}

					let response = '# Profile\n\n';
					if (profile) {
						response += `- **Name**: ${profile.first_name} ${profile.last_name}\n`;
						response += `- **Email**: ${profile.email}\n`;
						response += `- **User ID**: ${profile.user_id}\n`;
					}
					if (body) {
						response += `\n## Body Measurements\n`;
						response += `- **Height**: ${body.height_meter.toFixed(2)} m (${(body.height_meter * 3.28084).toFixed(2)} ft)\n`;
						response += `- **Weight**: ${body.weight_kilogram.toFixed(1)} kg (${(body.weight_kilogram * 2.20462).toFixed(1)} lb)\n`;
						response += `- **Max HR**: ${body.max_heart_rate} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use(express.json());

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
				}

				await transport.handleRequest(req, res, req.body);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
