import type { DiscordMessage, DiscordUser } from "./types";

/** Discord Gateway op codes actually used by this bot. */
export const GatewayOpcode = {
	Dispatch: 0,
	Heartbeat: 1,
	Identify: 2,
	Resume: 6,
	Reconnect: 7,
	InvalidSession: 9,
	Hello: 10,
	HeartbeatAck: 11,
} as const;

export type GatewayOpcode = (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

export interface GatewayPayload {
	/** Deliberately `number`, not `GatewayOpcode`: Discord sends op codes this bot doesn't model. */
	op: number;
	d: unknown;
	s: number | null;
	t: string | null;
}

export interface HelloData {
	heartbeat_interval: number;
}

export interface IdentifyData {
	token: string;
	intents: number;
	properties: {
		os: string;
		browser: string;
		device: string;
	};
}

export interface ResumeData {
	token: string;
	session_id: string;
	seq: number;
}

export interface ReadyDispatchData {
	session_id: string;
	resume_gateway_url: string;
	user: DiscordUser;
}

export interface MessageCreateDispatchData extends DiscordMessage {
	channel_id: string;
	mentions: Array<{ id: string }>;
	/** Present for guild messages; absent for DMs. */
	guild_id?: string;
}
