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

export interface GatewayPayload<T = unknown> {
	op: number;
	d: T;
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
	user: {
		id: string;
		username: string;
	};
}

export interface MessageCreateDispatchData {
	id: string;
	channel_id: string;
	content: string;
	timestamp: string;
	author: {
		id: string;
		username: string;
		bot?: boolean;
	};
	mentions: Array<{ id: string }>;
	/** Present for guild messages; absent for DMs. */
	guild_id?: string;
	/** Present when this message is a Discord reply to another message. */
	message_reference?: { message_id?: string };
}
