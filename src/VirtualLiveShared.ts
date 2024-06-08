/**
 * Supported region strings.
 */
export type RegionString = "English" | "Japanese" | "Korean" | "Taiwanese";

const regionStringDict: { [region: string]: boolean } = {
    "English": true,
    "Japanese": true,
    "Korean": true,
    "Taiwanese": true
};

/**
 * Type guard for RegionStrings.
 * @param val A string.
 * @returns True if val is a RegionStrings.
 */
export function isOfTypeRegionString(val: string): val is RegionString {
    return regionStringDict[val] !== undefined;
}

/**
 * config.yaml
 */
export type SekaiVirtualLiveConfig = {
    refreshIntervalMinutes: number;
    mongoDbUrl: string;
    agenda: {
        maxConcurrency: number;
        defaultConcurrency: number;
    };
    vliveDataSources: {
        [region in RegionString]?: string;
    };
};

/**
 * A Virtual Live show.
 */
export interface VirtualLive {
    id: string;
    virtualLiveType: string;
    name: string;
    startAt: Date;
    endAt: Date;
    virtualLiveSchedules: VirtualLiveSchedule[];
    region: RegionString;
}

/**
 * A Virtual Live Schedule (the actual individual show times).
 */
export interface VirtualLiveSchedule {
    id: string;
    virtualLiveId: string;
    seq: number;
    startAt: Date;
    endAt: Date;
    region: RegionString;
}

export type GuildSettings = {
    guildId: string;
    isGuildActive: boolean;
    guildSettings: GuildSettingsSettings;
    vliveRoles: GuildVliveRoles[];
    userSettings: GuildUserSettings[];
};

export type GuildSettingsSettings = {
    regions: GuildRegionSettings[]
};

export type GuildRegionSettings = {
    region: RegionString,
    channelId: string,
    newShowsMessage: boolean
}

export type GuildVliveUser = {
    userId: string,
    hasRole: boolean
}

export type GuildVliveRoles = {
    region: string,
    vliveId: string,
    roleId: string
}

export type GuildUserSettings = {
    userId: string,
    autoReminders: UserAutoReminderSettings[]
};

export type UserAutoReminderSettings = {
    region: RegionString,
    enabled: boolean
}

export const NO_CHANNEL_STR = "NULL";
